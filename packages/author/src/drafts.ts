/**
 * Candidate (draft) storage.
 *
 * `forge_validate` only stores a candidate that passed static analysis and the
 * self-check. The directory name is the draft hash, so the same content and the
 * same implementation snapshot always resolve to the same draft identity.
 */
import { join } from "node:path";
import type { JsonValue, WorkflowSpec } from "@workflow-forge/spec";
import { DIAGNOSTIC_CODES } from "@workflow-forge/spec";
import type { MaterializedAsset, StaticReport } from "@workflow-forge/compiler";
import { FileStore, ScenarioError, stripHashPrefix } from "@workflow-forge/runtime";

export type StoredDraft = {
  recordVersion: "0.1";
  draftRef: string;
  draftHash: string;
  specHash: string;
  scriptHash: string;
  compilerVersion: string;
  runtimeVersion: string;
  runtimeArtifactHash: string;
  checksHash: string;
  targetAdapterVersion: string;
  savedAt: string;
  assets: Array<{ kind: "prompt" | "schema"; key: string; fileName: string; hash: string }>;
  staticReport: StaticReport;
  spec: WorkflowSpec;
  script: string;
  meta: { name: string; phases: string[] };
  dir: string;
};

export type SaveDraftInput = {
  draftHash: string;
  specHash: string;
  scriptHash: string;
  compilerVersion: string;
  runtimeVersion: string;
  runtimeArtifactHash: string;
  checksHash: string;
  targetAdapterVersion: string;
  spec: WorkflowSpec;
  script: string;
  meta: { name: string; phases: string[] };
  assets: MaterializedAsset[];
  staticReport: StaticReport;
};

export class DraftStore {
  constructor(
    private readonly store: FileStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  dir(draftRef: string): string {
    return this.store.draftDir(draftRef);
  }

  save(input: SaveDraftInput): StoredDraft {
    const dir = this.store.ensureDir(this.store.draftDir(input.draftHash));
    this.store.writeTextAtomic(join(dir, "workflow.js"), input.script);
    this.store.writeTextAtomic(join(dir, "workflow.json"), JSON.stringify(input.spec, null, 2) + "\n");
    this.store.writeJsonAtomic(join(dir, "static-report.json"), input.staticReport as unknown as JsonValue);

    for (const asset of input.assets) {
      const sub = asset.kind === "prompt" ? "prompts" : "schemas";
      this.store.writeTextAtomic(join(dir, sub, asset.fileName), asset.content);
    }

    const record = {
      recordVersion: "0.1" as const,
      draftRef: input.draftHash,
      draftHash: input.draftHash,
      specHash: input.specHash,
      scriptHash: input.scriptHash,
      compilerVersion: input.compilerVersion,
      runtimeVersion: input.runtimeVersion,
      runtimeArtifactHash: input.runtimeArtifactHash,
      checksHash: input.checksHash,
      targetAdapterVersion: input.targetAdapterVersion,
      savedAt: this.now().toISOString(),
      assets: input.assets.map(({ kind, key, fileName, hash }) => ({ kind, key, fileName, hash })),
    };
    this.store.writeJsonAtomic(join(dir, "draft.json"), record as unknown as JsonValue);

    return {
      ...record,
      staticReport: input.staticReport,
      spec: input.spec,
      script: input.script,
      meta: input.meta,
      dir,
    };
  }

  load(draftRef: string): StoredDraft {
    const dir = this.store.draftDir(draftRef);
    const recordPath = join(dir, "draft.json");
    if (!this.store.exists(recordPath)) {
      throw new ScenarioError(DIAGNOSTIC_CODES.DRAFT_NOT_FOUND, `no candidate stored for ${draftRef}`);
    }
    const record = this.store.readJson(recordPath) as Record<string, JsonValue>;
    const spec = this.store.readJson(join(dir, "workflow.json")) as unknown as WorkflowSpec;
    const staticReport = this.store.readJson(join(dir, "static-report.json")) as unknown as StaticReport;
    return {
      recordVersion: "0.1",
      draftRef: String(record["draftRef"]),
      draftHash: String(record["draftHash"]),
      specHash: String(record["specHash"]),
      scriptHash: String(record["scriptHash"]),
      compilerVersion: String(record["compilerVersion"]),
      runtimeVersion: String(record["runtimeVersion"]),
      runtimeArtifactHash: String(record["runtimeArtifactHash"]),
      checksHash: String(record["checksHash"]),
      targetAdapterVersion: String(record["targetAdapterVersion"]),
      savedAt: String(record["savedAt"]),
      assets: (record["assets"] ?? []) as unknown as StoredDraft["assets"],
      staticReport,
      spec,
      script: this.store.readText(join(dir, "workflow.js")),
      meta: { name: spec.workflowId, phases: staticReport.agents.map((agent) => agent.id) },
      dir,
    };
  }

  exists(draftRef: string): boolean {
    try {
      return this.store.exists(join(this.store.draftDir(draftRef), "draft.json"));
    } catch {
      return false;
    }
  }

  /** Draft directories, newest first (directory name only). */
  listRefs(): string[] {
    const root = this.store.resolveInside("drafts");
    return this.store
      .listDir(root)
      .sort()
      .reverse()
      .map((name) => `sha256:${name}`);
  }
}

export function draftDirName(draftHash: string): string {
  return stripHashPrefix(draftHash);
}
