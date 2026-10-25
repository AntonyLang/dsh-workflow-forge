import { describe, expect, it } from "vitest";
import { compile } from "@workflow-forge/compiler";
import { sha256Hex } from "@workflow-forge/spec";
import { IDENTITY, cloneSpec, compileExample, loadExampleSpec, minimalSpec } from "../support/helpers.js";

describe("compiler: positive path", () => {
  it("compiles the example and passes the mock self-check", async () => {
    const compiled = await compileExample();
    expect(compiled.staticReport.selfCheck).toBe("passed");
    expect(compiled.staticReport.worstCaseAgents).toBe(5);
    expect(compiled.staticReport.nodeCount).toBe(7);
    expect(compiled.staticReport.errors).toBe(0);
    expect(compiled.draftHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("emits fixed templates rather than user code", async () => {
    const compiled = await compileExample();
    const script = compiled.script;
    expect(script).toContain('for (let __i = 0; __i < args["materials"].length; __i += 2)');
    expect(script).toContain("await parallel(");
    expect(script).toContain('collectEvidence(args["materials"], v0)');
    expect(script).toContain('if (lt(v1["successCount"], args["minSuccessful"]))');
    expect(script).toContain('return finalize("insufficient_input"');
    expect(script).toContain("runAssertRules({");
    expect(script).toContain('label: __item["id"]');
    expect(script).not.toMatch(/\bimport\s+/);
    expect(script).not.toMatch(/\brequire\s*\(/);
    expect(script).not.toContain("process.");
  });

  it("is deterministic for the same definition", async () => {
    const first = await compileExample();
    const second = await compileExample();
    expect(second.scriptHash).toBe(first.scriptHash);
    expect(second.specHash).toBe(first.specHash);
    expect(second.draftHash).toBe(first.draftHash);
    expect(second.script).toBe(first.script);
  });

  it("changes the draft identity when prompt bytes change", async () => {
    const base = await compileExample();
    const spec = cloneSpec(loadExampleSpec()) as Record<string, unknown>;
    const assets = spec["assets"] as Record<string, Record<string, string>>;
    assets["prompts"]!["synthesize"] = `${assets["prompts"]!["synthesize"]}\n补充一条要求。`;
    const changed = await compile(spec, IDENTITY);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.specHash).not.toBe(base.specHash);
    expect(changed.scriptHash).not.toBe(base.scriptHash);
    expect(changed.draftHash).not.toBe(base.draftHash);
  });

  it("materializes one asset file per prompt and schema", async () => {
    const compiled = await compileExample();
    const prompts = compiled.assets.filter((asset) => asset.kind === "prompt");
    const schemas = compiled.assets.filter((asset) => asset.kind === "schema");
    expect(prompts.map((asset) => asset.fileName).sort()).toEqual(["extract.md", "synthesize.md"]);
    expect(schemas.map((asset) => asset.fileName).sort()).toEqual(["Brief.json", "EvidenceExtract.json"]);
    for (const asset of compiled.assets) expect(asset.hash).toBe(sha256Hex(asset.content));
  });

  it("keeps the emitted script hash equal to the recorded bytes", async () => {
    const compiled = await compileExample();
    expect(compiled.scriptHash).toBe(sha256Hex(compiled.script));
  });

  it("records explicit defaults instead of injecting them silently", async () => {
    const spec = minimalSpec();
    const steps = spec["steps"] as Array<Record<string, unknown>>;
    steps[0] = {
      id: "extract",
      kind: "agent_map",
      items: { ref: { scope: "input", path: ["materials"] } },
      task: {
        prompt: "only",
        outputSchema: "Facts",
        bindings: { topic: { ref: { scope: "input", path: ["topic"] } } },
      },
    };
    steps[1] = { id: "done", kind: "result", status: "insufficient_input" };
    const result = await compile(spec, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.defaultsApplied).toContain("steps/extract/failurePolicy=collect");
  });
});
