import { describe, expect, it } from "vitest";
import { compile, analyzeWorkflow } from "@workflow-forge/compiler";
import { parseSpec } from "@workflow-forge/spec";
import { IDENTITY, cloneSpec, minimalSpec } from "../support/helpers.js";

type Raw = Record<string, unknown>;

function steps(spec: Raw): Array<Record<string, unknown>> {
  return spec["steps"] as Array<Record<string, unknown>>;
}

function agent(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: "agent",
    prompt: "only",
    outputSchema: "Facts",
    bindings: { topic: { ref: { scope: "input", path: ["topic"] } } },
    ...extra,
  };
}

function result(id: string, status = "completed", value: unknown = undefined): Record<string, unknown> {
  const step: Record<string, unknown> = { id, kind: "result", status };
  if (value !== undefined) step["value"] = value;
  return step;
}

function branchWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "gate",
    kind: "branch",
    condition: { op: "lt", left: { ref: { scope: "input", path: ["minSuccessful"] } }, right: { literal: 0 } },
    then: [result("then_done", "insufficient_input")],
    else: [result("else_done")],
    ...overrides,
  };
}

async function codesOf(raw: unknown): Promise<string[]> {
  const result = await compile(raw, IDENTITY);
  return result.ok ? [] : result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

/** Two agents so the second can reference the first. */
function twoAgentSpec(): Raw {
  const spec = minimalSpec();
  steps(spec).splice(1, 0, agent("second"));
  return spec;
}

describe("compiler: rejected definitions", () => {
  it("rejects a reference to a later node", async () => {
    const spec = minimalSpec();
    steps(spec)[0]!["bindings"] = { topic: { ref: { scope: "node", node: "later", path: ["facts"] } } };
    steps(spec).splice(2, 0, agent("later"));
    expect(await codesOf(spec)).toContain("FORWARD_NODE_REFERENCE");
  });

  it("rejects a reference to an unknown node", async () => {
    const spec = minimalSpec();
    steps(spec)[0]!["bindings"] = { topic: { ref: { scope: "node", node: "nope", path: ["facts"] } } };
    expect(await codesOf(spec)).toContain("UNKNOWN_NODE_REFERENCE");
  });

  it("rejects a reference from one branch arm into the other", async () => {
    const spec = twoAgentSpec();
    steps(spec)[2] = branchWith({
      then: [agent("then_agent"), result("then_done")],
      else: [result("else_done", "completed", { checks: { ref: { scope: "node", node: "then_agent", path: [] } } })],
    });
    expect(await codesOf(spec)).toContain("SIBLING_BRANCH_REFERENCE");
  });

  it("rejects a branch that is not the last step", async () => {
    const spec = twoAgentSpec();
    const list = steps(spec);
    list.length = 2; // drop the trailing result so nothing is unreachable yet
    list.push(branchWith({}), result("after"));
    expect(await codesOf(spec)).toContain("BRANCH_NOT_TERMINAL");
    expect(await codesOf(spec)).toContain("STEP_AFTER_RESULT");
  });

  it("rejects a nested branch", async () => {
    const spec = twoAgentSpec();
    const list = steps(spec);
    list.length = 2;
    list.push(
      branchWith({
        then: [
          branchWith({ id: "inner", then: [result("inner_then")], else: [result("inner_else")] }),
          result("then_done"),
        ],
      }),
    );
    expect(await codesOf(spec)).toContain("NESTED_BRANCH");
  });

  it("rejects a branch arm without a result", async () => {
    const spec = twoAgentSpec();
    const list = steps(spec);
    list.length = 2;
    list.push(branchWith({ else: [agent("dangling")] }));
    expect(await codesOf(spec)).toContain("MISSING_RESULT");
  });

  it("rejects a workflow with no result at all", async () => {
    const spec = minimalSpec();
    steps(spec).pop();
    expect(await codesOf(spec)).toContain("MISSING_RESULT");
  });

  it("rejects a step after a result", async () => {
    const spec = minimalSpec();
    steps(spec).push(agent("unreachable"));
    expect(await codesOf(spec)).toContain("STEP_AFTER_RESULT");
  });

  it("rejects a worst-case agent count above the declared limit", async () => {
    const spec = minimalSpec();
    (spec["limits"] as Raw)["maxDirectAgents"] = 2;
    steps(spec).splice(1, 0, agent("second"), agent("third"));
    expect(await codesOf(spec)).toContain("AGENT_BUDGET_EXCEEDED");
  });

  it("rejects a map over an unbounded array", async () => {
    const spec = minimalSpec();
    steps(spec).splice(1, 0, {
      id: "mapped",
      kind: "agent_map",
      items: { literal: [] },
      task: {
        prompt: "only",
        outputSchema: "Facts",
        bindings: { topic: { ref: { scope: "input", path: ["topic"] } } },
      },
    });
    expect(await codesOf(spec)).toContain("UNBOUNDED_MAP_ITEMS");
  });

  it("rejects reading an optional agent-output field", async () => {
    const spec = twoAgentSpec();
    (spec["assets"] as Raw)["schemas"] = {
      Facts: {
        type: "object",
        additionalProperties: false,
        required: ["facts"],
        properties: { facts: { type: "array", items: { type: "string" } }, note: { type: "string" } },
      },
    };
    steps(spec)[1]!["bindings"] = { topic: { ref: { scope: "node", node: "extract", path: ["note"] } } };
    expect(await codesOf(spec)).toContain("OPTIONAL_FIELD_READ");
  });

  it("rejects reading a field that the schema does not declare", async () => {
    const spec = twoAgentSpec();
    steps(spec)[1]!["bindings"] = { topic: { ref: { scope: "node", node: "extract", path: ["missing"] } } };
    expect(await codesOf(spec)).toContain("UNKNOWN_FIELD_ACCESS");
  });

  it("rejects scope item outside an agent_map task", async () => {
    const spec = minimalSpec();
    steps(spec)[0]!["bindings"] = { topic: { ref: { scope: "item", path: ["id"] } } };
    expect(await codesOf(spec)).toContain("ITEM_SCOPE_OUTSIDE_TASK");
  });

  it("rejects comparing a string with lt", async () => {
    const spec = twoAgentSpec();
    const list = steps(spec);
    list.length = 2;
    list.push(
      branchWith({
        condition: { op: "lt", left: { ref: { scope: "input", path: ["topic"] } }, right: { literal: 0 } },
      }),
    );
    expect(await codesOf(spec)).toContain("TYPE_MISMATCH");
  });

  it("rejects $ref in an agent schema instead of dropping it", async () => {
    const spec = minimalSpec();
    (spec["assets"] as Raw)["schemas"] = {
      Facts: { type: "object", additionalProperties: false, properties: { facts: { $ref: "#/$defs/x" } } },
    };
    expect(await codesOf(spec)).toContain("UNSUPPORTED_AGENT_SCHEMA");
  });

  it("rejects minLength in an agent schema", async () => {
    const spec = minimalSpec();
    (spec["assets"] as Raw)["schemas"] = {
      Facts: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", minLength: 3 } },
      },
    };
    const result = await compile(spec, IDENTITY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const diagnostic = result.diagnostics.find((d) => d.code === "UNSUPPORTED_AGENT_SCHEMA");
    expect(diagnostic?.fieldPath).toContain("minLength");
  });

  it("rejects oneOf in an agent schema", async () => {
    const spec = minimalSpec();
    (spec["assets"] as Raw)["schemas"] = {
      Facts: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { oneOf: [{ type: "string" }, { type: "number" }] } },
      },
    };
    expect(await codesOf(spec)).toContain("UNSUPPORTED_AGENT_SCHEMA");
  });

  it("rejects an array-rooted agent schema", async () => {
    const spec = minimalSpec();
    (spec["assets"] as Raw)["schemas"] = { Facts: { type: "array", items: { type: "string" } } };
    expect(await codesOf(spec)).toContain("UNSUPPORTED_AGENT_SCHEMA");
  });

  it("rejects a prompt that is missing its asset", async () => {
    const spec = minimalSpec();
    steps(spec)[0]!["prompt"] = "ghost";
    const parsed = parseSpec(spec);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostics.map((d) => d.code)).toContain("UNKNOWN_ASSET_KEY");
  });

  it("does not emit a script when analysis fails", async () => {
    const spec = minimalSpec();
    steps(spec).pop();
    const result = await compile(spec, IDENTITY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).not.toHaveProperty("script");
  });

  it("keeps analysis pure: the same input yields the same diagnostics twice", () => {
    const spec = minimalSpec();
    steps(spec).pop();
    const parsed = parseSpec(spec);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const first = analyzeWorkflow(parsed.spec);
    const second = analyzeWorkflow(cloneSpec(parsed.spec));
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) return;
    expect(first.diagnostics.map((d) => d.code)).toEqual(second.diagnostics.map((d) => d.code));
  });
});
