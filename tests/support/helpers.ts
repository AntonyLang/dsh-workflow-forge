import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, type CompileSuccess } from "@workflow-forge/compiler";
import type { JsonValue, WorkflowSpec } from "@workflow-forge/spec";
import type { BuildManifest, LoadedBuild } from "@workflow-forge/runtime";

export const IDENTITY = {
  runtimeArtifactHash: "sha256:test-runtime-artifact",
  checksHash: "sha256:test-checks",
  targetAdapterVersion: "test-adapter@0.1.0",
};

const root = process.cwd();

export function loadExampleSpec(): JsonValue {
  return JSON.parse(readFileSync(join(root, "examples", "source-brief", "spec.json"), "utf8")) as JsonValue;
}

export function loadFixture(name: string): JsonValue {
  return JSON.parse(readFileSync(join(root, "examples", "source-brief", "fixtures", name), "utf8")) as JsonValue;
}

export function tempDir(prefix = "workflow-forge-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function compileExample(overrides: Record<string, unknown> = {}): Promise<CompileSuccess> {
  const spec = { ...(loadExampleSpec() as Record<string, JsonValue>), ...(overrides as Record<string, JsonValue>) };
  const result = await compile(spec, IDENTITY);
  if (!result.ok) {
    throw new Error(`example spec failed to compile:\n${result.diagnostics.map((d) => `${d.code} ${d.fieldPath} ${d.message}`).join("\n")}`);
  }
  return result;
}

export function buildFromCompiled(compiled: CompileSuccess, overrides: Partial<BuildManifest> = {}): LoadedBuild {
  const manifest: BuildManifest = {
    manifestVersion: "0.1",
    workflowId: compiled.workflow.spec.workflowId,
    workflowVersion: compiled.workflow.spec.version,
    specVersion: compiled.workflow.spec.specVersion,
    specHash: compiled.specHash,
    draftHash: compiled.draftHash ?? "sha256:test-draft",
    scriptHash: compiled.scriptHash,
    assetsHash: compiled.specHash,
    checksHash: IDENTITY.checksHash,
    runtimeArtifactHash: IDENTITY.runtimeArtifactHash,
    compilerVersion: "0.1.0",
    runtimeVersion: "0.1.0",
    targetAdapterVersion: IDENTITY.targetAdapterVersion,
    limits: compiled.workflow.spec.limits,
    worstCaseAgents: compiled.workflow.worstCaseAgents,
    agents: compiled.staticReport.agents,
    prompts: compiled.assets
      .filter((asset) => asset.kind === "prompt")
      .map((asset) => ({ kind: "prompt" as const, key: asset.key, fileName: asset.fileName, hash: asset.hash })),
    schemas: compiled.assets
      .filter((asset) => asset.kind === "schema")
      .map((asset) => ({ kind: "schema" as const, key: asset.key, fileName: asset.fileName, hash: asset.hash })),
    trials: [],
    verification: { state: "packaged", runtimeVerified: false, notes: ["test"] },
    builtAt: "2026-10-25T00:00:00.000Z",
    ...overrides,
  };
  return { manifest, script: compiled.script, meta: compiled.meta, assetsDir: tempDir("workflow-forge-assets-") };
}

/** Minimal valid spec used by negative tests; every case mutates one part. */
export function minimalSpec(): Record<string, JsonValue> {
  return {
    specVersion: "0.1",
    workflowId: "tiny-flow",
    version: "0.1.0",
    inputContract: "source-brief-input@1",
    normalizedInputContract: "source-brief-normalized@1",
    outputContract: "source-brief-result@1",
    limits: { maxMaterials: 2, mapConcurrency: 2, maxDirectAgents: 3 },
    assets: {
      prompts: { only: "topic: {{topic}}" },
      schemas: {
        Facts: {
          type: "object",
          additionalProperties: false,
          required: ["facts"],
          properties: { facts: { type: "array", items: { type: "string" } } },
        },
      },
    },
    steps: [
      {
        id: "extract",
        kind: "agent",
        prompt: "only",
        outputSchema: "Facts",
        bindings: { topic: { ref: { scope: "input", path: ["topic"] } } },
      },
      { id: "done", kind: "result", status: "completed", value: { checks: { literal: [] } } },
    ],
  } as unknown as Record<string, JsonValue>;
}

export function cloneSpec<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type { WorkflowSpec };
