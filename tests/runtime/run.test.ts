import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockEngine, createScenarioRuntime, defaultResponder, fakeExec, type WorkflowEngine } from "@workflow-forge/runtime";
import { buildFromCompiled, compileExample, loadFixture, tempDir } from "../support/helpers.js";

async function freshRuntime(engine: WorkflowEngine, dataDir = tempDir("wf-run-")) {
  return createScenarioRuntime({
    engine,
    config: { dataDir, hostVersion: "test", engineKind: "mock", deadlineMs: 5_000 },
  });
}

describe("scenario runtime: successful and insufficient runs", () => {
  it("completes a run and writes input, result, report and a run record", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine({ emitEvents: true });
    const runtime = await freshRuntime(mock.engine);
    const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec());

    expect(outcome.state).toBe("COMPLETED");
    expect(outcome.businessStatus).toBe("completed");
    expect(outcome.engineStopReason).toBe("completed");
    expect(outcome.agentsStarted).toBe(4);
    expect(outcome.reportPath).toBeTruthy();
    expect(outcome.result?.brief?.title).toBeTruthy();
    expect(outcome.result?.evidence.successCount).toBe(3);

    const kinds = outcome.artifacts.map((artifact) => artifact.kind).sort();
    expect(kinds).toEqual(["input", "report", "result"]);

    const report = readFileSync(outcome.reportPath!, "utf8");
    expect(report).toContain("## 结论");
    expect(report).toContain("## 来源片段");
    expect(report).toContain("## 未覆盖材料");
    expect(report).toContain("`m1:1`");

    const record = JSON.parse(readFileSync(join(outcome.runDir, "run.json"), "utf8")) as Record<string, unknown>;
    expect(record["state"]).toBe("COMPLETED");
    expect(record["engineKind"]).toBe("mock");
    expect(record["engineStopReason"]).toBe("completed");
    expect(record["businessStatus"]).toBe("completed");
    expect(record["inputHash"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record["specHash"]).toBe(build.manifest.specHash);
    expect(record["scriptHash"]).toBe(build.manifest.scriptHash);
    expect(record["deadlineMs"]).toBe(5_000);
    expect(record["finishedAt"]).toBeTruthy();
    expect(Array.isArray(record["checks"])).toBe(true);

    const rules = new Set(outcome.checks.map((check) => check.rule));
    expect([...rules].sort()).toEqual([
      "evidence_ids_exist",
      "evidence_set",
      "non_empty_brief",
      "required_dimensions",
      "result_size",
      "status_consistent",
    ]);
  });

  it("reports INSUFFICIENT_INPUT without a brief when too few materials pass", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine({ responder: () => null });
    const runtime = await freshRuntime(mock.engine);
    const outcome = await runtime.run(build, loadFixture("04-insufficient.json"), fakeExec());

    expect(outcome.state).toBe("INSUFFICIENT_INPUT");
    expect(outcome.businessStatus).toBe("insufficient_input");
    expect(outcome.result?.brief).toBeNull();
    expect(outcome.result?.failedMaterials).toHaveLength(2);
    const report = readFileSync(outcome.reportPath!, "utf8");
    expect(report).toContain("未生成报告");
    expect(report).not.toContain("## 逐维度比较");
  });

  it("keeps a failed material visible while other materials still produce a report", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine({
      responder: (context) => (context.label === "m3" ? null : defaultResponder(context)),
    });
    const runtime = await freshRuntime(mock.engine);
    const outcome = await runtime.run(build, loadFixture("03-partial-failure.json"), fakeExec());

    expect(outcome.state).toBe("COMPLETED");
    expect(outcome.result?.evidence.successCount).toBe(2);
    expect(outcome.result?.failedMaterials[0]?.materialId).toBe("m3");
    const report = readFileSync(outcome.reportPath!, "utf8");
    expect(report).toContain("`m3`");
    expect(report).toContain("NO_STRUCTURED_RESULT");
  });

  it("keeps results aligned when materials finish out of order", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine({
      // m1 is slowest, m2 fastest: completion order is reversed on purpose.
      delayMs: (context) => (context.label === "m1" ? 30 : context.label === "m2" ? 1 : 10),
    });
    const runtime = await freshRuntime(mock.engine);
    const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec());

    expect(outcome.state).toBe("COMPLETED");
    expect(outcome.result?.evidence.evidence.map((item) => item.evidenceId)).toEqual(["m1:1", "m2:1", "m3:1"]);
    expect(outcome.result?.evidence.evidence.map((item) => item.materialId)).toEqual(["m1", "m2", "m3"]);
    expect(outcome.result?.failedMaterials).toEqual([]);
  });

  it("fails the run when the brief cites an evidence id that does not exist", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine({
      responder: (context) =>
        context.label === "synthesize"
          ? {
              title: "伪造引用",
              dimensions: [{ dimension: "同步与离线", findings: [{ kind: "fact", text: "x", evidenceIds: ["m9:9"] }] }],
              conclusions: [{ kind: "fact", text: "y", evidenceIds: ["m9:9"] }],
            }
          : defaultResponder(context),
    });
    const runtime = await freshRuntime(mock.engine);
    const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec());

    expect(outcome.state).toBe("FAILED");
    expect(outcome.error?.code).toBe("ASSERTION_FAILED");
    expect(outcome.reportPath).toBeNull();
    expect(outcome.result).toBeNull();
    const record = JSON.parse(readFileSync(join(outcome.runDir, "run.json"), "utf8")) as Record<string, unknown>;
    expect(record["state"]).toBe("FAILED");
  });

  it("rejects an engine value that is not a ScenarioResult", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const engine: WorkflowEngine = {
      start: () => ({
        id: "stub-1",
        result: Promise.resolve({ stopReason: "completed", value: { status: "completed", brief: null } }),
        dispose: async () => {},
      }),
    };
    const runtime = await freshRuntime(engine);
    const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec());
    expect(outcome.state).toBe("FAILED");
    expect(outcome.error?.code).toBe("INVALID_RESULT");
  });

  it("classifies a keyword-bearing engine error as SCRIPT_ERROR, not a deadline", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const engine: WorkflowEngine = {
      start: () => ({
        id: "stub-2",
        result: Promise.resolve({
          stopReason: "error",
          error: "timeout: workflow deadline reached while cancelled provider call failed",
        }),
        dispose: async () => {},
      }),
    };
    const runtime = await freshRuntime(engine);
    const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec());
    expect(outcome.state).toBe("FAILED");
    expect(outcome.error?.code).toBe("SCRIPT_ERROR");
  });

  it("refuses to run without a caller agent", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine();
    const runtime = await freshRuntime(mock.engine);
    await expect(runtime.run(build, loadFixture("01-normal.json"), { signal: new AbortController().signal })).rejects.toMatchObject({
      code: "CALLER_AGENT_REQUIRED",
    });
    expect(mock.runIds).toHaveLength(0);
  });

  it("rejects invalid input before the engine starts, but still records the run", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine();
    const runtime = await freshRuntime(mock.engine);
    const outcome = await runtime.run(build, { topic: "", materials: [] }, fakeExec());

    expect(outcome.state).toBe("FAILED");
    expect(outcome.error?.code).toBe("INPUT_INVALID");
    expect(mock.runIds).toHaveLength(0);
    const kinds = outcome.artifacts.map((artifact) => artifact.kind).sort();
    expect(kinds).toEqual(["diagnostics", "input"]);
    const record = JSON.parse(readFileSync(join(outcome.runDir, "run.json"), "utf8")) as Record<string, unknown>;
    expect(record["state"]).toBe("FAILED");
    expect(record["inputHash"]).toBeNull();
  });
});
