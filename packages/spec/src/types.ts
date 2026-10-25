/**
 * WorkflowSpec 0.1 — the restricted product format (NOT a DSH native format).
 *
 * The spec is deliberately small: sequential steps, one optional trailing
 * single-level branch, no loops, no free DAG, no model-supplied function bodies.
 * Everything a user writes is data; the compiler owns code emission.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** A product JSON Schema (Ajv-validated, may use any JSON Schema keyword). */
export type JsonSchema = { [key: string]: JsonValue };

export const SPEC_VERSION = "0.1" as const;
export type SpecVersion = typeof SPEC_VERSION;

export type RefScope = "input" | "node" | "item";

/**
 * A structured reference. Never a JavaScript expression: `path` is a list of
 * field names or non-negative array indexes.
 */
export type ValueRef = {
  ref: {
    scope: RefScope;
    node?: string;
    path: Array<string | number>;
  };
};

export type ValueExpr = ValueRef | { literal: JsonValue };

export type FailurePolicy = "fail" | "collect";

export type AgentTaskSpec = {
  prompt: string;
  outputSchema: string;
  bindings?: Record<string, ValueExpr>;
  /** A string expression used as the agent label (observability only). */
  label?: ValueExpr;
};

export type AgentStep = AgentTaskSpec & { id: string; kind: "agent" };

export type AgentMapStep = {
  id: string;
  kind: "agent_map";
  items: ValueExpr;
  task: AgentTaskSpec;
  failurePolicy?: FailurePolicy;
};

export type TransformOp = "collect_evidence" | "select_fields" | "stable_sort";

export type TransformStep = {
  id: string;
  kind: "transform";
  op: TransformOp;
  bindings: Record<string, ValueExpr>;
  /** select_fields: keys to project. stable_sort: string fields to order by. */
  fields?: string[];
};

export type AssertRuleName =
  | "input_limits"
  | "evidence_ids_exist"
  | "required_dimensions"
  | "non_empty_brief"
  | "result_size";

export type AssertStep = {
  id: string;
  kind: "assert";
  rules: AssertRuleName[];
  bindings?: Record<string, ValueExpr>;
};

export type ConditionExpr =
  | { op: "eq" | "lt"; left: ValueExpr; right: ValueExpr }
  | { op: "is_empty"; value: ValueExpr }
  | { op: "any" | "all"; conditions: ConditionExpr[] };

export type ResultStatus = "completed" | "insufficient_input";

export type ResultStep = {
  id: string;
  kind: "result";
  status: ResultStatus;
  /** Only ScenarioResult fields may be produced; `status` is never user-supplied code. */
  value?: Record<string, ValueExpr>;
};

export type Step = AgentStep | AgentMapStep | TransformStep | AssertStep | BranchStep | ResultStep;

export type BranchStep = {
  id: string;
  kind: "branch";
  condition: ConditionExpr;
  then: Step[];
  else: Step[];
};

export type StepKind = Step["kind"];

export type SpecLimits = {
  maxMaterials: number;
  mapConcurrency: number;
  maxDirectAgents: number;
};

export type SpecAssets = {
  prompts: Record<string, string>;
  schemas: Record<string, JsonSchema>;
};

export type WorkflowSpec = {
  specVersion: SpecVersion;
  workflowId: string;
  version: string;
  title?: string;
  description?: string;
  inputContract: string;
  normalizedInputContract: string;
  outputContract: string;
  limits: SpecLimits;
  assets: SpecAssets;
  steps: Step[];
};

/** Product-level hard bounds for v0.1. Specs may be stricter, never looser. */
export const PRODUCT_LIMITS = {
  maxMaterials: 4,
  minMaterials: 1,
  maxDimensions: 6,
  maxMaterialCodePoints: 8000,
  maxTotalCodePoints: 24000,
  mapConcurrency: 2,
  maxDirectAgents: 5,
  maxConditionChildren: 8,
  maxSteps: 32,
  maxResultBytes: 512 * 1024,
} as const;

/** The only ScenarioResult fields a result node may produce. */
export const RESULT_VALUE_KEYS = ["brief", "evidence", "failedMaterials", "checks"] as const;
export type ResultValueKey = (typeof RESULT_VALUE_KEYS)[number];
