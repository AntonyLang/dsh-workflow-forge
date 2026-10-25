/**
 * The host surfaces this project consumes.
 *
 * These are structural types, not imports of the shipped DSH packages: the
 * scenario bundle talks to the host only through the Cordis context it is
 * applied with. Types are declared here so the wrapper can be unit-tested with
 * a fake engine and, later, verified against a real target build.
 */
import type { JsonSchema, JsonValue } from "@workflow-forge/spec";

export type AgentOptions = {
  schema?: JsonSchema;
  label?: string;
  phase?: string;
  provider?: string;
  model?: string;
};

export type WorkflowMeta = { name: string; phases: string[] };

export type WorkflowStartRequest = {
  script: string;
  meta: WorkflowMeta;
  args: JsonValue;
  /** The calling agent: the engine requires an explicit parent. */
  parent: unknown;
  signal: AbortSignal;
  subagentProvider: "spawn";
  maxTotalAgents: number;
};

export type WorkflowStopReason = "completed" | "cancelled" | "error";

export type WorkflowOutcome = {
  stopReason: WorkflowStopReason;
  value?: JsonValue;
  error?: string;
};

export type WorkflowRun = {
  id: string;
  result: Promise<WorkflowOutcome>;
  dispose(): Promise<void>;
};

export type WorkflowEngine = {
  start(request: WorkflowStartRequest): WorkflowRun;
  on?(event: string, handler: (payload: unknown) => void): (() => void) | void;
};

/** The tool execution context the host passes to `execute`. */
export type ToolExecContext = {
  agent?: unknown;
  signal: AbortSignal;
  toolCallId?: string;
  sessionId?: string;
};

export const PROGRESS_EVENTS = [
  "workflow/start",
  "workflow/phase",
  "workflow/agent-start",
  "workflow/agent-end",
  "workflow/end",
] as const;

export type ProgressEventName = (typeof PROGRESS_EVENTS)[number];

export type ProgressEvent = {
  type: ProgressEventName;
  payload: JsonValue;
  at: string;
  engineRunId?: string;
};
