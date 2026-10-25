import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  FileStore,
  createMockEngine,
  createRunRecord,
  createScenarioRuntime,
  defaultResponder,
  fakeExec,
  recoverRuns,
  runRecordPath,
} from "@workflow-forge/runtime";
import { buildFromCompiled, compileExample, loadFixture, tempDir } from "../support/helpers.js";

describe("records and storage", () => {
  it("writes atomically and leaves no temp file behind", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const dataDir = tempDir("wf-store-");
    const mock = createMockEngine({ responder: defaultResponder });
    const runtime = createScenarioRuntime({ engine: mock.engine, config: { dataDir, engineKind: "mock" } });
    const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec());

    const leftovers = readdirSync(outcome.runDir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    const record = JSON.parse(readFileSync(runRecordPath(outcome.runDir), "utf8")) as Record<string, unknown>;
    expect(record["recordVersion"]).toBe("0.1");
  });

  it("marks runs left non-terminal by another host boot as INTERRUPTED", () => {
    const dataDir = tempDir("wf-recover-");
    const store = new FileStore(dataDir);
    const runDir = store.ensureDir(store.runDir("20260101T000000Z-abcdef"));
    const record = createRunRecord({
      runId: "20260101T000000Z-abcdef",
      workflowId: "source-brief",
      workflowVersion: "0.1.0",
      specHash: "sha256:x",
      draftHash: "sha256:y",
      scriptHash: "sha256:z",
      runtimeArtifactHash: "sha256:r",
      checksHash: "sha256:c",
      compilerVersion: "0.1.0",
      runtimeVersion: "0.1.0",
      hostVersion: "test",
      hostBootId: "boot-old",
      engineKind: "mock",
      deadlineMs: 1_000,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    record.state = "RUNNING";
    store.writeJsonAtomic(runRecordPath(runDir), record as never);

    const report = recoverRuns(store, "boot-new");
    expect(report.scanned).toBe(1);
    expect(report.interrupted).toEqual(["20260101T000000Z-abcdef"]);

    const updated = store.readJson(runRecordPath(runDir)) as unknown as Record<string, unknown>;
    expect(updated["state"]).toBe("INTERRUPTED");
    expect(String((updated["error"] as Record<string, unknown>)["code"])).toBe("INTERRUPTED");
    expect(updated["finishedAt"]).toBeTruthy();
  });

  it("leaves terminal records from another boot untouched", () => {
    const dataDir = tempDir("wf-recover-terminal-");
    const store = new FileStore(dataDir);
    const runDir = store.ensureDir(store.runDir("20260101T000000Z-fedcba"));
    const record = createRunRecord({
      runId: "20260101T000000Z-fedcba",
      workflowId: "source-brief",
      workflowVersion: "0.1.0",
      specHash: "sha256:x",
      draftHash: "sha256:y",
      scriptHash: "sha256:z",
      runtimeArtifactHash: "sha256:r",
      checksHash: "sha256:c",
      compilerVersion: "0.1.0",
      runtimeVersion: "0.1.0",
      hostVersion: "test",
      hostBootId: "boot-old",
      engineKind: "mock",
      deadlineMs: 1_000,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    record.state = "COMPLETED";
    store.writeJsonAtomic(runRecordPath(runDir), record as never);

    const report = recoverRuns(store, "boot-new");
    expect(report.interrupted).toEqual([]);
    expect((store.readJson(runRecordPath(runDir)) as unknown as Record<string, unknown>)["state"]).toBe("COMPLETED");
  });

  it("rejects path escapes and keeps hash directories filesystem-safe", () => {
    const store = new FileStore(tempDir("wf-path-"));
    expect(() => store.resolveInside("..", "outside")).toThrow(/escapes/i);
    expect(() => store.draftDir("../escape")).toThrow();
    const dir = store.draftDir("sha256:abcdef");
    expect(dir.endsWith("abcdef")).toBe(true);
    expect(dir).not.toContain("sha256:");
  });

  it("keeps one record per run under runs/", async () => {
    const compiled = await compileExample();
    const build = buildFromCompiled(compiled);
    const dataDir = tempDir("wf-runs-");
    const mock = createMockEngine({ responder: defaultResponder });
    const runtime = createScenarioRuntime({ engine: mock.engine, config: { dataDir, engineKind: "mock" } });
    const first = await runtime.run(build, loadFixture("01-normal.json"), fakeExec());
    const second = await runtime.run(build, loadFixture("02-conflicting.json"), fakeExec());
    expect(first.runId).not.toBe(second.runId);
    const store = new FileStore(dataDir);
    expect(store.listRunIds().length).toBe(2);
  });
});
