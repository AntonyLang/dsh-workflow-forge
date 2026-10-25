import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAuthorTools } from "@workflow-forge/author";
import {
  createMockEngine,
  createScenarioRuntime,
  defaultResponder,
  fakeExec,
  loadBuild,
} from "@workflow-forge/runtime";
import type { JsonValue } from "@workflow-forge/spec";
import { loadExampleSpec, loadFixture, tempDir } from "../support/helpers.js";

function responder(context: Parameters<typeof defaultResponder>[0]): JsonValue | null {
  const args = context.args as Record<string, JsonValue>;
  const topic = typeof args["topic"] === "string" ? (args["topic"] as string) : "";
  if (topic.includes("两个方案")) return null;
  return defaultResponder(context);
}

async function setup() {
  const dataDir = tempDir("wf-e2e-");
  const outputDir = tempDir("wf-e2e-out-");
  const mock = createMockEngine({ responder, emitEvents: true });
  const author = createAuthorTools({
    dataDir,
    outputDir,
    engine: mock.engine,
    engineKind: "mock",
    hostVersion: "integration-test",
    profile: { packageName: "dsh-scenario-source-brief" },
  });
  const exec = fakeExec();
  async function call(name: string, args: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
    const tool = author.tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return (await tool.execute(args, exec)) as Record<string, JsonValue>;
  }
  return { author, call, dataDir, outputDir, mock };
}

describe("author -> trial -> package -> installed scenario", () => {
  it("carries a candidate through the whole chain and runs without the author plugin", async () => {
    const { author, call, dataDir, mock } = await setup();

    const validated = await call("forge_validate", { spec: loadExampleSpec() });
    expect(validated["ok"]).toBe(true);
    const draftRef = String(validated["draftRef"]);
    expect(draftRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((validated["staticReport"] as Record<string, JsonValue>)["selfCheck"]).toBe("passed");

    const first = await call("forge_trial", { draftRef, input: loadFixture("01-normal.json") });
    const second = await call("forge_trial", { draftRef, input: loadFixture("02-conflicting.json") });
    const insufficient = await call("forge_trial", { draftRef, input: loadFixture("04-insufficient.json") });
    expect(first["state"]).toBe("COMPLETED");
    expect(second["state"]).toBe("COMPLETED");
    expect(insufficient["state"]).toBe("INSUFFICIENT_INPUT");
    expect(first["inputHash"]).not.toBe(second["inputHash"]);

    const tooFew = await call("forge_package", { draftRef, trialRunIds: [String(first["runId"])] });
    expect(tooFew["ok"]).toBe(false);

    const packaged = await call("forge_package", { draftRef });
    expect(packaged["ok"]).toBe(true);
    const packageDir = String(packaged["bundleDir"]);
    const buildHash = String(packaged["buildHash"]);
    expect((packaged["verification"] as Record<string, JsonValue>)["state"]).toBe("packaged");

    // The shipped bundle must not contain author tooling.
    const bundled = readFileSync(join(packageDir, "dist", "index.js"), "utf8");
    expect(bundled).not.toContain("forge_validate");
    expect(bundled).not.toContain("packages/author");

    // The run-time build is the packaged asset directory, hash-verified on load.
    const build = loadBuild(join(packageDir, "assets"));
    expect(build.manifest.verification.state).toBe("packaged");
    expect(build.script).toContain("await parallel(");

    // Simulate a fresh session: author plugin is gone, new data directory.
    await author.shutdown();
    const fresh = createScenarioRuntime({
      engine: mock.engine,
      config: { dataDir: tempDir("wf-e2e-fresh-"), hostVersion: "integration-test", engineKind: "mock" },
    });
    const outcome = await fresh.run(build, loadFixture("05-second-topic.json"), fakeExec());
    expect(outcome.state).toBe("COMPLETED");
    expect(outcome.result?.brief).toBeTruthy();
    expect(outcome.result?.evidence.successCount).toBe(2);
    const report = readFileSync(outcome.reportPath!, "utf8");
    expect(report).toContain("连接稳定性");

    const inspectedDraft = await call("forge_inspect", { kind: "draft", id: draftRef });
    expect(inspectedDraft["kind"]).toBe("draft");
    const inspectedRun = await call("forge_inspect", { kind: "run", id: String(first["runId"]) });
    expect((inspectedRun["record"] as Record<string, JsonValue>)["state"]).toBe("COMPLETED");
    const inspectedBuild = await call("forge_inspect", { kind: "build", id: buildHash });
    expect((inspectedBuild["report"] as Record<string, JsonValue>)["buildHash"]).toBe(buildHash);

    // Trials and drafts live under the plugin data directory, not in the package.
    expect(mock.calls.length).toBeGreaterThan(0);
    const draft = author.draftStore.load(draftRef);
    expect(draft.dir.startsWith(dataDir)).toBe(true);
    expect(author.trialStore.list(draft.dir)).toHaveLength(3);
  }, 30_000);

  it("refuses to package a candidate whose trials came from changed assets", async () => {
    const { call, author } = await setup();
    const validated = await call("forge_validate", { spec: loadExampleSpec() });
    const draftRef = String(validated["draftRef"]);
    await call("forge_trial", { draftRef, input: loadFixture("01-normal.json") });
    await call("forge_trial", { draftRef, input: loadFixture("02-conflicting.json") });

    // Simulate a prompt edit that changes the script but not the stored trial bytes.
    const draft = author.draftStore.load(draftRef);
    const trialDir = join(draft.dir, "trials");
    for (const name of author.store.listFiles(trialDir)) {
      const path = join(trialDir, name);
      const record = author.store.readJson(path) as unknown as Record<string, JsonValue>;
      record["scriptHash"] = "sha256:stale";
      author.store.writeJsonAtomic(path, record as JsonValue);
    }

    const packaged = await call("forge_package", { draftRef });
    expect(packaged["ok"]).toBe(false);
    const diagnostics = packaged["diagnostics"] as Array<Record<string, JsonValue>>;
    expect(diagnostics.some((entry) => entry["code"] === "TRIAL_IDENTITY_MISMATCH")).toBe(true);
  }, 30_000);
});
