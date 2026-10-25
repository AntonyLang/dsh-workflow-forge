import { describe, expect, it } from "vitest";
import { parseSpec, specHash, draftIdentity } from "@workflow-forge/spec";
import { cloneSpec, loadExampleSpec, minimalSpec } from "../support/helpers.js";

function codesOf(raw: unknown): string[] {
  const result = parseSpec(raw);
  return result.ok ? [] : result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

describe("WorkflowSpec meta-schema and semantics", () => {
  it("accepts the shipped example", () => {
    const parsed = parseSpec(loadExampleSpec());
    expect(parsed.ok).toBe(true);
  });

  it("rejects an unknown field instead of dropping it", () => {
    const spec = loadExampleSpec() as Record<string, unknown>;
    spec["extraKnob"] = true;
    const result = parseSpec(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((d) => d.code === "UNKNOWN_FIELD")).toBe(true);
    expect(result.diagnostics[0]?.fieldPath).toContain("extraKnob");
  });

  it("rejects an unsupported specVersion", () => {
    const spec = loadExampleSpec() as Record<string, unknown>;
    spec["specVersion"] = "0.2";
    expect(codesOf(spec)).toContain("SPEC_INVALID");
  });

  it("rejects an unknown contract id", () => {
    const spec = loadExampleSpec() as Record<string, unknown>;
    spec["inputContract"] = "other-input@1";
    expect(codesOf(spec)).toContain("UNKNOWN_CONTRACT");
  });

  it("rejects map concurrency above the product cap", () => {
    const spec = loadExampleSpec() as Record<string, unknown>;
    (spec["limits"] as Record<string, unknown>)["mapConcurrency"] = 3;
    expect(codesOf(spec)).toContain("SPEC_INVALID");
  });

  it("rejects a prompt placeholder without a binding", () => {
    const spec = loadExampleSpec() as Record<string, unknown>;
    const assets = spec["assets"] as Record<string, Record<string, string>>;
    assets["prompts"]!["extract"] = `${assets["prompts"]!["extract"]}\n补充：{{missingKey}}`;
    expect(codesOf(spec)).toContain("PROMPT_BINDING_MISSING");
  });

  it("warns about an unused binding without failing the spec", () => {
    const spec = loadExampleSpec() as Record<string, unknown>;
    const steps = spec["steps"] as Array<Record<string, unknown>>;
    const task = (steps[0] as Record<string, unknown>)["task"] as Record<string, Record<string, unknown>>;
    task["bindings"]!["unused"] = { literal: "x" };
    const result = parseSpec(spec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.some((d) => d.code === "PROMPT_BINDING_UNUSED" && d.severity === "warning")).toBe(true);
  });

  it("rejects prototype-reaching path segments", () => {
    const spec = minimalSpec();
    const steps = spec["steps"] as Array<Record<string, unknown>>;
    (steps[0] as Record<string, unknown>)["bindings"] = { topic: { ref: { scope: "input", path: ["__proto__"] } } };
    expect(codesOf(spec)).toContain("FORBIDDEN_PATH_SEGMENT");
  });

  it("rejects duplicate node ids", () => {
    const spec = minimalSpec();
    const steps = spec["steps"] as Array<Record<string, unknown>>;
    steps[1]!["id"] = "extract";
    expect(codesOf(spec)).toContain("DUPLICATE_NODE_ID");
  });

  it("hashes definitions deterministically and independently of key order", () => {
    const first = parseSpec(loadExampleSpec());
    const second = parseSpec(loadExampleSpec());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(specHash(first.spec)).toBe(specHash(second.spec));

    const reordered = cloneSpec(loadExampleSpec()) as Record<string, unknown>;
    const entries = Object.entries(reordered).reverse();
    const rebuilt = Object.fromEntries(entries);
    const third = parseSpec(rebuilt);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(specHash(third.spec)).toBe(specHash(first.spec));
  });

  it("binds the draft identity to the implementation snapshot", () => {
    const parsed = parseSpec(loadExampleSpec());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const hash = specHash(parsed.spec);
    const base = { specHash: hash, compilerVersion: "0.1.0", runtimeArtifactHash: "r1", checksHash: "c1", targetAdapterVersion: "a1" };
    const other = draftIdentity({ ...base, checksHash: "c2" });
    expect(draftIdentity(base)).not.toBe(other);
  });
});
