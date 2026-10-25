/**
 * Run wrapper: admission, cancellation, deadline, dispose and terminal commit.
 *
 * Invariants:
 * - one ownedExecution exists for the whole call, before the first await;
 * - activeRuns only holds native handles already returned by engine.start;
 * - every exit path awaits dispose;
 * - the terminal decision is frozen once, after the last cancellation check;
 * - a late cancel never rewrites a committed terminal state.
 */
import { join } from "node:path";
import { renameSync, rmSync } from "node:fs";
import { formatDiagnostic, type JsonValue } from "@workflow-forge/spec";
import {
  normalizeInput,
  runHostBusinessChecks,
  type CheckRecord,
  type Material,
  type ScenarioResult,
  type ScenarioStatus,
} from "@workflow-forge/checks";
import { ScenarioError, classifyError, type RunState } from "./errors.js";
import { FileStore, newBootId, newRunId } from "./store.js";
import {
  RunWriter,
  createRunRecord,
  recoverRuns,
  runRecordPath,
  type ArtifactRef,
  type RunError,
  type RunRecord,
} from "./records.js";
import { loadBuild, type LoadedBuild } from "./build.js";
import { validateScenarioResult } from "./result.js";
import { renderReport } from "./report.js";
import { attachProgress, type ProgressBridge } from "./progress.js";
import { RUNTIME_VERSION } from "./version.js";
import type { ProgressEvent, ToolExecContext, WorkflowEngine, WorkflowOutcome, WorkflowRun } from "./engine.js";

export const DEFAULT_DEADLINE_MS = 180_000;

export type RuntimeConfig = {
  dataDir: string;
  deadlineMs?: number;
  hostVersion?: string;
  hostBootId?: string;
  /** `host` for a real engine, `mock` for offline demos and tests. */
  engineKind?: "host" | "mock";
  now?: () => Date;
  onProgress?: (event: ProgressEvent) => void;
};

export type RunOutcome = {
  runId: string;
  runDir: string;
  state: RunState;
  businessStatus: ScenarioStatus | null;
  engineRunId: string | null;
  engineStopReason: string | null;
  result: ScenarioResult | null;
  checks: CheckRecord[];
  artifacts: ArtifactRef[];
  error: RunError | null;
  cleanupError: string | null;
  reportPath: string | null;
  resultPath: string | null;
  agentsStarted: number | null;
  startedAt: string;
  finishedAt: string;
};

export type ScenarioRuntime = {
  readonly bootId: string;
  readonly accepting: boolean;
  readonly ownedCount: number;
  run(build: LoadedBuild, rawInput: unknown, exec: ToolExecContext): Promise<RunOutcome>;
  shutdown(reason?: string): Promise<void>;
  recover(now?: Date): { scanned: number; interrupted: string[] };
};

type OwnedExecution = {
  runId: string;
  controller: AbortController;
  abortReason: string | null;
  settled: Promise<void>;
  resolveSettled: () => void;
};

export function createScenarioRuntime(options: {
  engine: WorkflowEngine;
  config: RuntimeConfig;
  store?: FileStore;
}): ScenarioRuntime {
  const { engine, config } = options;
  const now = config.now ?? (() => new Date());
  const store = options.store ?? new FileStore(config.dataDir);
  const deadlineMs = config.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const bootId = config.hostBootId ?? newBootId();
  const engineKind = config.engineKind ?? "host";
  const ownedExecutions = new Map<string, OwnedExecution>();
  const activeRuns = new Set<WorkflowRun>();
  let accepting = true;

  function createOwned(): OwnedExecution {
    let resolveSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    return {
      runId: newRunId(now()),
      controller: new AbortController(),
      abortReason: null,
      settled,
      resolveSettled,
    };
  }

  function abortOwned(owned: OwnedExecution, reason: string): void {
    if (!owned.controller.signal.aborted) {
      owned.abortReason = reason;
      owned.controller.abort(reason);
    }
  }

  function cancelError(owned: OwnedExecution): RunError {
    const reason = owned.abortReason ?? "caller cancelled";
    const code = reason === "workflow deadline" ? "WORKFLOW_DEADLINE" : "WORKFLOW_CANCELLED";
    return { code, message: `run cancelled: ${reason}` };
  }

  async function run(build: LoadedBuild, rawInput: unknown, exec: ToolExecContext): Promise<RunOutcome> {
    if (!accepting) {
      throw new ScenarioError("ADMISSION_CLOSED", "the scenario plugin is unloading; no new runs are accepted");
    }
    if (!exec.agent) {
      throw new ScenarioError(
        "CALLER_AGENT_REQUIRED",
        "this tool must be called by an agent; exec.agent is missing, and a parent cannot be fabricated",
      );
    }
    const owned = createOwned();
    ownedExecutions.set(owned.runId, owned);
    try {
      return await runOwned(owned, build, rawInput, exec);
    } finally {
      ownedExecutions.delete(owned.runId);
      owned.resolveSettled();
    }
  }

  async function runOwned(
    owned: OwnedExecution,
    build: LoadedBuild,
    rawInput: unknown,
    exec: ToolExecContext,
  ): Promise<RunOutcome> {
    const startedAt = now().toISOString();
    const runDir = store.ensureDir(store.runDir(owned.runId));
    const manifest = build.manifest;
    const record = createRunRecord({
      runId: owned.runId,
      workflowId: manifest.workflowId,
      workflowVersion: manifest.workflowVersion,
      specHash: manifest.specHash,
      draftHash: manifest.draftHash,
      scriptHash: manifest.scriptHash,
      runtimeArtifactHash: manifest.runtimeArtifactHash,
      checksHash: manifest.checksHash,
      compilerVersion: manifest.compilerVersion,
      runtimeVersion: RUNTIME_VERSION,
      hostVersion: config.hostVersion ?? "unknown",
      hostBootId: bootId,
      engineKind,
      deadlineMs,
      startedAt,
    });
    const writer = new RunWriter(store, runDir, record);
    const artifacts: ArtifactRef[] = [];

    // 1. The actual input is snapshotted before the engine starts.
    const inputPath = join(runDir, "input.json");
    try {
      store.writeJsonAtomic(inputPath, (rawInput ?? null) as JsonValue);
      artifacts.push({ kind: "input", path: inputPath });
    } catch (error) {
      return finalizeInputFailure(writer, runDir, owned, `could not save the input snapshot: ${describe(error)}`);
    }

    // 2. Input validation never starts an agent.
    const normalized = normalizeInput(rawInput);
    if (!normalized.ok) {
      const message = normalized.diagnostics.map(formatDiagnostic).join("; ");
      const diagnosticsPath = join(runDir, "diagnostics.json");
      try {
        store.writeJsonAtomic(diagnosticsPath, { input: normalized.diagnostics as unknown as JsonValue });
        artifacts.push({ kind: "diagnostics", path: diagnosticsPath });
      } catch {
        // A failed diagnostic write must not hide the input error.
      }
      return commit(writer, runDir, owned, {
        state: "FAILED",
        businessStatus: null,
        engineRunId: null,
        engineStopReason: null,
        result: null,
        checks: [],
        artifacts,
        error: { code: "INPUT_INVALID", message },
        cleanupError: null,
        reportPath: null,
        resultPath: null,
        pendingReport: null,
        startedAt,
        agentsStarted: null,
      });
    }

    const input = normalized.input;
    writer.update({ state: "STARTING", inputHash: normalized.inputHash, artifacts: [...artifacts] });

    // 3. Native segment: forward cancel, enforce the deadline, always dispose.
    const control = owned.controller;
    const forward = (): void => {
      abortOwned(owned, `caller cancelled: ${String(exec.signal.reason ?? "aborted")}`);
    };
    exec.signal.addEventListener("abort", forward, { once: true });
    if (exec.signal.aborted) forward();

    let deadlineFired = false;
    const timer = setTimeout(() => {
      deadlineFired = true;
      abortOwned(owned, "workflow deadline");
    }, deadlineMs);
    // A pending run must not keep the host process alive on its own.
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }

    let run: WorkflowRun | null = null;
    let progress: ProgressBridge | null = null;
    let outcome: WorkflowOutcome | null = null;
    let startError: unknown = null;
    let cleanupError: string | null = null;
    let agentsStarted: number | null = null;

    try {
      if (control.signal.aborted) {
        throw new ScenarioError(deadlineFired ? "WORKFLOW_DEADLINE" : "WORKFLOW_CANCELLED", "cancelled before the engine started");
      }
      progress = options.config.onProgress
        ? attachProgress(engine, options.config.onProgress, now)
        : attachProgress(engine, () => {}, now);
      run = engine.start({
        script: build.script,
        meta: build.meta,
        args: input as unknown as JsonValue,
        parent: exec.agent,
        signal: control.signal,
        subagentProvider: "spawn",
        maxTotalAgents: manifest.limits.maxDirectAgents,
      });
      activeRuns.add(run);
      progress.bind(run.id);
      writer.update({ state: "RUNNING", engineRunId: run.id });
      outcome = await run.result;
    } catch (error) {
      startError = error;
    } finally {
      clearTimeout(timer);
      exec.signal.removeEventListener("abort", forward);
      if (run) {
        try {
          await run.dispose();
        } catch (error) {
          cleanupError = describe(error);
        } finally {
          activeRuns.delete(run);
        }
      }
      if (progress) {
        agentsStarted = progress.events.filter((event) => event.type === "workflow/agent-start").length || null;
        progress.detach();
      }
    }

    // 4. Classify: engine outcome first, then business verification.
    const terminal: PendingTerminal = {
      state: "FAILED",
      businessStatus: null,
      engineRunId: run?.id ?? null,
      engineStopReason: outcome?.stopReason ?? null,
      result: null,
      checks: [],
      artifacts: [...artifacts],
      error: null,
      cleanupError,
      reportPath: null,
      resultPath: null,
      pendingReport: null,
      startedAt,
      agentsStarted,
    };

    if (startError !== null) {
      if (control.signal.aborted) {
        terminal.state = "CANCELLED";
        terminal.error = cancelError(owned);
      } else {
        const classified = classifyError(startError);
        terminal.error = { code: classified.code, message: classified.message };
      }
      return commit(writer, runDir, owned, terminal);
    }

    if (!outcome) {
      terminal.error = { code: "SCRIPT_ERROR", message: "the engine settled without an outcome" };
      return commit(writer, runDir, owned, terminal);
    }

    if (outcome.stopReason === "cancelled") {
      terminal.state = "CANCELLED";
      terminal.error = cancelError(owned);
      return commit(writer, runDir, owned, terminal);
    }

    if (outcome.stopReason === "error") {
      const classified = classifyError(outcome.error ?? "engine reported an error");
      terminal.state = "FAILED";
      terminal.error = { code: classified.code, message: classified.message, ...(classified.details !== undefined ? { details: classified.details } : {}) };
      return commit(writer, runDir, owned, terminal);
    }

    const validated = validateScenarioResult(outcome.value);
    if (!validated.ok) {
      terminal.state = "FAILED";
      terminal.error = { code: validated.code, message: validated.message };
      return commit(writer, runDir, owned, terminal);
    }

    const result = validated.result;
    const hostCheck = runHostBusinessChecks({
      result,
      materials: input.materials as Material[],
      dimensions: input.dimensions,
    });
    // The host re-verifies the same rules; its verdict supersedes the script's.
    terminal.checks = mergeChecks(result.checks, hostCheck.checks);
    if (!hostCheck.ok) {
      terminal.state = "FAILED";
      terminal.error = {
        code: "INVALID_RESULT",
        message: hostCheck.diagnostics.map((d) => `${d.code} ${d.fieldPath}: ${d.message}`).join("; "),
        details: hostCheck.diagnostics as unknown as JsonValue,
      };
      const diagnosticsPath = join(runDir, "diagnostics.json");
      try {
        store.writeJsonAtomic(diagnosticsPath, { business: hostCheck.diagnostics as unknown as JsonValue });
        terminal.artifacts.push({ kind: "diagnostics", path: diagnosticsPath });
      } catch {
        // Ignored: the report and record still describe the failure.
      }
      return commit(writer, runDir, owned, terminal);
    }

    // 5. Report is rendered to a temp file; it becomes an artifact only after the
    //    last cancellation check, so a cancelled run never leaves a success report.
    const reportText = renderReport(result, {
      runId: owned.runId,
      workflowId: manifest.workflowId,
      workflowVersion: manifest.workflowVersion,
      topic: input.topic,
      language: input.language,
      dimensions: input.dimensions,
      materials: input.materials as Material[],
      generatedAt: now().toISOString(),
    });
    const reportPath = join(runDir, "report.md");
    const tempReport = join(runDir, `.report.md.tmp-${process.pid}`);
    try {
      store.writeTextAtomic(tempReport, reportText);
      terminal.pendingReport = { temp: tempReport, final: reportPath };
    } catch (error) {
      terminal.state = "UNKNOWN";
      terminal.error = { code: "RECORD_WRITE_FAILED", message: `could not write the report: ${describe(error)}` };
      return commit(writer, runDir, owned, terminal);
    }

    terminal.result = result;
    terminal.businessStatus = result.status;
    terminal.state = result.status === "completed" ? "COMPLETED" : "INSUFFICIENT_INPUT";
    return commit(writer, runDir, owned, terminal);
  }

  type PendingTerminal = {
    state: RunState;
    businessStatus: ScenarioStatus | null;
    engineRunId: string | null;
    engineStopReason: string | null;
    result: ScenarioResult | null;
    checks: CheckRecord[];
    artifacts: ArtifactRef[];
    error: RunError | null;
    cleanupError: string | null;
    reportPath: string | null;
    resultPath: string | null;
    pendingReport: { temp: string; final: string } | null;
    startedAt: string;
    agentsStarted: number | null;
  };

  async function commit(
    writer: RunWriter,
    runDir: string,
    owned: OwnedExecution,
    terminal: PendingTerminal,
  ): Promise<RunOutcome> {
    // Freeze the terminal decision exactly once, after the last cancellation check.
    const frozen = owned.controller.signal.aborted
      ? {
          ...terminal,
          state: "CANCELLED" as RunState,
          businessStatus: null,
          result: null,
          checks: [],
          error: cancelError(owned),
        }
      : terminal;

    if (frozen.state === "CANCELLED" && terminal.pendingReport) {
      try {
        rmSync(terminal.pendingReport.temp, { force: true });
      } catch {
        // Best effort: the run is already recorded as cancelled.
      }
      frozen.pendingReport = null;
    } else if (frozen.pendingReport && frozen.result) {
      try {
        renameSync(frozen.pendingReport.temp, frozen.pendingReport.final);
        frozen.reportPath = frozen.pendingReport.final;
        frozen.artifacts.push({ kind: "report", path: frozen.pendingReport.final });
      } catch (error) {
        frozen.state = "UNKNOWN";
        frozen.error = { code: "RECORD_WRITE_FAILED", message: `could not publish the report: ${describe(error)}` };
      }
    }

    if (frozen.result && frozen.reportPath) {
      const resultPath = join(runDir, "result.json");
      try {
        store.writeJsonAtomic(resultPath, frozen.result as unknown as JsonValue);
        frozen.resultPath = resultPath;
        frozen.artifacts.push({ kind: "result", path: resultPath });
      } catch (error) {
        frozen.state = "UNKNOWN";
        frozen.error = { code: "RECORD_WRITE_FAILED", message: `could not write result.json: ${describe(error)}` };
      }
    }

    if (frozen.cleanupError && (frozen.state === "COMPLETED" || frozen.state === "INSUFFICIENT_INPUT")) {
      frozen.state = "UNKNOWN";
      frozen.error = { code: "CLEANUP_FAILED", message: frozen.cleanupError };
    }

    const finishedAt = now().toISOString();
    writer.update({
      state: frozen.state,
      businessStatus: frozen.businessStatus,
      engineRunId: frozen.engineRunId,
      engineStopReason: frozen.engineStopReason,
      agentsStarted: frozen.agentsStarted,
      finishedAt,
      checks: frozen.checks,
      artifacts: frozen.artifacts,
      error: frozen.error,
      cleanupError: frozen.cleanupError,
      engineKind,
    });

    try {
      await writer.flush();
    } catch (error) {
      return {
        runId: owned.runId,
        runDir,
        state: "UNKNOWN",
        businessStatus: null,
        engineRunId: frozen.engineRunId,
        engineStopReason: frozen.engineStopReason,
        result: null,
        checks: frozen.checks,
        artifacts: frozen.artifacts,
        error: { code: "RECORD_WRITE_FAILED", message: describe(error) },
        cleanupError: frozen.cleanupError,
        reportPath: null,
        resultPath: null,
        agentsStarted: frozen.agentsStarted,
        startedAt: frozen.startedAt,
        finishedAt,
      };
    }

    return {
      runId: owned.runId,
      runDir,
      state: frozen.state,
      businessStatus: frozen.businessStatus,
      engineRunId: frozen.engineRunId,
      engineStopReason: frozen.engineStopReason,
      result: frozen.state === "CANCELLED" ? null : frozen.result,
      checks: frozen.checks,
      artifacts: frozen.artifacts,
      error: frozen.error,
      cleanupError: frozen.cleanupError,
      reportPath: frozen.reportPath,
      resultPath: frozen.resultPath,
      agentsStarted: frozen.agentsStarted,
      startedAt: frozen.startedAt,
      finishedAt,
    };
  }

  async function finalizeInputFailure(
    writer: RunWriter,
    runDir: string,
    owned: OwnedExecution,
    message: string,
  ): Promise<RunOutcome> {
    return commit(writer, runDir, owned, {
      state: "FAILED",
      businessStatus: null,
      engineRunId: null,
      engineStopReason: null,
      result: null,
      checks: [],
      artifacts: [],
      error: { code: "INPUT_INVALID", message },
      cleanupError: null,
      reportPath: null,
      resultPath: null,
      pendingReport: null,
      startedAt: now().toISOString(),
      agentsStarted: null,
    });
  }

  async function shutdown(reason = "plugin unloading"): Promise<void> {
    accepting = false;
    const pending = [...ownedExecutions.values()];
    for (const owned of pending) abortOwned(owned, reason);
    await Promise.allSettled(pending.map((owned) => owned.settled));
  }

  return {
    bootId,
    get accepting() {
      return accepting;
    },
    get ownedCount() {
      return ownedExecutions.size;
    },
    run,
    shutdown,
    recover(nowDate?: Date) {
      const report = recoverRuns(store, bootId, nowDate ?? now());
      return { scanned: report.scanned, interrupted: report.interrupted };
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One record per rule name; the host's later verdict replaces the script's. */
function mergeChecks(scriptChecks: CheckRecord[], hostChecks: CheckRecord[]): CheckRecord[] {
  const byRule = new Map<string, CheckRecord>();
  for (const check of scriptChecks) byRule.set(check.rule, check);
  for (const check of hostChecks) byRule.set(check.rule, check);
  return [...byRule.values()];
}

export { runRecordPath };
