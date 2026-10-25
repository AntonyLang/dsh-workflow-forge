/**
 * Runtime error model.
 *
 * Classification never relies on keywords inside an error string. The only
 * string-level recognition is the exact `__WF_ERROR__<json>` envelope emitted by
 * the compiled script; everything else is SCRIPT_ERROR.
 */
import { DIAGNOSTIC_CODES, type JsonValue } from "@workflow-forge/spec";

export type ScenarioErrorCode =
  | "ADMISSION_CLOSED"
  | "CALLER_AGENT_REQUIRED"
  | "INPUT_INVALID"
  | "WORKFLOW_CANCELLED"
  | "WORKFLOW_DEADLINE"
  | "ASSERTION_FAILED"
  | "AGENT_RESULT_MISSING"
  | "SCRIPT_ERROR"
  | "INVALID_RESULT"
  | "CLEANUP_FAILED"
  | "RECORD_WRITE_FAILED"
  | "BUILD_NOT_FOUND"
  | "BUILD_HASH_MISMATCH"
  | "DRAFT_NOT_FOUND"
  | "PATH_ESCAPE"
  | "TOOL_INPUT_INVALID"
  | "RUN_NOT_FOUND";

export class ScenarioError extends Error {
  readonly code: ScenarioErrorCode;
  readonly details?: JsonValue;
  readonly diagnostics?: Array<{ code: string; fieldPath: string; message: string; fix?: string }>;

  constructor(
    code: ScenarioErrorCode,
    message: string,
    options: {
      details?: JsonValue;
      diagnostics?: Array<{ code: string; fieldPath: string; message: string; fix?: string }>;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ScenarioError";
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
    if (options.diagnostics) this.diagnostics = options.diagnostics;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export type ClassifiedError = {
  code: ScenarioErrorCode;
  message: string;
  details?: JsonValue;
};

const ERROR_PREFIX = "__WF_ERROR__";

/** Parse the exact envelope, or return null. No keyword guessing. */
function parseEnvelope(message: string): { code: string; detail?: JsonValue } | null {
  if (!message.startsWith(ERROR_PREFIX)) return null;
  const rest = message.slice(ERROR_PREFIX.length);
  try {
    const payload = JSON.parse(rest) as { code?: unknown; detail?: unknown; rule?: unknown };
    if (typeof payload.code !== "string") return null;
    return {
      code: payload.code,
      ...(payload.detail !== undefined ? { detail: payload.detail as JsonValue } : {}),
    };
  } catch {
    return null;
  }
}

export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof ScenarioError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const envelope = parseEnvelope(message);
  if (envelope) {
    if (envelope.code === "ASSERTION_FAILED") {
      return { code: "ASSERTION_FAILED", message, ...(envelope.detail !== undefined ? { details: envelope.detail } : {}) };
    }
    if (envelope.code === "AGENT_RESULT_MISSING") {
      return { code: "AGENT_RESULT_MISSING", message, ...(envelope.detail !== undefined ? { details: envelope.detail } : {}) };
    }
    if (envelope.code === "MISSING_PROMPT_BINDING") {
      return { code: "SCRIPT_ERROR", message: `missing prompt binding ${JSON.stringify(envelope.detail)}`, details: envelope.detail };
    }
    return { code: "SCRIPT_ERROR", message, ...(envelope.detail !== undefined ? { details: envelope.detail } : {}) };
  }
  return { code: "SCRIPT_ERROR", message };
}

export const TERMINAL_STATES = ["COMPLETED", "INSUFFICIENT_INPUT", "FAILED", "CANCELLED", "INTERRUPTED", "UNKNOWN"] as const;
export type RunState = "STARTING" | "RUNNING" | "SETTLING" | (typeof TERMINAL_STATES)[number];

export function isTerminal(state: RunState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function diagnosticCodes(): typeof DIAGNOSTIC_CODES {
  return DIAGNOSTIC_CODES;
}
