import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockEngine, createScenarioRuntime, defaultResponder, fakeExec } from "@workflow-forge/runtime";
import { buildFromCompiled, compileExample, loadFixture, tempDir } from "../support/helpers.js";

function runtimeWith(mock: ReturnType<typeof createMockEngine>, deadlineMs = 5_000) {
  return createScenarioRuntime({
    engine: mock.engine,
    config: { dataDir: tempDir("wf-cancel-"), hostVersion: "test", engineKind: "mock", deadlineMs },
  });
}

describe("cancellation, deadline and cleanup", () => {
  it("cancels before the engine starts and never creates an engine run", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine();
    const runtime = runtimeWith(mock);
    const controller = new AbortController();
    controller.abort("user cancelled");

    const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec({ signal: controller.signal }));
    expect(outcome.state).toBe("CANCELLED");
    expect(outcome.engineRunId).toBeNull();
    expect(outcome.engineStopReason).toBeNull();
    expect(outcome.reportPath).toBeNull();
    expect(mock.runIds).toHaveLength(0);
    expect(outcome.error?.code).toBe("WORKFLOW_CANCELLED");
  });

  it("cancels during the run, waits for dispose and leaves no active handle", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine({ delayMs: 40, responder: defaultResponder });
    const runtime = runtimeWith(mock);
    const controller = new AbortController();
    setTimeout(() => controller.abort("user cancelled"), 10);

    const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec({ signal: controller.signal }));
    expect(outcome.state).toBe("CANCELLED");
    expect(outcome.result).toBeNull();
    expect(outcome.reportPath).toBeNull();
    expect(mock.activeHandles).toBe(0);
    expect(mock.disposed).toHaveLength(1);
    expect(runtime.ownedCount).toBe(0);
  });

  it("turns the configured deadline into a distinct cancellation code", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine({ delayMs: 80, responder: defaultResponder });
    const runtime = runtimeWith(mock, 15);

    const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec());
    expect(outcome.state).toBe("CANCELLED");
    expect(outcome.error?.code).toBe("WORKFLOW_DEADLINE");
    expect(mock.activeHandles).toBe(0);
  });

  it("drains in-flight executions on plugin unload", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine({ delayMs: 40, responder: defaultResponder });
    const runtime = runtimeWith(mock);

    const pending = runtime.run(build, loadFixture("01-normal.json"), fakeExec());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.accepting).toBe(true);
    await runtime.shutdown("plugin unloading");

    const outcome = await pending;
    expect(outcome.state).toBe("CANCELLED");
    expect(runtime.accepting).toBe(false);
    expect(runtime.ownedCount).toBe(0);

    await expect(runtime.run(build, loadFixture("01-normal.json"), fakeExec())).rejects.toMatchObject({ code: "ADMISSION_CLOSED" });
  });

  it("reports UNKNOWN when dispose fails after a successful run", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine({ responder: defaultResponder, failDispose: true });
    const runtime = runtimeWith(mock);

    const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec());
    expect(outcome.state).toBe("UNKNOWN");
    expect(outcome.error?.code).toBe("CLEANUP_FAILED");
    expect(outcome.cleanupError).toContain("dispose");
    expect(mock.activeHandles).toBe(0);
  });

  it("does not rewrite a committed terminal state after a late cancel", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const mock = createMockEngine({ responder: defaultResponder });
    const runtime = runtimeWith(mock);
    const controller = new AbortController();

    const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec({ signal: controller.signal }));
    expect(outcome.state).toBe("COMPLETED");

    controller.abort("too late");
    const record = JSON.parse(readFileSync(join(outcome.runDir, "run.json"), "utf8")) as Record<string, unknown>;
    expect(record["state"]).toBe("COMPLETED");
    expect(record["businessStatus"]).toBe("completed");
  });
});
