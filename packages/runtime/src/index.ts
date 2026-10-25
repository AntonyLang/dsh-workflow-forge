export { RUNTIME_VERSION, TARGET_ADAPTER_VERSION } from "./version.js";
export { ScenarioError, classifyError, isTerminal, TERMINAL_STATES } from "./errors.js";
export type { ScenarioErrorCode, ClassifiedError, RunState } from "./errors.js";
export { FileStore, newRunId, newBootId, safeSegment, stripHashPrefix } from "./store.js";
export {
  RunWriter,
  createRunRecord,
  recoverRuns,
  runRecordPath,
  RECORD_VERSION,
} from "./records.js";
export type { RunRecord, RunRecordInit, ArtifactRef, RunError, RecoveryReport } from "./records.js";
export { loadBuild, describeManifest, assertManifestTarget } from "./build.js";
export type { LoadedBuild, BuildManifest, BuildAssetRef, BuildTrialRef, BuildVerificationState } from "./build.js";
export { validateScenarioResult, resultAsJson } from "./result.js";
export type { ValidatedResult } from "./result.js";
export { renderReport } from "./report.js";
export type { ReportContext } from "./report.js";
export { attachProgress } from "./progress.js";
export type { ProgressBridge, ProgressSink } from "./progress.js";
export { createScenarioRuntime, DEFAULT_DEADLINE_MS } from "./execute.js";
export type { ScenarioRuntime, RuntimeConfig, RunOutcome } from "./execute.js";
export { createScenarioPlugin, summarizeOutcome, SCENARIO_TOOL_DESCRIPTION } from "./plugin.js";
export type { ScenarioPlugin, ScenarioPluginOptions, PluginContext, HostToolSpec, HostSkillSpec } from "./plugin.js";
export type {
  WorkflowEngine,
  WorkflowRun,
  WorkflowOutcome,
  WorkflowStartRequest,
  WorkflowMeta,
  ToolExecContext,
  AgentOptions,
  ProgressEvent,
  ProgressEventName,
} from "./engine.js";
export { createMockEngine, defaultResponder, fakeExec } from "./testing.js";
export type { MockEngine, MockEngineOptions, MockResponder, MockCallContext } from "./testing.js";
