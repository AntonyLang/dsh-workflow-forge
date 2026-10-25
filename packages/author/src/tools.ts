/**
 * The four deterministic author tools.
 *
 * Names are project-owned, not DSH built-ins. `forge_validate` writes the
 * candidate it just checked, `forge_trial` runs it through the real wrapper and
 * stores the trial next to the candidate, `forge_package` reads those stored
 * trials instead of trusting the caller, and `forge_inspect` only reads records
 * that exist.
 */
import { join } from "node:path";
import type { JsonValue } from "@workflow-forge/spec";
import { DIAGNOSTIC_CODES, sha256Hex } from "@workflow-forge/spec";
import { COMPILER_VERSION, compile } from "@workflow-forge/compiler";
import {
  RUNTIME_VERSION,
  TARGET_ADAPTER_VERSION,
  createScenarioRuntime,
  type LoadedBuild,
  type RunOutcome,
  type ScenarioRuntime,
  type ToolExecContext,
  type WorkflowEngine,
} from "@workflow-forge/runtime";
import { packageScenario, type DraftSnapshot, type TrialRecord } from "@workflow-forge/packager";
import { CHECKS_HASH, RUNTIME_ARTIFACT_HASH } from "./fingerprint.js";
import { DraftStore, type StoredDraft } from "./drafts.js";
import { TrialStore, type StoredTrial } from "./trials.js";
import { FileStore } from "@workflow-forge/runtime";

export type AuthorToolParameter = { type: string; required?: boolean; description: string };

export type AuthorToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, AuthorToolParameter>;
  execute(args: Record<string, JsonValue>, exec: ToolExecContext): Promise<JsonValue>;
};

export type AuthorProfile = {
  packageName?: string;
  skillBody?: string;
  readme?: string;
  licenseText?: string;
  dshVersion?: string;
  examples?: Array<{ path: string; content: string }>;
};

export type AuthorConfig = {
  dataDir: string;
  engine: WorkflowEngine;
  outputDir: string;
  deadlineMs?: number;
  hostVersion?: string;
  engineKind?: "host" | "mock";
  profile?: AuthorProfile;
  now?: () => Date;
};

export type AuthorApi = {
  store: FileStore;
  draftStore: DraftStore;
  trialStore: TrialStore;
  tools: AuthorToolSpec[];
  config: AuthorConfig;
  getRuntime(): ScenarioRuntime;
  shutdown(): Promise<void>;
};

export function createAuthorTools(config: AuthorConfig): AuthorApi {
  const now = config.now ?? (() => new Date());
  const store = new FileStore(config.dataDir);
  const draftStore = new DraftStore(store, now);
  const trialStore = new TrialStore(store, now);
  let runtime: ScenarioRuntime | null = null;

  const getRuntime = (): ScenarioRuntime => {
    if (!runtime) {
      runtime = createScenarioRuntime({
        engine: config.engine,
        store,
        config: {
          dataDir: config.dataDir,
          ...(config.deadlineMs !== undefined ? { deadlineMs: config.deadlineMs } : {}),
          ...(config.hostVersion !== undefined ? { hostVersion: config.hostVersion } : {}),
          engineKind: config.engineKind ?? "host",
          now,
        },
      });
    }
    return runtime;
  };

  const validate: AuthorToolSpec = {
    name: "forge_validate",
    description:
      "Static-check a WorkflowSpec 0.1 candidate (meta-schema, references, types, branch termination, agent budget, emitted-script syntax and a mock self-check) and SAVE it as an immutable candidate when it passes. Writes to the plugin data directory. Returns draftRef, draftHash, specHash, scriptHash and diagnostics with node/field locations.",
    parameters: {
      spec: { type: "object", required: true, description: "The WorkflowSpec 0.1 object, including inline prompts and schemas." },
    },
    async execute(args) {
      const raw = args["spec"];
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return toolError("TOOL_INPUT_INVALID", "spec must be a WorkflowSpec object");
      }
      const compiled = await compile(raw, {
        runtimeArtifactHash: RUNTIME_ARTIFACT_HASH,
        checksHash: CHECKS_HASH,
        targetAdapterVersion: TARGET_ADAPTER_VERSION,
      });
      if (!compiled.ok) {
        return {
          ok: false,
          diagnostics: compiled.diagnostics as unknown as JsonValue,
        };
      }
      const draft = draftStore.save({
        draftHash: compiled.draftHash ?? "",
        specHash: compiled.specHash,
        scriptHash: compiled.scriptHash,
        compilerVersion: COMPILER_VERSION,
        runtimeVersion: RUNTIME_VERSION,
        runtimeArtifactHash: RUNTIME_ARTIFACT_HASH,
        checksHash: CHECKS_HASH,
        targetAdapterVersion: TARGET_ADAPTER_VERSION,
        spec: compiled.workflow.spec,
        script: compiled.script,
        meta: compiled.meta,
        assets: compiled.assets,
        staticReport: compiled.staticReport,
      });
      return {
        ok: true,
        draftRef: draft.draftRef,
        draftHash: draft.draftHash,
        specHash: draft.specHash,
        scriptHash: draft.scriptHash,
        savedTo: draft.dir,
        staticReport: {
          selfCheck: compiled.staticReport.selfCheck,
          worstCaseAgents: compiled.staticReport.worstCaseAgents,
          nodeCount: compiled.staticReport.nodeCount,
          warnings: compiled.staticReport.warnings,
          notes: compiled.staticReport.selfCheckNotes,
        } as JsonValue,
        diagnostics: compiled.diagnostics as unknown as JsonValue,
      } as JsonValue;
    },
  };

  const trial: AuthorToolSpec = {
    name: "forge_trial",
    description:
      "Run a SAVED candidate (draftRef) on one input through the real wrapper and engine, then store the trial next to the candidate. Returns runId, state, checks and artifact paths. A run that is not COMPLETED can never support packaging.",
    parameters: {
      draftRef: { type: "string", required: true, description: "draftRef returned by forge_validate." },
      input: { type: "object", required: true, description: "Scenario input matching the public input contract." },
    },
    async execute(args, exec) {
      const draftRef = asString(args["draftRef"]);
      if (!draftRef) return toolError("TOOL_INPUT_INVALID", "draftRef is required");
      if (args["input"] === undefined) return toolError("TOOL_INPUT_INVALID", "input is required");
      let draft: StoredDraft;
      try {
        draft = draftStore.load(draftRef);
      } catch (error) {
        return toolError(DIAGNOSTIC_CODES.DRAFT_NOT_FOUND, describe(error));
      }
      if (sha256Hex(draft.script) !== draft.scriptHash) {
        return toolError(
          DIAGNOSTIC_CODES.TRIAL_IDENTITY_MISMATCH,
          "the stored script does not match its recorded hash; validate the candidate again",
        );
      }

      const build: LoadedBuild = {
        manifest: {
          manifestVersion: "0.1",
          workflowId: draft.spec.workflowId,
          workflowVersion: draft.spec.version,
          specVersion: draft.spec.specVersion,
          specHash: draft.specHash,
          draftHash: draft.draftHash,
          scriptHash: draft.scriptHash,
          assetsHash: draft.specHash,
          checksHash: draft.checksHash,
          runtimeArtifactHash: draft.runtimeArtifactHash,
          compilerVersion: draft.compilerVersion,
          runtimeVersion: draft.runtimeVersion,
          targetAdapterVersion: draft.targetAdapterVersion,
          limits: draft.spec.limits,
          worstCaseAgents: draft.staticReport.worstCaseAgents,
          agents: draft.staticReport.agents,
          prompts: draft.assets
            .filter((asset) => asset.kind === "prompt")
            .map((asset) => ({ kind: "prompt" as const, key: asset.key, fileName: asset.fileName, hash: asset.hash })),
          schemas: draft.assets
            .filter((asset) => asset.kind === "schema")
            .map((asset) => ({ kind: "schema" as const, key: asset.key, fileName: asset.fileName, hash: asset.hash })),
          trials: [],
          verification: { state: "packaged", runtimeVerified: false, notes: ["candidate trial"] },
          builtAt: draft.savedAt,
        },
        script: draft.script,
        meta: draft.meta,
        assetsDir: draft.dir,
      };

      const outcome = await getRuntime().run(build, args["input"], exec);
      const inputHash = readInputHash(store, outcome);
      const record: TrialRecord & {
        checks: StoredTrial["checks"];
        artifacts: string[];
        reportPath: string | null;
        resultPath: string | null;
        runDir: string;
      } = {
        runId: outcome.runId,
        draftHash: draft.draftHash,
        specHash: draft.specHash,
        scriptHash: draft.scriptHash,
        runtimeArtifactHash: draft.runtimeArtifactHash,
        checksHash: draft.checksHash,
        compilerVersion: draft.compilerVersion,
        inputHash,
        state: outcome.state,
        businessStatus: outcome.businessStatus,
        engineKind: config.engineKind ?? "host",
        startedAt: outcome.startedAt,
        reportPath: outcome.reportPath,
        checks: outcome.checks,
        artifacts: outcome.artifacts.map((artifact) => artifact.path),
        resultPath: outcome.resultPath,
        runDir: outcome.runDir,
      };
      trialStore.save(draft.dir, record);

      return {
        ok: outcome.state === "COMPLETED",
        runId: outcome.runId,
        state: outcome.state,
        businessStatus: outcome.businessStatus,
        inputHash,
        checks: outcome.checks as unknown as JsonValue,
        artifacts: record.artifacts as unknown as JsonValue,
        reportPath: outcome.reportPath,
        error: outcome.error as unknown as JsonValue,
        cleanupError: outcome.cleanupError,
      } as JsonValue;
    },
  };

  const pack: AuthorToolSpec = {
    name: "forge_package",
    description:
      "Build a distributable scenario package for a SAVED candidate from its STORED trials. Requires a passing static report and at least two trials with distinct input hashes whose identity hashes match the candidate. Reads trial files, never caller-supplied success flags. Returns buildHash, bundleDir, verification state and the packaged file list.",
    parameters: {
      draftRef: { type: "string", required: true, description: "draftRef returned by forge_validate." },
      trialRunIds: {
        type: "array",
        required: false,
        description: "Optional subset of stored trial run ids to package with; defaults to every trial of this candidate.",
      },
    },
    async execute(args) {
      const draftRef = asString(args["draftRef"]);
      if (!draftRef) return toolError("TOOL_INPUT_INVALID", "draftRef is required");
      let draft: StoredDraft;
      try {
        draft = draftStore.load(draftRef);
      } catch (error) {
        return toolError(DIAGNOSTIC_CODES.DRAFT_NOT_FOUND, describe(error));
      }

      const stored = trialStore.list(draft.dir);
      const requested = Array.isArray(args["trialRunIds"])
        ? (args["trialRunIds"] as JsonValue[]).map((value) => String(value))
        : null;
      // Default selection only uses trials that reached COMPLETED; failed trials are
      // reported as ignored instead of silently becoming packaging evidence.
      let selected = stored.filter((entry) => entry.state === "COMPLETED");
      if (requested) {
        const missing = requested.filter((runId) => !stored.some((entry) => entry.runId === runId));
        if (missing.length > 0) {
          return {
            ok: false,
            diagnostics: [
              {
                code: DIAGNOSTIC_CODES.TRIAL_NOT_FOUND,
                fieldPath: "trialRunIds",
                message: `no stored trial for ${missing.join(", ")}`,
                fix: "run forge_trial first; trials are read from disk, not from this call",
              },
            ] as unknown as JsonValue,
          };
        }
        selected = stored.filter((entry) => requested.includes(entry.runId));
      }
      const ignored = stored
        .filter((entry) => !selected.includes(entry))
        .map((entry) => ({ runId: entry.runId, state: entry.state }));

      const snapshot: DraftSnapshot = {
        draftRef: draft.draftRef,
        draftHash: draft.draftHash,
        spec: draft.spec,
        specHash: draft.specHash,
        script: draft.script,
        scriptHash: draft.scriptHash,
        meta: draft.meta,
        assets: draft.assets.map((asset) => {
          const sub = asset.kind === "prompt" ? "prompts" : "schemas";
          return {
            kind: asset.kind,
            key: asset.key,
            fileName: asset.fileName,
            hash: asset.hash,
            content: store.readText(join(draft.dir, sub, asset.fileName)),
          };
        }),
        staticReport: draft.staticReport,
        compilerVersion: draft.compilerVersion,
        runtimeVersion: draft.runtimeVersion,
        runtimeArtifactHash: draft.runtimeArtifactHash,
        checksHash: draft.checksHash,
        targetAdapterVersion: draft.targetAdapterVersion,
      };

      const profile = config.profile ?? {};
      const result = await packageScenario({
        draft: snapshot,
        trials: selected,
        outputDir: config.outputDir,
        ...(profile.packageName ? { packageName: profile.packageName } : {}),
        ...(profile.skillBody ? { skillBody: profile.skillBody } : {}),
        ...(profile.readme ? { readme: profile.readme } : {}),
        ...(profile.licenseText ? { licenseText: profile.licenseText } : {}),
        ...(profile.dshVersion ? { dshVersion: profile.dshVersion } : {}),
        ...(profile.examples ? { examples: profile.examples } : {}),
        now,
      });

      if (!result.ok) {
        return { ok: false, diagnostics: result.diagnostics as unknown as JsonValue, buildHash: result.buildHash ?? null } as JsonValue;
      }

      const buildDir = store.ensureDir(store.buildDir(result.buildHash));
      store.writeJsonAtomic(join(buildDir, "build-report.json"), {
        buildHash: result.buildHash,
        packageDir: result.packageDir,
        verification: result.verification as unknown as JsonValue,
        files: result.files as unknown as JsonValue,
      } as JsonValue);

      return {
        ok: true,
        buildHash: result.buildHash,
        bundleDir: result.packageDir,
        buildAssets: join(result.packageDir, "assets"),
        verification: result.verification as unknown as JsonValue,
        files: result.files as unknown as JsonValue,
        trials: result.manifest.trials as unknown as JsonValue,
        ignoredTrials: ignored as unknown as JsonValue,
      } as JsonValue;
    },
  };

  const inspect: AuthorToolSpec = {
    name: "forge_inspect",
    description:
      "Read a record that already exists: a saved candidate, a run record, or a build report. Read-only; it never changes trip state, candidates or versions.",
    parameters: {
      kind: { type: "string", required: true, description: "One of: draft, run, build." },
      id: { type: "string", required: true, description: "draftRef, runId, or buildHash." },
    },
    async execute(args) {
      const kind = asString(args["kind"]);
      const id = asString(args["id"]);
      if (!kind || !id) return toolError("TOOL_INPUT_INVALID", "kind and id are required");
      if (kind === "draft") {
        try {
          const draft = draftStore.load(id);
          return {
            kind: "draft",
            draftRef: draft.draftRef,
            draftHash: draft.draftHash,
            spec: draft.spec as unknown as JsonValue,
            staticReport: draft.staticReport as unknown as JsonValue,
            assets: draft.assets as unknown as JsonValue,
            trials: trialStore.list(draft.dir).map((entry) => ({
              runId: entry.runId,
              state: entry.state,
              inputHash: entry.inputHash,
            })) as unknown as JsonValue,
          } as JsonValue;
        } catch (error) {
          return toolError(DIAGNOSTIC_CODES.DRAFT_NOT_FOUND, describe(error));
        }
      }
      if (kind === "run") {
        const runDir = store.runDir(id);
        const recordPath = join(runDir, "run.json");
        if (!store.exists(recordPath)) return toolError(DIAGNOSTIC_CODES.RUN_NOT_FOUND, `no run record for ${id}`);
        return { kind: "run", record: store.readJson(recordPath) } as JsonValue;
      }
      if (kind === "build") {
        const bare = id.startsWith("sha256:") ? id.slice("sha256:".length) : id;
        const candidates = [...new Set([id, bare, bare.slice(0, 16)])];
        for (const candidate of candidates) {
          try {
            const reportPath = join(store.buildDir(candidate), "build-report.json");
            if (store.exists(reportPath)) return { kind: "build", report: store.readJson(reportPath) } as JsonValue;
          } catch {
            // Try the next candidate form.
          }
        }
        return toolError("BUILD_NOT_FOUND", `no build report for ${id}`);
      }
      return toolError("TOOL_INPUT_INVALID", "kind must be draft, run or build");
    },
  };

  return {
    store,
    draftStore,
    trialStore,
    tools: [validate, trial, pack, inspect],
    config,
    getRuntime,
    async shutdown() {
      await runtime?.shutdown("author tool unloading");
    },
  };
}

function readInputHash(store: FileStore, outcome: RunOutcome): string {
  try {
    const record = store.readJson(join(outcome.runDir, "run.json")) as Record<string, JsonValue>;
    const value = record["inputHash"];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function toolError(code: string, message: string): JsonValue {
  return { ok: false, error: { code, message } } as JsonValue;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
