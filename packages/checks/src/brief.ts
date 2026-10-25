/**
 * Brief checks: evidence references, dimension completeness, non-empty content
 * and result size. A missing element is a business failure, not something a
 * follow-up agent silently repairs.
 */
import { DIAGNOSTIC_CODES, PRODUCT_LIMITS, canonicalJson, type Diagnostic } from "@workflow-forge/spec";
import {
  collapseWhitespace,
  type Brief,
  type CheckOutcome,
  type CheckRecord,
  type Finding,
  type FindingKind,
} from "./types.js";

const FINDING_KINDS: readonly FindingKind[] = ["fact", "recommendation"];

export type BriefCheckInput = {
  brief: Brief;
  evidenceIds: ReadonlySet<string>;
  dimensions: readonly string[];
  maxResultBytes?: number;
};

function record(rule: string, ok: boolean, detail?: string): CheckRecord {
  return detail === undefined ? { rule, ok } : { rule, ok, detail };
}

function findingsOf(brief: Brief): Array<{ where: string; finding: Finding }> {
  const out: Array<{ where: string; finding: Finding }> = [];
  for (const [index, dimension] of brief.dimensions.entries()) {
    for (const [findingIndex, finding] of dimension.findings.entries()) {
      out.push({ where: `dimensions/${index}/findings/${findingIndex}`, finding });
    }
  }
  for (const [index, finding] of brief.conclusions.entries()) {
    out.push({ where: `conclusions/${index}`, finding });
  }
  return out;
}

export function checkEvidenceIds(brief: Brief, evidenceIds: ReadonlySet<string>): { records: CheckRecord[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  for (const { where, finding } of findingsOf(brief)) {
    if (!FINDING_KINDS.includes(finding.kind)) {
      diagnostics.push({
        severity: "error",
        code: DIAGNOSTIC_CODES.INVALID_RESULT,
        fieldPath: `${where}/kind`,
        message: `finding kind "${finding.kind}" must be "fact" or "recommendation"`,
      });
      continue;
    }
    for (const [index, evidenceId] of finding.evidenceIds.entries()) {
      if (collapseWhitespace(evidenceId).length === 0) {
        diagnostics.push({
          severity: "error",
          code: DIAGNOSTIC_CODES.EVIDENCE_IDS_EMPTY,
          fieldPath: `${where}/evidenceIds/${index}`,
          message: "evidence id must not be empty",
        });
        continue;
      }
      if (!evidenceIds.has(evidenceId)) {
        diagnostics.push({
          severity: "error",
          code: DIAGNOSTIC_CODES.EVIDENCE_ID_UNKNOWN,
          fieldPath: `${where}/evidenceIds/${index}`,
          message: `evidence id "${evidenceId}" does not exist in this run's EvidenceSet`,
          fix: "cite only evidence ids returned by the extraction step",
        });
      }
    }
    if (finding.kind === "fact" && finding.evidenceIds.length === 0) {
      diagnostics.push({
        severity: "error",
        code: DIAGNOSTIC_CODES.EVIDENCE_IDS_EMPTY,
        fieldPath: `${where}/evidenceIds`,
        message: "a fact must cite at least one evidence id",
        fix: "either cite the supporting evidence or mark the finding as a recommendation",
      });
    }
  }
  return {
    records: [record("evidence_ids_exist", diagnostics.length === 0, diagnostics[0]?.message)],
    diagnostics,
  };
}

export function checkDimensions(brief: Brief, dimensions: readonly string[]): { records: CheckRecord[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const counts = new Map<string, number>();
  for (const [index, dimension] of brief.dimensions.entries()) {
    const name = collapseWhitespace(dimension.dimension);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (dimension.findings.length === 0) {
      diagnostics.push({
        severity: "error",
        code: DIAGNOSTIC_CODES.DIMENSION_EMPTY_FINDINGS,
        fieldPath: `dimensions/${index}/findings`,
        message: `dimension "${name}" has no findings`,
        fix: "add at least one finding, or remove the dimension from the input",
      });
    }
  }
  for (const required of dimensions) {
    const count = counts.get(collapseWhitespace(required)) ?? 0;
    if (count === 0) {
      diagnostics.push({
        severity: "error",
        code: DIAGNOSTIC_CODES.DIMENSION_MISSING,
        fieldPath: "dimensions",
        message: `required dimension "${required}" is missing from the brief`,
        fix: "cover every requested dimension exactly once",
      });
    } else if (count > 1) {
      diagnostics.push({
        severity: "error",
        code: DIAGNOSTIC_CODES.DIMENSION_DUPLICATED,
        fieldPath: "dimensions",
        message: `dimension "${required}" appears ${count} times; it must appear exactly once`,
      });
    }
  }
  const requiredSet = new Set(dimensions.map((d) => collapseWhitespace(d)));
  for (const name of counts.keys()) {
    if (!requiredSet.has(name)) {
      diagnostics.push({
        severity: "error",
        code: DIAGNOSTIC_CODES.DIMENSION_UNEXPECTED,
        fieldPath: "dimensions",
        message: `dimension "${name}" was not requested in the input`,
        fix: "compare only the requested dimensions",
      });
    }
  }
  return {
    records: [record("required_dimensions", diagnostics.length === 0, diagnostics[0]?.message)],
    diagnostics,
  };
}

export function checkNonEmpty(brief: Brief, evidenceIds: ReadonlySet<string>): { records: CheckRecord[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (collapseWhitespace(brief.title).length === 0) {
    diagnostics.push({
      severity: "error",
      code: DIAGNOSTIC_CODES.EMPTY_BRIEF,
      fieldPath: "title",
      message: "brief title must not be empty",
    });
  }
  if (brief.conclusions.length === 0) {
    diagnostics.push({
      severity: "error",
      code: DIAGNOSTIC_CODES.EMPTY_BRIEF,
      fieldPath: "conclusions",
      message: "brief must contain at least one conclusion",
    });
  }
  if (brief.dimensions.length === 0) {
    diagnostics.push({
      severity: "error",
      code: DIAGNOSTIC_CODES.EMPTY_BRIEF,
      fieldPath: "dimensions",
      message: "brief must contain at least one dimension",
    });
  }
  let supportedFacts = 0;
  for (const { where, finding } of findingsOf(brief)) {
    if (collapseWhitespace(finding.text).length === 0) {
      diagnostics.push({
        severity: "error",
        code: DIAGNOSTIC_CODES.EMPTY_BRIEF,
        fieldPath: `${where}/text`,
        message: "finding text must not be empty",
      });
    }
    if (finding.kind === "fact" && finding.evidenceIds.some((id) => evidenceIds.has(id))) {
      supportedFacts += 1;
    }
  }
  if (supportedFacts === 0) {
    diagnostics.push({
      severity: "error",
      code: DIAGNOSTIC_CODES.EMPTY_BRIEF,
      fieldPath: "conclusions",
      message: "the report needs at least one fact with a valid evidence id",
    });
  }
  return {
    records: [record("non_empty_brief", diagnostics.length === 0, diagnostics[0]?.message)],
    diagnostics,
  };
}

export function checkResultSize(brief: Brief, maxResultBytes = PRODUCT_LIMITS.maxResultBytes): { records: CheckRecord[]; diagnostics: Diagnostic[] } {
  const bytes = Buffer.byteLength(canonicalJson(brief as unknown as Record<string, unknown>), "utf8");
  const ok = bytes <= maxResultBytes;
  return {
    records: [record("result_size", ok, ok ? undefined : `${bytes} bytes > ${maxResultBytes}`)],
    diagnostics: ok
      ? []
      : [
          {
            severity: "error",
            code: DIAGNOSTIC_CODES.RESULT_TOO_LARGE,
            fieldPath: "brief",
            message: `brief is ${bytes} bytes; the v0.1 limit is ${maxResultBytes}`,
          },
        ],
  };
}

export function checkBrief(input: BriefCheckInput): CheckOutcome & { diagnostics: Diagnostic[] } {
  const evidence = checkEvidenceIds(input.brief, input.evidenceIds);
  const dimensions = checkDimensions(input.brief, input.dimensions);
  const nonEmpty = checkNonEmpty(input.brief, input.evidenceIds);
  const size = checkResultSize(input.brief, input.maxResultBytes);
  const diagnostics = [...evidence.diagnostics, ...dimensions.diagnostics, ...nonEmpty.diagnostics, ...size.diagnostics];
  return {
    ok: diagnostics.length === 0,
    checks: [...evidence.records, ...dimensions.records, ...nonEmpty.records, ...size.records],
    diagnostics,
  };
}
