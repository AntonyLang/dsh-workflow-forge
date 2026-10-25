/**
 * Emitter (compiler step 6).
 *
 * Code comes from fixed templates; user text only ever enters as JSON-encoded
 * data (prompt strings, schema literals, literal expressions). Variable names are
 * compiler-assigned and no model-supplied function body is inserted anywhere.
 */
import type { JsonSchema } from "@workflow-forge/spec";
import { SCRIPT_HELPERS_SOURCE } from "./script-helpers.js";
import { walkIr, type CompiledWorkflow, type IrCondition, type IrExpr, type IrStep, type IrTask } from "./ir.js";

export type EmitOptions = { specHash: string; compilerVersion: string };

export type EmittedScript = {
  script: string;
  meta: { name: string; phases: string[] };
  /** Byte-level identity of the generated program text. */
  scriptSource: string;
};

const INDENT = "  ";

export function emitScript(workflow: CompiledWorkflow, options: EmitOptions): EmittedScript {
  const { spec } = workflow;
  const prompts = Object.fromEntries(
    Object.entries(spec.assets.prompts).map(([key, text]) => [key, text]),
  );
  const schemas = Object.fromEntries(Object.entries(spec.assets.schemas));

  const lines: string[] = [];
  lines.push("/* Workflow Forge generated script — do not edit.");
  lines.push(` * workflow: ${spec.workflowId}@${spec.version}`);
  lines.push(` * specHash: ${options.specHash}`);
  lines.push(` * compiler: ${options.compilerVersion}`);
  lines.push(" */");
  lines.push(`const __P = ${JSON.stringify(prompts, null, 2)};`);
  lines.push(`const __S = ${JSON.stringify(schemas, null, 2)};`);
  lines.push(SCRIPT_HELPERS_SOURCE.trim());
  lines.push("");
  lines.push(...emitSteps(workflow.steps, 0));
  const script = lines.join("\n") + "\n";

  return {
    script,
    meta: { name: spec.workflowId, phases: workflow.phases },
    scriptSource: script,
  };
}

function emitSteps(steps: readonly IrStep[], depth: number): string[] {
  const out: string[] = [];
  for (const step of steps) out.push(...emitStep(step, depth));
  return out;
}

function pad(depth: number): string {
  return INDENT.repeat(depth);
}

function emitStep(step: IrStep, depth: number): string[] {
  const p = pad(depth);
  switch (step.kind) {
    case "agent": {
      const out: string[] = [];
      const options = agentOptions(step.task);
      out.push(`${p}const ${step.varName} = await agent(${promptCall(step.task)}, ${options});`);
      out.push(
        `${p}if (${step.varName} === null || ${step.varName} === undefined) throw __wfError("AGENT_RESULT_MISSING", { node: ${JSON.stringify(step.id)} });`,
      );
      return out;
    }
    case "agent_map":
      return emitMap(step, depth);
    case "transform":
      return [`${p}const ${step.varName} = ${transformCall(step)};`];
    case "assert": {
      const entries: string[] = [`${p}  rules: ${JSON.stringify(step.rules)},`];
      for (const [name, expr] of Object.entries(step.bindings)) {
        entries.push(`${p}  ${JSON.stringify(name)}: ${expr.code},`);
      }
      entries.push(`${p}  input: args,`);
      return [`${p}const ${step.varName} = runAssertRules({`, ...entries, `${p}});`];
    }
    case "branch": {
      const out: string[] = [];
      out.push(`${p}if (${conditionCode(step.condition)}) {`);
      out.push(...emitSteps(step.then, depth + 1));
      out.push(`${p}} else {`);
      out.push(...emitSteps(step.else, depth + 1));
      out.push(`${p}}`);
      return out;
    }
    case "result": {
      const entries = Object.entries(step.value).map(([name, expr]) => `${p}  ${JSON.stringify(name)}: ${expr.code},`);
      if (entries.length === 0) return [`${p}return finalize(${JSON.stringify(step.status)}, {});`];
      return [`${p}return finalize(${JSON.stringify(step.status)}, {`, ...entries, `${p}});`];
    }
    default:
      return [`${p}/* unsupported step */`];
  }
}

function emitMap(step: Extract<IrStep, { kind: "agent_map" }>, depth: number): string[] {
  const p = pad(depth);
  const concurrency = Math.max(1, Math.min(2, step.concurrency));
  const items = step.items.code;
  return [
    `${p}const ${step.varName} = [];`,
    `${p}for (let __i = 0; __i < ${items}.length; __i += ${concurrency}) {`,
    `${p}  const __b = ${items}.slice(__i, __i + ${concurrency});`,
    `${p}  const __r = await parallel(__b.map((__item) => () => agent(${promptCall(step.task)}, ${agentOptions(step.task)})));`,
    `${p}  for (let __j = 0; __j < __b.length; __j++) {`,
    `${p}    const __x = __r[__j];`,
    `${p}    ${step.varName}.push(__x === null || __x === undefined`,
    `${p}      ? failedMaterial(itemId(__b[__j], __i + __j), __i + __j, "NO_STRUCTURED_RESULT")`,
    `${p}      : checkedMaterial(__b[__j], __i + __j, __x));`,
    `${p}  }`,
    `${p}}`,
  ];
}

function promptCall(task: IrTask): string {
  const entries = Object.entries(task.bindings).map(([name, expr]) => `${JSON.stringify(name)}: ${expr.code}`);
  return `renderPrompt(__P[${JSON.stringify(task.promptKey)}], { ${entries.join(", ")} })`;
}

function agentOptions(task: IrTask): string {
  const parts = [`schema: __S[${JSON.stringify(task.schemaKey)}]`];
  if (task.label) parts.push(`label: ${task.label.code}`);
  return `{ ${parts.join(", ")} }`;
}

function transformCall(step: Extract<IrStep, { kind: "transform" }>): string {
  if (step.op === "collect_evidence") {
    return `collectEvidence(${step.bindings["materials"]?.code ?? "[]"}, ${step.bindings["results"]?.code ?? "[]"})`;
  }
  if (step.op === "select_fields") {
    return `selectFields(${step.bindings["source"]?.code ?? "null"}, ${JSON.stringify(step.fields ?? [])})`;
  }
  if (step.op === "stable_sort") {
    return `stableSort(${step.bindings["items"]?.code ?? "[]"}, ${JSON.stringify(step.fields ?? [])})`;
  }
  return `null`;
}

export function conditionCode(condition: IrCondition): string {
  switch (condition.op) {
    case "eq":
      return `eq(${condition.left.code}, ${condition.right.code})`;
    case "lt":
      return `lt(${condition.left.code}, ${condition.right.code})`;
    case "is_empty":
      return `isEmpty(${condition.value.code})`;
    case "any":
      return `(${condition.conditions.map(conditionCode).join(" || ")})`;
    case "all":
      return `(${condition.conditions.map(conditionCode).join(" && ")})`;
    default:
      return "false";
  }
}

/** Flatten every emitted expression for a quick static review report. */
export function agentNodes(workflow: CompiledWorkflow): Array<{ id: string; kind: string; schemaKey: string }> {
  const out: Array<{ id: string; kind: string; schemaKey: string }> = [];
  walkIr(workflow.steps, (step) => {
    if (step.kind === "agent") out.push({ id: step.id, kind: "agent", schemaKey: step.task.schemaKey });
    if (step.kind === "agent_map") out.push({ id: step.id, kind: "agent_map", schemaKey: step.task.schemaKey });
  });
  return out;
}

export function schemasUsed(workflow: CompiledWorkflow): JsonSchema[] {
  const out: JsonSchema[] = [];
  walkIr(workflow.steps, (step) => {
    if (step.kind === "agent") out.push(step.task.schema);
    if (step.kind === "agent_map") out.push(step.task.schema);
  });
  return out;
}
