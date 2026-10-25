/**
 * Immutable build snapshot loaded at run time.
 *
 * The script bytes are hashed again when they are loaded: a build whose files do
 * not match its manifest is refused instead of quietly running something else.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIAGNOSTIC_CODES, sha256Hex, type JsonValue } from "@workflow-forge/spec";
import { ScenarioError } from "./errors.js";
import { RUNTIME_VERSION, TARGET_ADAPTER_VERSION } from "./version.js";

export type BuildVerificationState = "packaged" | "installed" | "runtime_verified";

export type BuildAssetRef = { kind: "prompt" | "schema"; key: string; fileName: string; hash: string };

export type BuildTrialRef = { runId: string; inputHash: string; state: string; businessStatus: string | null };

export type BuildManifest = {
  manifestVersion: "0.1";
  workflowId: string;
  workflowVersion: string;
  specVersion: string;
  specHash: string;
  draftHash: string;
  scriptHash: string;
  assetsHash: string;
  checksHash: string;
  runtimeArtifactHash: string;
  compilerVersion: string;
  runtimeVersion: string;
  targetAdapterVersion: string;
  limits: { maxMaterials: number; mapConcurrency: number; maxDirectAgents: number };
  worstCaseAgents: number;
  agents: Array<{ id: string; kind: string; schemaKey: string }>;
  prompts: BuildAssetRef[];
  schemas: BuildAssetRef[];
  trials: BuildTrialRef[];
  verification: { state: BuildVerificationState; runtimeVerified: boolean; notes: string[] };
  builtAt: string;
};

export type LoadedBuild = {
  manifest: BuildManifest;
  script: string;
  meta: { name: string; phases: string[] };
  assetsDir: string;
};

export function loadBuild(assetsDir: string): LoadedBuild {
  const manifestPath = join(assetsDir, "build.json");
  const scriptPath = join(assetsDir, "workflow.js");
  if (!existsSync(manifestPath) || !existsSync(scriptPath)) {
    throw new ScenarioError(
      "BUILD_NOT_FOUND",
      `scenario assets are incomplete in ${assetsDir}; expected build.json and workflow.js`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BuildManifest;
  const script = readFileSync(scriptPath, "utf8");
  const actual = sha256Hex(script);
  if (actual !== manifest.scriptHash) {
    throw new ScenarioError(
      "BUILD_HASH_MISMATCH",
      `workflow.js hash ${actual} does not match the manifest hash ${manifest.scriptHash}`,
    );
  }
  if (manifest.runtimeVersion !== RUNTIME_VERSION) {
    throw new ScenarioError(
      "BUILD_HASH_MISMATCH",
      `build was produced for runtime ${manifest.runtimeVersion}, this runtime is ${RUNTIME_VERSION}`,
    );
  }
  return {
    manifest,
    script,
    meta: { name: manifest.workflowId, phases: manifest.agents.map((agent) => agent.id) },
    assetsDir,
  };
}

export function describeManifest(manifest: BuildManifest): JsonValue {
  return {
    workflowId: manifest.workflowId,
    version: manifest.workflowVersion,
    draftHash: manifest.draftHash,
    specHash: manifest.specHash,
    scriptHash: manifest.scriptHash,
    verification: manifest.verification.state,
    targetAdapterVersion: manifest.targetAdapterVersion,
    adapter: TARGET_ADAPTER_VERSION,
  } as JsonValue;
}

export function assertManifestTarget(manifest: BuildManifest): void {
  if (manifest.targetAdapterVersion !== TARGET_ADAPTER_VERSION) {
    throw new ScenarioError(
      DIAGNOSTIC_CODES.BUILD_HASH_MISMATCH,
      `build targets adapter ${manifest.targetAdapterVersion}; this runtime implements ${TARGET_ADAPTER_VERSION}`,
    );
  }
}
