/**
 * Run records (§9.2) and their write discipline.
 *
 * One wrapper owns the record of one run. Updates are queued and written as
 * atomic snapshots in order; the terminal commit waits for the queue to drain.
 * A record explains what happened; it is not a recovery checkpoint.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@workflow-forge/spec";
import type { CheckRecord, ScenarioStatus } from "@workflow-forge/checks";
import type { RunState } from "./errors.js";
import { isTerminal } from "./errors.js";
import type { FileStore } from "./store.js";

export const RECORD_VERSION = "0.1";

export type ArtifactRef = {
  kind: "input" | "result" | "report" | "events" | "diagnostics" | "build";
  path: string;
  bytes?: number;
};

export type RunError = { code: string; message: string; details?: JsonValue };

export type RunRecord = {
  recordVersion: typeof RECORD_VERSION;
  runId: string;
  engineRunId: string | null;
  workflowId: string;
  workflowVersion: string;
  specHash: string;
  draftHash: string;
  scriptHash: string;
  runtimeArtifactHash: string;
  checksHash: string;
  buildHash: string | null;
  compilerVersion: string;
  runtimeVersion: string;
  inputHash: string | null;
  hostVersion: string;
  hostBootId: string;
  /** `host` for a real DSH engine; `mock` for offline demos and tests. */
  engineKind: "host" | "mock";
  state: RunState;
  engineStopReason: string | null;
  businessStatus: ScenarioStatus | null;
  agentsStarted: number | null;
  startedAt: string;
  finishedAt: string | null;
  deadlineMs: number;
  checks: CheckRecord[];
  artifacts: ArtifactRef[];
  error: RunError | null;
  cleanupError: string | null;
};

export type RunRecordInit = {
  runId: string;
  workflowId: string;
  workflowVersion: string;
  specHash: string;
  draftHash: string;
  scriptHash: string;
  runtimeArtifactHash: string;
  checksHash: string;
  buildHash?: string | null;
  compilerVersion: string;
  runtimeVersion: string;
  hostVersion: string;
  hostBootId: string;
  engineKind: "host" | "mock";
  deadlineMs: number;
  startedAt: string;
};

export function createRunRecord(init: RunRecordInit): RunRecord {
  return {
    recordVersion: RECORD_VERSION,
    runId: init.runId,
    engineRunId: null,
    workflowId: init.workflowId,
    workflowVersion: init.workflowVersion,
    specHash: init.specHash,
    draftHash: init.draftHash,
    scriptHash: init.scriptHash,
    runtimeArtifactHash: init.runtimeArtifactHash,
    checksHash: init.checksHash,
    buildHash: init.buildHash ?? null,
    compilerVersion: init.compilerVersion,
    runtimeVersion: init.runtimeVersion,
    inputHash: null,
    hostVersion: init.hostVersion,
    hostBootId: init.hostBootId,
    engineKind: init.engineKind,
    state: "STARTING",
    engineStopReason: null,
    businessStatus: null,
    agentsStarted: null,
    startedAt: init.startedAt,
    finishedAt: null,
    deadlineMs: init.deadlineMs,
    checks: [],
    artifacts: [],
    error: null,
    cleanupError: null,
  };
}

export function runRecordPath(runDir: string): string {
  return join(runDir, "run.json");
}

/**
 * Ordered single writer. Every `update` captures a snapshot now and appends one
 * atomic write to the queue; `flush` resolves when the last snapshot is on disk.
 */
export class RunWriter {
  private chain: Promise<void> = Promise.resolve();
  private failure: Error | null = null;

  constructor(
    private readonly store: FileStore,
    private readonly runDir: string,
    private readonly record: RunRecord,
  ) {}

  get current(): RunRecord {
    return this.record;
  }

  update(patch: Partial<RunRecord>): this {
    Object.assign(this.record, patch);
    const snapshot = structuredClone(this.record) as unknown as JsonValue;
    const path = runRecordPath(this.runDir);
    this.chain = this.chain.then(() => {
      try {
        this.store.writeJsonAtomic(path, snapshot);
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        throw this.failure;
      }
    });
    // Never let a rejected queue become an unhandled rejection: `flush` rethrows.
    this.chain.catch(() => undefined);
    return this;
  }

  async flush(): Promise<void> {
    await this.chain.catch(() => undefined);
    if (this.failure) {
      throw this.failure;
    }
  }

  get writeFailed(): boolean {
    return this.failure !== null;
  }
}

export type RecoveryReport = {
  scanned: number;
  interrupted: string[];
  records: RunRecord[];
};

/**
 * On startup, records left non-terminal by a previous host boot are marked
 * INTERRUPTED. They are never resumed automatically.
 */
export function recoverRuns(store: FileStore, currentBootId: string, now: Date = new Date()): RecoveryReport {
  const interrupted: string[] = [];
  const records: RunRecord[] = [];
  for (const runId of store.listRunIds()) {
    const runDir = store.runDir(runId);
    const path = runRecordPath(runDir);
    if (!existsSync(path)) continue;
    let record: RunRecord;
    try {
      record = store.readJson(path) as unknown as RunRecord;
    } catch {
      continue;
    }
    records.push(record);
    if (record.hostBootId === currentBootId) continue;
    if (isTerminal(record.state)) continue;
    const updated: RunRecord = {
      ...record,
      state: "INTERRUPTED",
      finishedAt: now.toISOString(),
      error: {
        code: "INTERRUPTED",
        message: `host boot ${record.hostBootId} ended before this run reached a terminal state; it was not resumed`,
      },
    };
    store.writeJsonAtomic(path, updated as unknown as JsonValue);
    interrupted.push(runId);
  }
  return { scanned: records.length, interrupted, records };
}
