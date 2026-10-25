/**
 * Engine value -> ScenarioResult.
 *
 * The wrapper validates the JSON against the output contract before anything is
 * rendered or recorded. `status` is program-assigned; a value that fails this
 * check can never be reported as a success.
 */
import { errorsOf, scenarioResultValidator, type JsonValue } from "@workflow-forge/spec";
import type { ScenarioResult, ScenarioStatus } from "@workflow-forge/checks";

export type ValidatedResult =
  | { ok: true; result: ScenarioResult }
  | { ok: false; code: string; message: string; detail?: string };

const STATUSES: readonly ScenarioStatus[] = ["completed", "insufficient_input", "failed", "cancelled"];

export function validateScenarioResult(raw: unknown): ValidatedResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "INVALID_RESULT", message: "engine value is not a ScenarioResult object" };
  }
  const validate = scenarioResultValidator();
  if (!validate(raw)) {
    const first = errorsOf(validate)[0];
    const where = first ? `${first.instancePath || "result"} ${first.message ?? ""}`.trim() : "result";
    return { ok: false, code: "INVALID_RESULT", message: `engine value does not match the output contract: ${where}` };
  }
  const result = raw as ScenarioResult;
  if (!STATUSES.includes(result.status)) {
    return { ok: false, code: "INVALID_RESULT", message: `unknown status ${String(result.status)}` };
  }
  if (result.status === "completed" && result.brief === null) {
    return { ok: false, code: "INVALID_RESULT", message: "completed result has no brief" };
  }
  if (result.status !== "completed" && result.brief !== null) {
    return { ok: false, code: "INVALID_RESULT", message: `status ${result.status} must not carry a brief` };
  }
  return { ok: true, result };
}

export function resultAsJson(result: ScenarioResult): JsonValue {
  return result as unknown as JsonValue;
}
