/**
 * Intermediate representation produced by static analysis.
 *
 * Every reference is already resolved to a JavaScript accessor and a structural
 * type, so the emitter never guesses and never interpolates user text as code.
 */
import type { AssertRuleName, JsonSchema, RefScope, ResultStatus, ValueExpr, WorkflowSpec } from "@workflow-forge/spec";
import type { FieldType } from "./field-types.js";

export type IrRef = { scope: RefScope; node?: string; path: Array<string | number> };

export type IrExpr = {
  code: string;
  type: FieldType;
  source: ValueExpr;
  ref?: IrRef;
};

export type IrCondition =
  | { op: "eq" | "lt"; left: IrExpr; right: IrExpr }
  | { op: "is_empty"; value: IrExpr }
  | { op: "any" | "all"; conditions: IrCondition[] };

export type IrTask = {
  promptKey: string;
  promptText: string;
  schemaKey: string;
  schema: JsonSchema;
  bindings: Record<string, IrExpr>;
  label?: IrExpr;
};

export type IrStep =
  | ({ kind: "agent"; id: string; varName: string; task: IrTask })
  | ({
      kind: "agent_map";
      id: string;
      varName: string;
      items: IrExpr;
      task: IrTask;
      bound: number;
      concurrency: number;
      failurePolicy: "fail" | "collect";
    })
  | ({ kind: "transform"; id: string; varName: string; op: string; bindings: Record<string, IrExpr>; fields?: string[]; outType: FieldType })
  | ({ kind: "assert"; id: string; varName: string; rules: AssertRuleName[]; bindings: Record<string, IrExpr> })
  | ({ kind: "branch"; id: string; condition: IrCondition; then: IrStep[]; else: IrStep[] })
  | ({ kind: "result"; id: string; status: ResultStatus; value: Record<string, IrExpr> });

export type CompiledWorkflow = {
  spec: WorkflowSpec;
  steps: IrStep[];
  /** Direct agent invocations on the worst-case path, per the compiler's count. */
  worstCaseAgents: number;
  phases: string[];
  defaultsApplied: string[];
};

export function walkIr(steps: readonly IrStep[], visit: (step: IrStep) => void): void {
  for (const step of steps) {
    visit(step);
    if (step.kind === "branch") {
      walkIr(step.then, visit);
      walkIr(step.else, visit);
    }
  }
}
