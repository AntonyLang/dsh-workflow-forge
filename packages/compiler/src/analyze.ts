/**
 * Static analysis (compiler steps 3-5).
 *
 * Builds the typed IR: expands explicit defaults, resolves every reference
 * against a block-scoped symbol table, checks field types, enforces branch
 * termination and every-path results, then computes the worst-case direct agent
 * count on any path.
 */
import {
  DIAGNOSTIC_CODES,
  diagnostic,
  getContract,
  hasErrors,
  type AssertRuleName,
  type ConditionExpr,
  type Diagnostic,
  type JsonSchema,
  type JsonValue,
  type ResultStatus,
  type Step,
  type ValueExpr,
  type WorkflowSpec,
} from "@workflow-forge/spec";
import {
  ASSERT_RESULT_TYPE,
  EVIDENCE_SET_TYPE,
  accessProperty,
  describeType,
  fieldTypeFromSchema,
  isArrayLike,
  isNumberType,
  type FieldType,
} from "./field-types.js";
import { toNativeAgentSchema } from "./schema-map.js";
import type { CompiledWorkflow, IrCondition, IrExpr, IrStep, IrTask } from "./ir.js";

const MATERIAL_RESULT_TYPE: FieldType = {
  kind: "object",
  open: false,
  properties: {
    materialId: { required: true, type: { kind: "string" } },
    index: { required: true, type: { kind: "number" } },
    ok: { required: true, type: { kind: "boolean" } },
    value: { required: false, type: { kind: "unknown" } },
    error: { required: false, type: { kind: "unknown" } },
  },
};

const ROOT_BLOCK = "steps";

type Location = {
  id: string;
  blockPath: string;
  index: number;
  varName: string;
};

type Env = {
  blockPath: string;
  visible: Map<string, { type: FieldType; varName: string }>;
  item?: { type: FieldType; code: string };
};

export type AnalyzeResult =
  | { ok: true; workflow: CompiledWorkflow; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

export type AnalyzeOptions = {
  /** Called for every resolved agent task so the compiler can materialize assets. */
  onTask?: (nodeId: string, task: IrTask) => void;
};

class Analyzer {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly locations = new Map<string, Location>();
  private readonly nativeSchemas = new Map<string, FieldType>();
  private varCounter = 0;
  private readonly prompts: Record<string, string>;
  private readonly schemas: Record<string, JsonSchema>;
  private readonly inputType: FieldType;
  private readonly phases = new Set<string>();

  constructor(private readonly spec: WorkflowSpec) {
    this.prompts = spec.assets.prompts;
    this.schemas = spec.assets.schemas;
    const contract = getContract(spec.normalizedInputContract);
    this.inputType = contract ? contractType(contract.schema) : { kind: "unknown" };
  }

  run(): AnalyzeResult {
    this.validateSchemaAssets();
    this.collectLocations(this.spec.steps, ROOT_BLOCK);
    const steps = this.resolveBlock(this.spec.steps, { blockPath: ROOT_BLOCK, visible: new Map() });

    if (steps.length === 0) {
      this.error(DIAGNOSTIC_CODES.MISSING_RESULT, ROOT_BLOCK, "workflow has no steps");
    } else if (!terminates(steps)) {
      this.error(
        DIAGNOSTIC_CODES.MISSING_RESULT,
        ROOT_BLOCK,
        "every execution path must end in a result node",
        undefined,
        "append a result step (or a trailing branch whose arms both end in result)",
      );
    }

    const worstCaseAgents = maxAgents(steps);
    if (worstCaseAgents > this.spec.limits.maxDirectAgents) {
      this.error(
        DIAGNOSTIC_CODES.AGENT_BUDGET_EXCEEDED,
        ROOT_BLOCK,
        `worst-case path starts ${worstCaseAgents} direct agents; limits.maxDirectAgents is ${this.spec.limits.maxDirectAgents}`,
        undefined,
        "reduce the material limit, merge agent steps, or raise the declared limit within the product cap of 5",
      );
    }

    if (hasErrors(this.diagnostics)) return { ok: false, diagnostics: this.diagnostics };

    return {
      ok: true,
      workflow: {
        spec: this.spec,
        steps,
        worstCaseAgents,
        phases: [...this.phases],
        defaultsApplied: this.defaults(),
      },
      diagnostics: this.diagnostics,
    };
  }

  private defaults(): string[] {
    const applied: string[] = [];
    const visit = (steps: Step[]): void => {
      for (const step of steps) {
        if (step.kind === "agent_map") {
          if (step.failurePolicy === undefined) applied.push(`steps/${step.id}/failurePolicy=collect`);
        }
        if (step.kind === "branch") {
          visit(step.then);
          visit(step.else);
        }
      }
    };
    visit(this.spec.steps);
    return applied;
  }

  private validateSchemaAssets(): void {
    for (const [key, schema] of Object.entries(this.schemas)) {
      const result = toNativeAgentSchema(schema, key);
      if (!result.ok) {
        this.diagnostics.push(...result.diagnostics);
      } else {
        this.nativeSchemas.set(key, result.type);
      }
    }
  }

  private collectLocations(steps: Step[], blockPath: string): void {
    for (const [index, step] of steps.entries()) {
      const varName = `v${this.varCounter++}`;
      this.locations.set(step.id, { id: step.id, blockPath, index, varName });
      if (step.kind === "branch") {
        this.collectLocations(step.then, `${blockPath}/${step.id}/then`);
        this.collectLocations(step.else, `${blockPath}/${step.id}/else`);
      }
    }
  }

  private error(code: string, fieldPath: string, message: string, nodeId?: string, fix?: string): void {
    this.diagnostics.push(diagnostic({ code, fieldPath, message, ...(nodeId ? { nodeId } : {}), ...(fix ? { fix } : {}) }));
  }

  private resolveBlock(steps: Step[], env: Env): IrStep[] {
    const out: IrStep[] = [];
    let terminated = false;

    for (const [index, step] of steps.entries()) {
      if (terminated) {
        this.error(
          DIAGNOSTIC_CODES.STEP_AFTER_RESULT,
          `${env.blockPath}/${step.id}`,
          "this step is unreachable because a previous step already ended the path",
          step.id,
          "remove the step or make the earlier step non-terminal",
        );
        continue;
      }

      if (step.kind === "result") {
        out.push(this.resolveResult(step, env));
        terminated = true;
        continue;
      }

      if (step.kind === "branch") {
        if (env.blockPath !== ROOT_BLOCK) {
          this.error(
            DIAGNOSTIC_CODES.NESTED_BRANCH,
            `${env.blockPath}/${step.id}`,
            "a branch may only be the final step of the top-level block",
            step.id,
            "flatten the second decision into ordered assert steps",
          );
        }
        if (index !== steps.length - 1) {
          this.error(
            DIAGNOSTIC_CODES.BRANCH_NOT_TERMINAL,
            `${env.blockPath}/${step.id}`,
            "a branch must be the last step of its block",
            step.id,
            "move the branch to the end so both arms can return",
          );
        }
        out.push(this.resolveBranch(step, env));
        terminated = true;
        continue;
      }

      out.push(this.resolveStep(step, env));
    }

    return out;
  }

  private resolveBranch(step: Extract<Step, { kind: "branch" }>, env: Env): IrStep {
    const condition = this.resolveCondition(step.condition, env, `${env.blockPath}/${step.id}/condition`);
    const thenSteps = this.resolveArm(step.then, env, step.id, "then");
    const elseSteps = this.resolveArm(step.else, env, step.id, "else");
    return { kind: "branch", id: step.id, condition, then: thenSteps, else: elseSteps };
  }

  private resolveArm(steps: Step[], env: Env, branchId: string, arm: "then" | "else"): IrStep[] {
    const armEnv: Env = {
      blockPath: `${env.blockPath}/${branchId}/${arm}`,
      visible: new Map(env.visible),
    };
    if (steps.length === 0) {
      this.error(DIAGNOSTIC_CODES.MISSING_RESULT, armEnv.blockPath, `branch arm "${arm}" is empty`, branchId, "give the arm a result step");
      return [];
    }
    const resolved = this.resolveBlock(steps, armEnv);
    if (!terminates(resolved)) {
      this.error(
        DIAGNOSTIC_CODES.MISSING_RESULT,
        armEnv.blockPath,
        `branch arm "${arm}" must end in a result node`,
        branchId,
        "end the arm with a result step",
      );
    }
    return resolved;
  }

  private resolveStep(step: Step, env: Env): IrStep {
    switch (step.kind) {
      case "agent": {
        const location = this.locations.get(step.id)!;
        const task = this.resolveTask(step, env, step.id);
        this.defineSymbol(env, step.id, location.varName, task.schemaKey);
        this.phases.add(step.id);
        return { kind: "agent", id: step.id, varName: location.varName, task };
      }
      case "agent_map": {
        const location = this.locations.get(step.id)!;
        const items = this.resolveExpr(step.items, env, `${env.blockPath}/${step.id}/items`);
        if (items && items.type.kind !== "array" && items.type.kind !== "unknown") {
          this.error(
            DIAGNOSTIC_CODES.TYPE_MISMATCH,
            `${env.blockPath}/${step.id}/items`,
            `agent_map items must be an array, got ${describeType(items.type)}`,
            step.id,
          );
        }
        const bound = this.boundOf(items, step.id, `${env.blockPath}/${step.id}/items`);
        const taskEnv: Env = {
          blockPath: env.blockPath,
          visible: new Map(env.visible),
          item: { type: items?.type.kind === "array" ? items.type.items : { kind: "unknown" }, code: "__item" },
        };
        const task = this.resolveTask(step.task, taskEnv, step.id);
        const failurePolicy = step.failurePolicy ?? "collect";
        this.defineSymbol(env, step.id, location.varName, { kind: "array", items: MATERIAL_RESULT_TYPE });
        this.phases.add(step.id);
        return {
          kind: "agent_map",
          id: step.id,
          varName: location.varName,
          items: items ?? { code: "[]", type: { kind: "array", items: { kind: "unknown" } }, source: { literal: [] } },
          task,
          bound,
          concurrency: this.spec.limits.mapConcurrency,
          failurePolicy,
        };
      }
      case "transform": {
        const location = this.locations.get(step.id)!;
        const bindings: Record<string, IrExpr> = {};
        for (const [name, expr] of Object.entries(step.bindings)) {
          const resolved = this.resolveExpr(expr, env, `${env.blockPath}/${step.id}/bindings/${name}`);
          if (resolved) bindings[name] = resolved;
        }
        const outType = this.transformOutputType(step.op, bindings, step.id, env.blockPath);
        this.defineSymbol(env, step.id, location.varName, outType);
        const ir: IrStep = { kind: "transform", id: step.id, varName: location.varName, op: step.op, bindings, outType };
        if (step.fields) ir.fields = step.fields;
        return ir;
      }
      case "assert": {
        const location = this.locations.get(step.id)!;
        const bindings: Record<string, IrExpr> = {};
        for (const [name, expr] of Object.entries(step.bindings ?? {})) {
          const resolved = this.resolveExpr(expr, env, `${env.blockPath}/${step.id}/bindings/${name}`);
          if (resolved) bindings[name] = resolved;
        }
        this.defineSymbol(env, step.id, location.varName, ASSERT_RESULT_TYPE);
        return { kind: "assert", id: step.id, varName: location.varName, rules: step.rules as AssertRuleName[], bindings };
      }
      default:
        return step as never;
    }
  }

  private resolveResult(step: Extract<Step, { kind: "result" }>, env: Env): IrStep {
    const value: Record<string, IrExpr> = {};
    for (const [name, expr] of Object.entries(step.value ?? {})) {
      const resolved = this.resolveExpr(expr, env, `${env.blockPath}/${step.id}/value/${name}`);
      if (resolved) value[name] = resolved;
    }
    return { kind: "result", id: step.id, status: step.status as ResultStatus, value };
  }

  private resolveTask(
    task: { prompt: string; outputSchema: string; bindings?: Record<string, ValueExpr>; label?: ValueExpr },
    env: Env,
    nodeId: string,
  ): IrTask {
    const promptText = this.prompts[task.prompt];
    const schema = this.schemas[task.outputSchema];
    const bindings: Record<string, IrExpr> = {};
    for (const [name, expr] of Object.entries(task.bindings ?? {})) {
      const resolved = this.resolveExpr(expr, env, `${env.blockPath}/${nodeId}/bindings/${name}`);
      if (resolved) bindings[name] = resolved;
    }
    let label: IrExpr | undefined;
    if (task.label !== undefined) {
      const resolved = this.resolveExpr(task.label, env, `${env.blockPath}/${nodeId}/label`);
      if (resolved) {
        if (resolved.type.kind !== "string" && resolved.type.kind !== "unknown") {
          this.error(DIAGNOSTIC_CODES.TYPE_MISMATCH, `${env.blockPath}/${nodeId}/label`, "label must be a string expression", nodeId);
        }
        label = resolved;
      }
    }
    const ir: IrTask = {
      promptKey: task.prompt,
      promptText: promptText ?? "",
      schemaKey: task.outputSchema,
      schema: schema ?? {},
      bindings,
    };
    if (label) ir.label = label;
    if (typeof promptText !== "string") {
      this.error(DIAGNOSTIC_CODES.UNKNOWN_ASSET_KEY, `${env.blockPath}/${nodeId}`, `prompt "${task.prompt}" is missing`, nodeId);
    }
    return ir;
  }

  private defineSymbol(env: Env, nodeId: string, varName: string, schemaKeyOrType: string | FieldType): void {
    const type = typeof schemaKeyOrType === "string" ? (this.nativeSchemas.get(schemaKeyOrType) ?? { kind: "unknown" }) : schemaKeyOrType;
    env.visible.set(nodeId, { type, varName });
  }

  private boundOf(expr: IrExpr | undefined, nodeId: string, fieldPath: string): number {
    if (
      expr?.ref?.scope === "input" &&
      expr.ref.path.length === 1 &&
      expr.ref.path[0] === "materials"
    ) {
      return this.spec.limits.maxMaterials;
    }
    this.error(
      DIAGNOSTIC_CODES.UNBOUNDED_MAP_ITEMS,
      fieldPath,
      "agent_map items must reference the bounded input.materials array in v0.1",
      nodeId,
      "map over a bounded input array, or run the elements as explicit sequential agent steps",
    );
    return this.spec.limits.maxMaterials;
  }

  private transformOutputType(op: string, bindings: Record<string, IrExpr>, nodeId: string, blockPath: string): FieldType {
    switch (op) {
      case "collect_evidence":
        return EVIDENCE_SET_TYPE;
      case "select_fields":
        return { kind: "object", properties: {}, open: true };
      case "stable_sort": {
        const items = bindings["items"];
        if (items && items.type.kind === "array") return items.type;
        if (items && items.type.kind !== "unknown") {
          this.error(DIAGNOSTIC_CODES.TYPE_MISMATCH, `${blockPath}/${nodeId}/bindings/items`, "stable_sort needs an array", nodeId);
        }
        return { kind: "array", items: { kind: "unknown" } };
      }
      default:
        return { kind: "unknown" };
    }
  }

  private resolveCondition(condition: ConditionExpr, env: Env, fieldPath: string): IrCondition {
    switch (condition.op) {
      case "eq":
      case "lt": {
        const left = this.resolveExpr(condition.left, env, `${fieldPath}/left`);
        const right = this.resolveExpr(condition.right, env, `${fieldPath}/right`);
        if (condition.op === "lt") {
          for (const [side, expr] of [["left", left], ["right", right]] as const) {
            if (expr && !isNumberType(expr.type) && expr.type.kind !== "unknown") {
              this.error(
                DIAGNOSTIC_CODES.TYPE_MISMATCH,
                `${fieldPath}/${side}`,
                `lt compares numbers, got ${describeType(expr.type)}`,
              );
            }
          }
        }
        return {
          op: condition.op,
          left: left ?? { code: "undefined", type: { kind: "unknown" }, source: { literal: null } },
          right: right ?? { code: "undefined", type: { kind: "unknown" }, source: { literal: null } },
        };
      }
      case "is_empty": {
        const value = this.resolveExpr(condition.value, env, `${fieldPath}/value`);
        if (value && !isArrayLike(value.type)) {
          this.error(DIAGNOSTIC_CODES.TYPE_MISMATCH, `${fieldPath}/value`, `is_empty needs an array, object or string, got ${describeType(value.type)}`);
        }
        return {
          op: "is_empty",
          value: value ?? { code: "undefined", type: { kind: "unknown" }, source: { literal: null } },
        };
      }
      case "any":
      case "all": {
        const children = condition.conditions.map((child, index) => this.resolveCondition(child, env, `${fieldPath}/conditions/${index}`));
        return { op: condition.op, conditions: children };
      }
      default:
        return { op: "is_empty", value: { code: "undefined", type: { kind: "unknown" }, source: { literal: null } } };
    }
  }

  private resolveExpr(expr: ValueExpr, env: Env, fieldPath: string): IrExpr | undefined {
    if (!("ref" in expr)) {
      const literal = expr.literal;
      return { code: JSON.stringify(literal), type: literalType(literal), source: expr };
    }

    const ref = expr.ref;
    if (ref.scope === "item") {
      if (!env.item) {
        this.error(
          DIAGNOSTIC_CODES.ITEM_SCOPE_OUTSIDE_TASK,
          fieldPath,
          "scope \"item\" is only available inside an agent_map task",
          undefined,
          "reference input or a completed node instead",
        );
        return undefined;
      }
      return this.walkPath({ code: env.item.code, type: env.item.type, source: expr, ref }, ref.path, fieldPath);
    }

    if (ref.scope === "input") {
      return this.walkPath({ code: "args", type: this.inputType, source: expr, ref }, ref.path, fieldPath);
    }

    // scope === "node"
    const nodeId = ref.node;
    if (typeof nodeId !== "string") {
      this.error(DIAGNOSTIC_CODES.INVALID_REF_PATH, fieldPath, "scope \"node\" requires a node id");
      return undefined;
    }
    const visible = env.visible.get(nodeId);
    if (visible) {
      return this.walkPath({ code: visible.varName, type: visible.type, source: expr, ref }, ref.path, fieldPath);
    }
    const location = this.locations.get(nodeId);
    if (!location) {
      this.error(
        DIAGNOSTIC_CODES.UNKNOWN_NODE_REFERENCE,
        fieldPath,
        `no node with id "${nodeId}"`,
        undefined,
        "reference an already-completed node or fix the id",
      );
      return undefined;
    }
    if (siblingArm(location.blockPath, env.blockPath)) {
      this.error(
        DIAGNOSTIC_CODES.SIBLING_BRANCH_REFERENCE,
        fieldPath,
        `node "${nodeId}" lives in the other branch arm and is not available here`,
        nodeId,
        "produce the value before the branch so both arms can read it",
      );
      return undefined;
    }
    if (location.blockPath === env.blockPath) {
      this.error(
        DIAGNOSTIC_CODES.FORWARD_NODE_REFERENCE,
        fieldPath,
        `node "${nodeId}" is declared later in this block and is not completed yet`,
        nodeId,
        "move the reference after the node",
      );
      return undefined;
    }
    this.error(
      DIAGNOSTIC_CODES.FORWARD_NODE_REFERENCE,
      fieldPath,
      `node "${nodeId}" is not completed before this step`,
      nodeId,
      "move the reference after the node, or check that the node is not inside another block",
    );
    return undefined;
  }

  private walkPath(base: IrExpr, path: Array<string | number>, fieldPath: string): IrExpr | undefined {
    let type = base.type;
    let code = base.code;
    for (const segment of path) {
      const access = accessProperty(type, segment);
      if (!access.ok) {
        if (access.reason === "UNKNOWN_FIELD") {
          this.error(
            DIAGNOSTIC_CODES.UNKNOWN_FIELD_ACCESS,
            `${fieldPath}/path`,
            `field "${String(segment)}" does not exist on ${describeType(type)}`,
            undefined,
            "use a field declared by the referenced schema",
          );
        } else if (access.reason === "OPTIONAL_FIELD") {
          this.error(
            DIAGNOSTIC_CODES.OPTIONAL_FIELD_READ,
            `${fieldPath}/path`,
            `field "${String(segment)}" is optional; reading it without a check is not allowed in v0.1`,
            undefined,
            "make the field required by the schema, or handle the absence before referencing it",
          );
        } else {
          this.error(
            DIAGNOSTIC_CODES.TYPE_MISMATCH,
            `${fieldPath}/path`,
            `cannot read "${String(segment)}" on ${describeType(type)}`,
          );
        }
        return undefined;
      }
      code += typeof segment === "number" ? `[${segment}]` : `[${JSON.stringify(segment)}]`;
      type = access.type;
    }
    return { code, type, source: base.source, ref: base.ref };
  }
}

function siblingArm(locationBlock: string, envBlock: string): boolean {
  if (locationBlock === envBlock) return false;
  const locationParts = locationBlock.split("/");
  const envParts = envBlock.split("/");
  if (locationParts.length !== envParts.length) return false;
  const last = locationParts.length - 1;
  const locationArm = locationParts[last];
  const envArm = envParts[last];
  if (locationArm !== "then" && locationArm !== "else") return false;
  if (locationArm === envArm) return false;
  return locationParts.slice(0, last).join("/") === envParts.slice(0, last).join("/");
}

function terminates(steps: readonly IrStep[]): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  if (last.kind === "result") return true;
  if (last.kind === "branch") return terminates(last.then) && terminates(last.else);
  return false;
}

function maxAgents(steps: readonly IrStep[]): number {
  let total = 0;
  for (const step of steps) {
    if (step.kind === "agent") total += 1;
    else if (step.kind === "agent_map") total += step.bound;
    else if (step.kind === "branch") total += Math.max(maxAgents(step.then), maxAgents(step.else));
  }
  return total;
}

function contractType(schema: JsonSchema): FieldType {
  return fieldTypeFromSchema(schema);
}

function literalType(value: JsonValue): FieldType {
  switch (typeof value) {
    case "string":
      return { kind: "string" };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    default:
      if (value === null) return { kind: "null" };
      if (Array.isArray(value)) return { kind: "array", items: { kind: "unknown" } };
      return { kind: "unknown" };
  }
}

export function analyzeWorkflow(spec: WorkflowSpec, _options: AnalyzeOptions = {}): AnalyzeResult {
  return new Analyzer(spec).run();
}
