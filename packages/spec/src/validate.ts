/**
 * WorkflowSpec parsing: meta-schema validation first, then semantic rules that a
 * JSON Schema cannot express (identity, asset keys, prompt placeholders,
 * forbidden path segments, fixed operation contracts).
 *
 * Flow/type analysis (symbol tables, branch termination, agent budget) belongs
 * to the compiler; this module only rejects definitions that are malformed on
 * their own.
 */
import type { ErrorObject } from "ajv";
import type { SpecLimits, ValueExpr, WorkflowSpec, JsonValue } from "./types.js";
import { RESULT_VALUE_KEYS } from "./types.js";
import { DIAGNOSTIC_CODES, diagnostic, hasErrors, type Diagnostic } from "./diagnostics.js";
import { errorsOf, specValidator } from "./ajv.js";
import { getContract } from "./contracts.js";
import { isValueRef, walkRefs } from "./refs.js";
import { hashCanonical } from "./canonical.js";

export type ParseSpecResult =
  | { ok: true; spec: WorkflowSpec; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

type AnyStep = WorkflowSpec["steps"][number];

function nodeIdAt(raw: unknown, path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  let cursor: unknown = raw;
  let lastId: string | undefined;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object") break;
    if (Array.isArray(cursor)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) break;
      cursor = cursor[index];
    } else {
      const record = cursor as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, part)) break;
      cursor = record[part];
    }
    if (cursor !== null && typeof cursor === "object" && !Array.isArray(cursor)) {
      const id = (cursor as Record<string, unknown>)["id"];
      if (typeof id === "string") lastId = id;
    }
  }
  return lastId;
}

function toDiagnostic(raw: unknown, error: ErrorObject): Diagnostic {
  const fieldPath = error.instancePath.replace(/^\//, "");
  const code =
    error.keyword === "additionalProperties" || error.keyword === "unevaluatedProperties"
      ? DIAGNOSTIC_CODES.UNKNOWN_FIELD
      : DIAGNOSTIC_CODES.SPEC_INVALID;
  const extra =
    error.keyword === "additionalProperties" && "additionalProperty" in error.params
      ? String((error.params as Record<string, JsonValue>)["additionalProperty"])
      : "";
  const message =
    error.keyword === "additionalProperties"
      ? `unknown field "${extra}" is not part of WorkflowSpec 0.1`
      : (error.message ?? "invalid value");
  return diagnostic({
    code,
    fieldPath: extra ? `${fieldPath}/${extra}`.replace(/^\//, "") : fieldPath,
    nodeId: nodeIdAt(raw, fieldPath),
    message,
    fix:
      error.keyword === "additionalProperties"
        ? "remove the field or use a supported WorkflowSpec 0.1 field"
        : "compare with docs/workflow-spec.md",
  });
}

export function parseSpec(raw: unknown): ParseSpecResult {
  const validate = specValidator();
  const valid = validate(raw);
  if (!valid) {
    return { ok: false, diagnostics: errorsOf(validate).map((error) => toDiagnostic(raw, error)) };
  }
  const spec = raw as WorkflowSpec;
  const diagnostics = semanticDiagnostics(spec);
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };
  return { ok: true, spec, diagnostics };
}

export function semanticDiagnostics(spec: WorkflowSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  checkContracts(spec, diagnostics);
  checkLimits(spec.limits, diagnostics);
  checkNodeTree(spec.steps, diagnostics);
  checkAssets(spec, diagnostics);
  checkRefs(spec, diagnostics);
  return diagnostics;
}

function checkContracts(spec: WorkflowSpec, out: Diagnostic[]): void {
  const input = getContract(spec.inputContract);
  const normalized = getContract(spec.normalizedInputContract);
  const output = getContract(spec.outputContract);
  const pairs: Array<[string, string | undefined, string]> = [
    ["inputContract", input?.kind, "input"],
    ["normalizedInputContract", normalized?.kind, "normalized"],
    ["outputContract", output?.kind, "output"],
  ];
  for (const [field, kind, expected] of pairs) {
    if (!kind) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.UNKNOWN_CONTRACT,
          fieldPath: field,
          message: `unknown contract; v0.1 ships only the built-in source-brief contracts`,
          fix: `use the built-in ${expected} contract id`,
        }),
      );
    } else if (kind !== expected) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.UNKNOWN_CONTRACT,
          fieldPath: field,
          message: `contract is a ${kind} contract but a ${expected} contract is required here`,
          fix: `use the built-in ${expected} contract id`,
        }),
      );
    }
  }
}

function checkLimits(limits: SpecLimits, out: Diagnostic[]): void {
  if (limits.mapConcurrency > 2) {
    out.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.LIMIT_OUT_OF_PRODUCT_BOUNDS,
        fieldPath: "limits/mapConcurrency",
        message: "mapConcurrency may not exceed 2 in v0.1",
        fix: "set limits.mapConcurrency to 1 or 2",
      }),
    );
  }
  if (limits.maxDirectAgents > 5) {
    out.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.LIMIT_OUT_OF_PRODUCT_BOUNDS,
        fieldPath: "limits/maxDirectAgents",
        message: "maxDirectAgents may not exceed 5 in v0.1",
        fix: "reduce the number of agent steps or lower maxDirectAgents",
      }),
    );
  }
}

function checkNodeTree(steps: AnyStep[], out: Diagnostic[]): void {
  const ids = new Map<string, number>();
  const visit = (list: AnyStep[], path: string): void => {
    for (const [index, step] of list.entries()) {
      const at = `${path}/${index}`;
      if (!NODE_ID_PATTERN.test(step.id)) {
        out.push(
          diagnostic({
            code: DIAGNOSTIC_CODES.INVALID_NODE_ID,
            nodeId: step.id,
            fieldPath: `${at}/id`,
            message: "node id must be an identifier-like string (letters, digits, _ and -)",
            fix: "rename the node, e.g. \"extract\" or \"gate_1\"",
          }),
        );
      }
      if (ids.has(step.id)) {
        out.push(
          diagnostic({
            code: DIAGNOSTIC_CODES.DUPLICATE_NODE_ID,
            nodeId: step.id,
            fieldPath: `${at}/id`,
            message: `node id "${step.id}" is used more than once`,
            fix: "give every node a globally unique id",
          }),
        );
      } else {
        ids.set(step.id, index);
      }
      if (step.kind === "branch") {
        checkConditionBound(step.condition, `${at}/condition`, out);
        visit(step.then, `${at}/then`);
        visit(step.else, `${at}/else`);
      }
    }
  };
  visit(steps, "steps");
}

function checkConditionBound(condition: JsonValue | object, path: string, out: Diagnostic[]): void {
  const node = condition as { op?: string; conditions?: unknown[] };
  if ((node.op === "any" || node.op === "all") && Array.isArray(node.conditions)) {
    if (node.conditions.length > 8) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.UNBOUNDED_CONDITION,
          fieldPath: path,
          message: "any/all may combine at most 8 conditions in v0.1",
          fix: "split the condition into ordered assert steps",
        }),
      );
    }
    node.conditions.forEach((child, index) => checkConditionBound(child as object, `${path}/conditions/${index}`, out));
  }
}

function checkAssets(spec: WorkflowSpec, out: Diagnostic[]): void {
  const prompts = spec.assets.prompts;
  const schemas = spec.assets.schemas;
  const KEY = /^[A-Za-z0-9_-]{1,64}$/;
  for (const key of Object.keys(prompts)) {
    if (!KEY.test(key)) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.INVALID_ASSET_KEY,
          fieldPath: `assets/prompts/${key}`,
          message: "asset keys become package file names; use letters, digits, _ and - only",
          fix: "rename the prompt key, e.g. \"extract\"",
        }),
      );
    }
    if (typeof prompts[key] !== "string" || prompts[key]!.trim().length === 0) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.EMPTY_ASSET,
          fieldPath: `assets/prompts/${key}`,
          message: "prompt text must not be empty",
        }),
      );
    }
  }
  for (const key of Object.keys(schemas)) {
    if (!KEY.test(key)) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.INVALID_ASSET_KEY,
          fieldPath: `assets/schemas/${key}`,
          message: "asset keys become package file names; use letters, digits, _ and - only",
          fix: "rename the schema key, e.g. \"Brief\"",
        }),
      );
    }
    const schema = schemas[key];
    if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.EMPTY_ASSET,
          fieldPath: `assets/schemas/${key}`,
          message: "schema must be a non-empty object",
        }),
      );
    }
  }

  const visit = (list: AnyStep[]): void => {
    for (const step of list) {
      if (step.kind === "agent" || step.kind === "agent_map") {
        const task = step.kind === "agent" ? step : step.task;
        const nodeId = step.kind === "agent" ? step.id : step.id;
        checkTaskAssets(nodeId, task, prompts, schemas, out);
      }
      if (step.kind === "transform") checkTransformBindings(step, out);
      if (step.kind === "assert") checkAssertBindings(step, out);
      if (step.kind === "result") {
        for (const key of Object.keys(step.value ?? {})) {
          if (!(RESULT_VALUE_KEYS as readonly string[]).includes(key)) {
            out.push(
              diagnostic({
                code: DIAGNOSTIC_CODES.RESULT_VALUE_UNSUPPORTED,
                nodeId: step.id,
                fieldPath: `steps/${step.id}/value/${key}`,
                message: `result value key "${key}" is not part of ScenarioResult`,
                fix: `use one of ${RESULT_VALUE_KEYS.join(", ")}`,
              }),
            );
          }
        }
      }
      if (step.kind === "branch") {
        visit(step.then);
        visit(step.else);
      }
    }
  };
  visit(spec.steps);
}

function checkTaskAssets(
  nodeId: string,
  task: { prompt: string; outputSchema: string; bindings?: Record<string, ValueExpr> },
  prompts: Record<string, string>,
  schemas: Record<string, JsonValue>,
  out: Diagnostic[],
): void {
  const promptText = prompts[task.prompt];
  if (typeof promptText !== "string") {
    out.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.UNKNOWN_ASSET_KEY,
        nodeId,
        fieldPath: `assets/prompts/${task.prompt}`,
        message: `prompt asset "${task.prompt}" is not defined in assets.prompts`,
        fix: "add the prompt text under assets.prompts or reference an existing key",
      }),
    );
  }
  if (!schemas[task.outputSchema]) {
    out.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.UNKNOWN_ASSET_KEY,
        nodeId,
        fieldPath: `assets/schemas/${task.outputSchema}`,
        message: `schema asset "${task.outputSchema}" is not defined in assets.schemas`,
        fix: "add the schema under assets.schemas or reference an existing key",
      }),
    );
  }
  if (typeof promptText !== "string") return;

  const used = new Set<string>();
  PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER.exec(promptText)) !== null) {
    const key = match[1]!;
    used.add(key);
    if (!task.bindings || !Object.prototype.hasOwnProperty.call(task.bindings, key)) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.PROMPT_BINDING_MISSING,
          nodeId,
          fieldPath: `steps/${nodeId}/bindings/${key}`,
          message: `prompt "${task.prompt}" contains {{${key}}} but the node has no such binding`,
          fix: `bind "${key}" to a value expression`,
        }),
      );
    }
  }
  for (const key of Object.keys(task.bindings ?? {})) {
    if (!used.has(key)) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.PROMPT_BINDING_UNUSED,
          severity: "warning",
          nodeId,
          fieldPath: `steps/${nodeId}/bindings/${key}`,
          message: `binding "${key}" is not used by prompt "${task.prompt}"`,
          fix: "remove the binding or add the placeholder to the prompt",
        }),
      );
    }
  }
}

function checkTransformBindings(step: Extract<AnyStep, { kind: "transform" }>, out: Diagnostic[]): void {
  const required: Record<string, string[]> = {
    collect_evidence: ["materials", "results"],
    select_fields: ["source"],
    stable_sort: ["items"],
  };
  const expected = required[step.op];
  if (!expected) {
    out.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.UNKNOWN_TRANSFORM_OP,
        nodeId: step.id,
        fieldPath: `steps/${step.id}/op`,
        message: `transform op "${step.op}" is not implemented in v0.1`,
        fix: `use one of ${Object.keys(required).join(", ")}`,
      }),
    );
    return;
  }
  for (const name of expected) {
    if (!Object.prototype.hasOwnProperty.call(step.bindings, name)) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.TRANSFORM_BINDING_MISSING,
          nodeId: step.id,
          fieldPath: `steps/${step.id}/bindings/${name}`,
          message: `transform "${step.op}" requires binding "${name}"`,
          fix: `bind "${name}" to a value expression`,
        }),
      );
    }
  }
  if ((step.op === "select_fields" || step.op === "stable_sort") && !step.fields?.length) {
    out.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.TRANSFORM_BINDING_MISSING,
        nodeId: step.id,
        fieldPath: `steps/${step.id}/fields`,
        message: `transform "${step.op}" requires the fields list`,
        fix: "add the field names to project or sort by",
      }),
    );
  }
}

const ASSERT_BINDINGS: Record<string, string[]> = {
  input_limits: [],
  evidence_ids_exist: ["brief", "evidence"],
  required_dimensions: ["brief", "dimensions"],
  non_empty_brief: ["brief"],
  result_size: ["brief"],
};

function checkAssertBindings(step: Extract<AnyStep, { kind: "assert" }>, out: Diagnostic[]): void {
  for (const rule of step.rules) {
    const required = ASSERT_BINDINGS[rule] ?? [];
    for (const name of required) {
      if (!step.bindings || !Object.prototype.hasOwnProperty.call(step.bindings, name)) {
        out.push(
          diagnostic({
            code: DIAGNOSTIC_CODES.ASSERT_BINDING_MISSING,
            nodeId: step.id,
            fieldPath: `steps/${step.id}/bindings/${name}`,
            message: `assert rule "${rule}" requires binding "${name}"`,
            fix: `bind "${name}" to a value expression`,
          }),
        );
      }
    }
  }
}

function checkRefs(spec: WorkflowSpec, out: Diagnostic[]): void {
  walkRefs(spec.steps, (ref, path) => {
    for (const segment of ref.path) {
      if (typeof segment === "string" && (segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
        out.push(
          diagnostic({
            code: DIAGNOSTIC_CODES.FORBIDDEN_PATH_SEGMENT,
            fieldPath: `${path}/path`,
            message: `path segment "${segment}" is not allowed in a reference`,
            fix: "reference a data field, not a language or prototype member",
          }),
        );
      }
      if (typeof segment === "number" && (!Number.isInteger(segment) || segment < 0)) {
        out.push(
          diagnostic({
            code: DIAGNOSTIC_CODES.INVALID_REF_PATH,
            fieldPath: `${path}/path`,
            message: "array index must be a non-negative integer",
          }),
        );
      }
    }
    if (ref.scope !== "node" && ref.node !== undefined) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.REF_NODE_NOT_ALLOWED,
          fieldPath: `${path}/node`,
          message: `scope "${ref.scope}" may not carry a node id`,
          fix: "remove \"node\" or use scope \"node\"",
        }),
      );
    }
    if (ref.scope === "node" && (typeof ref.node !== "string" || ref.node.length === 0)) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.INVALID_REF_PATH,
          fieldPath: `${path}/node`,
          message: "scope \"node\" requires the node id",
          fix: "set \"node\" to the id of an already-completed node",
        }),
      );
    }
  });
}

/** Express a value expression's literal, or undefined when it is a ref. */
export function literalOf(expr: ValueExpr): JsonValue | undefined {
  return isValueRef(expr) ? undefined : expr.literal;
}

export function specHash(spec: WorkflowSpec): string {
  return hashCanonical(JSON.parse(JSON.stringify(spec)) as JsonValue);
}

/**
 * draftHash binds the normalized definition to the implementation and adapter
 * snapshot. Trials and packages reuse bytes only when this identity matches.
 */
export function draftIdentity(input: {
  specHash: string;
  compilerVersion: string;
  runtimeArtifactHash: string;
  checksHash: string;
  targetAdapterVersion: string;
}): string {
  return hashCanonical({
    specHash: input.specHash,
    compilerVersion: input.compilerVersion,
    runtimeArtifactHash: input.runtimeArtifactHash,
    checksHash: input.checksHash,
    targetAdapterVersion: input.targetAdapterVersion,
  });
}
