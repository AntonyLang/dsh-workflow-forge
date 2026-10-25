import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageScenario, updateVerification, type DraftSnapshot, type TrialRecord } from "@workflow-forge/packager";
import { compileExample, IDENTITY, tempDir } from "../support/helpers.js";

async function snapshot(overrides: Partial<DraftSnapshot> = {}): Promise<DraftSnapshot> {
  const compiled = await compileExample();
  return {
    draftRef: compiled.draftHash ?? "sha256:draft",
    draftHash: compiled.draftHash ?? "sha256:draft",
    spec: compiled.workflow.spec,
    specHash: compiled.specHash,
    script: compiled.script,
    scriptHash: compiled.scriptHash,
    meta: compiled.meta,
    assets: compiled.assets,
    staticReport: compiled.staticReport,
    compilerVersion: "0.1.0",
    runtimeVersion: "0.1.0",
    runtimeArtifactHash: IDENTITY.runtimeArtifactHash,
    checksHash: IDENTITY.checksHash,
    targetAdapterVersion: IDENTITY.targetAdapterVersion,
    ...overrides,
  };
}

function trial(draft: DraftSnapshot, inputHash: string, overrides: Partial<TrialRecord> = {}): TrialRecord {
  return {
    runId: `run-${inputHash}`,
    draftHash: draft.draftHash,
    specHash: draft.specHash,
    scriptHash: draft.scriptHash,
    runtimeArtifactHash: draft.runtimeArtifactHash,
    checksHash: draft.checksHash,
    compilerVersion: draft.compilerVersion,
    inputHash,
    state: "COMPLETED",
    businessStatus: "completed",
    engineKind: "mock",
    startedAt: "2026-10-25T00:00:00.000Z",
    reportPath: null,
    ...overrides,
  };
}

function codesOf(result: Awaited<ReturnType<typeof packageScenario>>): string[] {
  return result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe("packaging", () => {
  it("requires at least two trials", async () => {
    const draft = await snapshot();
    const result = await packageScenario({ draft, trials: [trial(draft, "sha256:a")], outputDir: tempDir("wf-pkg-") });
    expect(codesOf(result)).toContain("TRIAL_REQUIRED");
  });

  it("requires two genuinely different inputs", async () => {
    const draft = await snapshot();
    const result = await packageScenario({
      draft,
      trials: [trial(draft, "sha256:a"), trial(draft, "sha256:a", { runId: "run-2" })],
      outputDir: tempDir("wf-pkg-"),
    });
    expect(codesOf(result)).toContain("TRIAL_INPUTS_NOT_DISTINCT");
  });

  it("refuses a trial that did not pass", async () => {
    const draft = await snapshot();
    const result = await packageScenario({
      draft,
      trials: [trial(draft, "sha256:a"), trial(draft, "sha256:b", { state: "FAILED", businessStatus: null })],
      outputDir: tempDir("wf-pkg-"),
    });
    expect(codesOf(result)).toContain("TRIAL_NOT_PASSED");
  });

  it("refuses trials from another draft or implementation snapshot", async () => {
    const draft = await snapshot();
    const stale = trial(draft, "sha256:a", { draftHash: "sha256:old" });
    const staleRuntime = trial(draft, "sha256:b", { runtimeArtifactHash: "sha256:old-runtime" });
    const result = await packageScenario({ draft, trials: [stale, staleRuntime], outputDir: tempDir("wf-pkg-") });
    expect(codesOf(result)).toContain("TRIAL_IDENTITY_MISMATCH");
  });

  it("refuses an invalid static report", async () => {
    const draft = await snapshot({ staticReport: { ...(await snapshot()).staticReport, selfCheck: "failed" } });
    const result = await packageScenario({
      draft,
      trials: [trial(draft, "sha256:a"), trial(draft, "sha256:b")],
      outputDir: tempDir("wf-pkg-"),
    });
    expect(codesOf(result)).toContain("STATIC_REPORT_INVALID");
  });

  it("builds a versioned package with assets, skill, dist and a manifest", async () => {
    const draft = await snapshot();
    const outputDir = tempDir("wf-pkg-");
    const result = await packageScenario({
      draft,
      trials: [trial(draft, "sha256:a"), trial(draft, "sha256:b")],
      outputDir,
      examples: [{ path: "examples/fixtures/01-normal.json", content: "{}\n" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.buildHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.verification.state).toBe("packaged");
    expect(result.verification.runtimeVerified).toBe(false);
    expect(result.verification.notes[0]).toContain("mock engine");

    for (const file of [
      "package.json",
      "cordis.patch.yml",
      "dist/index.js",
      "assets/workflow.js",
      "assets/workflow.json",
      "assets/build.json",
      "assets/prompts/extract.md",
      "assets/schemas/Brief.json",
      "skills/source-brief/SKILL.md",
      "README.md",
      "LICENSE",
      "examples/fixtures/01-normal.json",
    ]) {
      expect(existsSync(join(result.packageDir, file)), file).toBe(true);
    }

    const manifest = JSON.parse(readFileSync(join(result.packageDir, "assets", "build.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["buildHash"]).toBeUndefined();
    expect(manifest["scriptHash"]).toBe(draft.scriptHash);
    expect(manifest["draftHash"]).toBe(draft.draftHash);
    expect(manifest["targetAdapterVersion"]).toBe(draft.targetAdapterVersion);
    expect((manifest["trials"] as unknown[]).length).toBe(2);

    const pkg = JSON.parse(readFileSync(join(result.packageDir, "package.json"), "utf8")) as Record<string, unknown>;
    expect((pkg["engines"] as Record<string, unknown>)["dsh"]).toBeTruthy();
    expect((pkg["peerDependencies"] as Record<string, unknown>)["@deepseek-ai/dsh-workflow"]).toBeTruthy();
    expect((pkg["dsh"] as Record<string, unknown>)["bundle"]).toBeTruthy();
    expect(readFileSync(join(result.packageDir, "cordis.patch.yml"), "utf8")).toContain("insert:");

    const bundled = (await import(pathToFileURL(join(result.packageDir, "dist", "index.js")).href)) as Record<string, unknown>;
    expect(typeof bundled["apply"]).toBe("function");
    expect(bundled["name"]).toBe("dsh-scenario-source-brief");
    expect(bundled["inject"]).toEqual(["workflowEngine"]);
  });

  it("derives the same build hash regardless of timestamps and trial summary", async () => {
    const draft = await snapshot();
    const outputDir = tempDir("wf-pkg-");
    const two = await packageScenario({
      draft,
      trials: [trial(draft, "sha256:a"), trial(draft, "sha256:b")],
      outputDir,
      now: () => new Date("2026-10-25T00:00:00.000Z"),
    });
    const three = await packageScenario({
      draft,
      trials: [trial(draft, "sha256:a"), trial(draft, "sha256:b"), trial(draft, "sha256:c")],
      outputDir,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(two.ok && three.ok).toBe(true);
    if (!two.ok || !three.ok) return;
    expect(three.buildHash).toBe(two.buildHash);
    expect(three.packageDir).toBe(two.packageDir);
    expect(three.manifest.trials.length).toBe(3);
    expect(two.manifest.trials.length).toBe(2);
  });

  it("records verification state transitions without touching the build hash", async () => {
    const draft = await snapshot();
    const result = await packageScenario({
      draft,
      trials: [trial(draft, "sha256:a"), trial(draft, "sha256:b")],
      outputDir: tempDir("wf-pkg-"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verification = updateVerification(result.packageDir, "runtime_verified", ["host trial passed"]);
    expect(verification.state).toBe("runtime_verified");
    expect(verification.runtimeVerified).toBe(true);
    const manifest = JSON.parse(readFileSync(join(result.packageDir, "assets", "build.json"), "utf8")) as Record<string, unknown>;
    expect((manifest["verification"] as Record<string, unknown>)["state"]).toBe("runtime_verified");
  });
});
