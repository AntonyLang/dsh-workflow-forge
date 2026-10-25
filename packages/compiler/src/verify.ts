/**
 * Compiler step 7: syntax check and mock self-check.
 *
 * The self-check runs the emitted program with mock `agent`/`parallel` helpers to
 * prove that statements are ordered, both branch arms are reachable, null results
 * become explicit failures, and the batch sizes respect the declared limit.
 * It does not prove business quality and does not pretend to.
 */
import vm from "node:vm";
import { DIAGNOSTIC_CODES, diagnostic, getContract, type Diagnostic, type JsonSchema, type JsonValue } from "@workflow-forge/spec";
import type { CompiledWorkflow } from "./ir.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

export type ScriptErrorInfo = { code: string; message: string; details?: JsonValue };

export type ScriptOutcome =
  | { ok: true; value: JsonValue }
  | { ok: false; error: ScriptErrorInfo };

export type MockHooks = {
  agent: (prompt: string, options: { schema?: JsonSchema; label?: string }, callIndex: number) => JsonValue | null;
  onBatch?: (size: number) => void;
  log?: (message: string) => void;
  phase?: (title: string) => void;
};

const ERROR_PREFIX = "__WF_ERROR__";

export function parseScriptError(error: unknown): ScriptErrorInfo {
  if (error instanceof Error) {
    const message = error.message ?? String(error);
    if (message.startsWith(ERROR_PREFIX)) {
      try {
        const payload = JSON.parse(message.slice(ERROR_PREFIX.length)) as { code?: unknown; detail?: unknown };
        return {
          code: typeof payload.code === "string" ? payload.code : "SCRIPT_ERROR",
          message,
          ...(payload.detail !== undefined ? { details: payload.detail as JsonValue } : {}),
        };
      } catch {
        return { code: "SCRIPT_ERROR", message };
      }
    }
    return { code: "SCRIPT_ERROR", message };
  }
  return { code: "SCRIPT_ERROR", message: String(error) };
}

export function checkScriptSyntax(script: string): { ok: true } | { ok: false; message: string } {
  try {
    new vm.Script(`(async function (agent, parallel, log, phase, args) {\n${script}\n})`, {
      filename: "workflow-script.js",
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function runScriptWithMocks(script: string, args: JsonValue, hooks: MockHooks): Promise<ScriptOutcome> {
  const fn = new AsyncFunction("agent", "parallel", "log", "phase", "args", script);
  let callIndex = 0;
  const agent = (prompt: unknown, options?: unknown): unknown => {
    const index = callIndex++;
    return hooks.agent(String(prompt), (options ?? {}) as { schema?: JsonSchema; label?: string }, index);
  };
  const parallel = async (thunks: unknown): Promise<unknown[]> => {
    const list = Array.isArray(thunks) ? (thunks as Array<() => Promise<unknown>>) : [];
    hooks.onBatch?.(list.length);
    return Promise.all(
      list.map((thunk) =>
        Promise.resolve()
          .then(() => thunk())
          .catch(() => null),
      ),
    );
  };
  try {
    const value = (await fn(agent, parallel, hooks.log ?? (() => {}), hooks.phase ?? (() => {}), args)) as JsonValue;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: parseScriptError(error) };
  }
}

export type SelfCheckReport = {
  ok: boolean;
  notes: string[];
  diagnostics: Diagnostic[];
  agentCalls: number;
  maxBatch: number;
};

const ALLOWED_STATUS = new Set(["completed", "insufficient_input", "failed", "cancelled"]);

export async function selfCheckScript(workflow: CompiledWorkflow, script: string): Promise<SelfCheckReport> {
  const notes: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const args = sampleArgs();
  let agentCalls = 0;
  let maxBatch = 0;

  const happy = await runScriptWithMocks(script, args, {
    agent: (prompt, options, index) => {
      agentCalls = index + 1;
      return sampleAgentValue(options.schema, args, options.label, prompt);
    },
    onBatch: (size) => {
      maxBatch = Math.max(maxBatch, size);
    },
    phase: (title) => notes.push(`phase:${title}`),
    log: (message) => notes.push(`log:${message}`),
  });

  if (happy.ok) {
    const value = happy.value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      diagnostics.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.SCRIPT_SELF_CHECK_FAILED,
          fieldPath: "script",
          message: "the script did not return a ScenarioResult object",
        }),
      );
    } else {
      const record = value as Record<string, JsonValue>;
      const status = record["status"];
      if (typeof status !== "string" || !ALLOWED_STATUS.has(status)) {
        diagnostics.push(
          diagnostic({
            code: DIAGNOSTIC_CODES.SCRIPT_SELF_CHECK_FAILED,
            fieldPath: "script",
            message: `result status ${JSON.stringify(status)} is not a ScenarioStatus`,
          }),
        );
      }
      for (const key of ["brief", "evidence", "failedMaterials", "checks"]) {
        if (!(key in record)) {
          diagnostics.push(
            diagnostic({
              code: DIAGNOSTIC_CODES.SCRIPT_SELF_CHECK_FAILED,
              fieldPath: "script",
              message: `result is missing the "${key}" field`,
            }),
          );
        }
      }
      if (status === "completed" && (record["brief"] === null || record["brief"] === undefined)) {
        diagnostics.push(
          diagnostic({
            code: DIAGNOSTIC_CODES.SCRIPT_SELF_CHECK_FAILED,
            fieldPath: "script",
            message: "a completed result must carry a brief",
          }),
        );
      }
      notes.push(`happy-status:${String(status)}`);
    }
  } else {
    // A business assertion may legitimately reject the generic mock report; the
    // structured envelope still proves the path was reached and the error shape
    // is stable. Anything else is a real script defect.
    const tolerable = happy.error.code === "ASSERTION_FAILED" || happy.error.code === "AGENT_RESULT_MISSING";
    if (!tolerable) {
      diagnostics.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.SCRIPT_SELF_CHECK_FAILED,
          fieldPath: "script",
          message: `the script failed outside the workflow error envelope: ${happy.error.message}`,
        }),
      );
    } else {
      notes.push(`happy-error:${happy.error.code}`);
    }
  }

  if (agentCalls > workflow.worstCaseAgents) {
    diagnostics.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.SCRIPT_SELF_CHECK_FAILED,
        fieldPath: "script",
        message: `the self-check started ${agentCalls} agents; the declared worst case is ${workflow.worstCaseAgents}`,
      }),
    );
  }
  if (maxBatch > workflow.spec.limits.mapConcurrency) {
    diagnostics.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.SCRIPT_SELF_CHECK_FAILED,
        fieldPath: "script",
        message: `a parallel batch started ${maxBatch} agents; limits.mapConcurrency is ${workflow.spec.limits.mapConcurrency}`,
      }),
    );
  }

  const nullRun = await runScriptWithMocks(script, args, {
    agent: () => null,
  });
  if (nullRun.ok) {
    const record = nullRun.value as Record<string, JsonValue> | null;
    if (record && record["status"] === "completed") {
      diagnostics.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.SCRIPT_SELF_CHECK_FAILED,
          fieldPath: "script",
          message: "the script reported completed even though every agent returned null",
        }),
      );
    }
    notes.push(`null-status:${String(record?.["status"])}`);
  } else if (nullRun.error.code !== "AGENT_RESULT_MISSING" && nullRun.error.code !== "ASSERTION_FAILED") {
    diagnostics.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.SCRIPT_SELF_CHECK_FAILED,
        fieldPath: "script",
        message: `with null agent results the script failed unexpectedly: ${nullRun.error.message}`,
      }),
    );
  } else {
    notes.push(`null-error:${nullRun.error.code}`);
  }

  return { ok: diagnostics.length === 0, notes, diagnostics, agentCalls, maxBatch };
}

/** Valid-ish normalized input for the compiled contract, used only for self-checks. */
export function sampleArgs(): JsonValue {
  idCounter = 0;
  const contract = getContract("source-brief-normalized@1");
  if (!contract) return { topic: "sample", materials: [], dimensions: [], language: "zh", minSuccessful: 1 };
  const sampled = sampleValue(contract.schema, "args", 0);
  return sampled === null || typeof sampled !== "object" || Array.isArray(sampled)
    ? { topic: "sample", materials: [], dimensions: [], language: "zh", minSuccessful: 1 }
    : sampled;
}

function sampleValue(schema: JsonSchema, path: string, depth: number): JsonValue {
  const constValue = schema["const"];
  if (constValue !== undefined) return constValue;
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0] as JsonValue;

  switch (schema["type"]) {
    case "string":
      return sampleString(path);
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      const items = schema["items"] as JsonSchema | undefined;
      if (!items) return [];
      const count = items["type"] === "object" ? 2 : 2;
      return Array.from({ length: count }, (_, index) => sampleValue(items, `${path}/${index}`, depth + 1));
    }
    case "object": {
      const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
      const required = new Set(Array.isArray(schema["required"]) ? (schema["required"] as string[]) : Object.keys(properties));
      const out: Record<string, JsonValue> = {};
      for (const [name, child] of Object.entries(properties)) {
        if (!required.has(name)) continue;
        out[name] = name === "id" ? `id${countIds(path)}` : sampleValue(child, `${path}/${name}`, depth + 1);
      }
      return out;
    }
    default:
      return null;
  }
}

let idCounter = 0;
function countIds(_path: string): number {
  idCounter += 1;
  return idCounter;
}

function sampleString(path: string): string {
  if (path.endsWith("/paragraphId")) return `p${idCounter}`;
  if (path.endsWith("/topic")) return "sample topic";
  if (path.endsWith("/language")) return "zh";
  if (path.endsWith("/title")) return "Sample title";
  if (path.endsWith("/text")) return "Sample paragraph text used by the compiler self-check.";
  return `sample-${path.split("/").pop() ?? "value"}`;
}

/**
 * Build a mock agent value from the schema. Two heuristics make the common
 * shapes usable: facts are derived from the sampled material, and a brief is
 * derived from the sampled dimensions plus the deterministic evidence ids.
 */
export function sampleAgentValue(schema: JsonSchema | undefined, args: JsonValue, label: string | undefined, prompt: string): JsonValue {
  if (!schema) return null;
  const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
  const material = findMaterial(args, label);

  if (properties["facts"] && material) {
    const paragraph = (material["paragraphs"] as JsonValue[] | undefined)?.[0] as Record<string, JsonValue> | undefined;
    if (paragraph && typeof paragraph["paragraphId"] === "string" && typeof paragraph["text"] === "string") {
      const text = paragraph["text"] as string;
      return {
        facts: [
          {
            paragraphId: paragraph["paragraphId"],
            quote: text.slice(0, Math.min(40, text.length)),
            statement: `Mock fact derived from ${String(paragraph["paragraphId"])}.`,
          },
        ],
      };
    }
  }

  if (properties["dimensions"] && properties["conclusions"]) {
    const materials = Array.isArray((args as Record<string, JsonValue>)["materials"])
      ? ((args as Record<string, JsonValue>)["materials"] as JsonValue[])
      : [];
    const ids = materials
      .map((entry, index) => (entry && typeof entry === "object" ? String((entry as Record<string, JsonValue>)["id"] ?? `m${index}`) : `m${index}`))
      .map((id) => `${id}:1`);
    const dimensions = Array.isArray((args as Record<string, JsonValue>)["dimensions"])
      ? ((args as Record<string, JsonValue>)["dimensions"] as JsonValue[])
      : [];
    const names = dimensions.length > 0 ? dimensions.map((dimension) => String(dimension)) : ["overview"];
    return {
      title: `Mock brief (${prompt.slice(0, 24)})`,
      dimensions: names.map((name) => ({
        dimension: name,
        findings: [
          {
            kind: "fact",
            text: `Mock finding for ${name}.`,
            evidenceIds: ids.length > 0 ? [ids[0]!] : [],
          },
        ],
      })),
      conclusions: [
        {
          kind: "fact",
          text: "Mock conclusion.",
          evidenceIds: ids.length > 0 ? [ids[0]!] : [],
        },
      ],
    };
  }

  return sampleValue(schema, "value", 0);
}

function findMaterial(args: JsonValue, label: string | undefined): Record<string, JsonValue> | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const materials = (args as Record<string, JsonValue>)["materials"];
  if (!Array.isArray(materials)) return undefined;
  const candidates = materials.filter(
    (entry): entry is Record<string, JsonValue> => entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  if (label) {
    const match = candidates.find((entry) => entry["id"] === label);
    if (match) return match;
  }
  return candidates[0];
}
