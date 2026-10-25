/**
 * Host-side business verification, independent of the emitted script.
 *
 * The wrapper re-checks the engine's JSON before it renders a report or records a
 * success: an engine that returns "completed" is not evidence of a usable result.
 */
import { DIAGNOSTIC_CODES, diagnostic, type Diagnostic } from "@workflow-forge/spec";
import { checkBrief } from "./brief.js";
import { checkEvidenceSet } from "./evidence.js";
import type { CheckOutcome, CheckRecord, Material, ScenarioResult } from "./types.js";

export type HostCheckInput = {
  result: ScenarioResult;
  materials: Material[];
  dimensions: string[];
};

export type HostCheckOutcome = CheckOutcome & { diagnostics: Diagnostic[] };

function record(rule: string, ok: boolean, detail?: string): CheckRecord {
  return detail === undefined ? { rule, ok } : { rule, ok, detail };
}

export function runHostBusinessChecks(input: HostCheckInput): HostCheckOutcome {
  const diagnostics: Diagnostic[] = [];
  const checks: CheckRecord[] = [
    record("status_consistent", true),
    record("evidence_set", true),
  ];

  if (input.result.status === "completed" && input.result.brief === null) {
    checks[0] = record("status_consistent", false, "completed status without a brief");
    diagnostics.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.INVALID_RESULT,
        fieldPath: "brief",
        message: "a completed result must include the brief",
      }),
    );
  }
  if (input.result.status !== "completed" && input.result.brief !== null) {
    checks[0] = record("status_consistent", false, "non-completed status carries a brief");
    diagnostics.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.INVALID_RESULT,
        fieldPath: "brief",
        message: `status "${input.result.status}" must not carry a brief`,
      }),
    );
  }

  const evidenceCheck = checkEvidenceSet(input.result.evidence, input.materials);
  if (!evidenceCheck.ok) {
    checks[1] = record("evidence_set", false, `${evidenceCheck.code}: ${evidenceCheck.detail}`);
    diagnostics.push(
      diagnostic({
        code: evidenceCheck.code,
        fieldPath: "evidence",
        message: evidenceCheck.detail,
      }),
    );
  }

  const expectedFailed = JSON.stringify(input.result.evidence.failedMaterials);
  const actualFailed = JSON.stringify(input.result.failedMaterials);
  if (expectedFailed !== actualFailed) {
    diagnostics.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.INVALID_RESULT,
        fieldPath: "failedMaterials",
        message: "failedMaterials does not match evidence.failedMaterials",
      }),
    );
  }

  if (input.result.status === "completed" && input.result.brief) {
    const evidenceIds = new Set(input.result.evidence.evidence.map((item) => item.evidenceId));
    const briefCheck = checkBrief({
      brief: input.result.brief,
      evidenceIds,
      dimensions: input.dimensions,
    });
    checks.push(...briefCheck.checks);
    diagnostics.push(...briefCheck.diagnostics);
  } else if (input.result.brief) {
    const evidenceIds = new Set(input.result.evidence.evidence.map((item) => item.evidenceId));
    checks.push(...checkBrief({ brief: input.result.brief, evidenceIds, dimensions: input.dimensions }).checks);
  }

  return { ok: diagnostics.length === 0, checks, diagnostics };
}

export const HOST_RULES = {
  status_consistent: "status and brief must agree",
  evidence_set: "every evidence id must resolve to a locatable quote",
  evidence_ids_exist: "every cited evidence id must exist in this run",
  required_dimensions: "each requested dimension appears exactly once",
  non_empty_brief: "title, findings, conclusions and at least one supported fact are present",
  result_size: "the canonical result stays under the product byte limit",
} as const;
