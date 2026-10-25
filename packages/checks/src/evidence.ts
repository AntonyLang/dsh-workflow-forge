/**
 * Evidence validation.
 *
 * Structure alone proves a quote is locatable, not that it supports a statement.
 * v0.1 checks locatability deterministically and leaves faithfulness to sampled
 * human review; it never claims a factual-accuracy guarantee.
 */
import { DIAGNOSTIC_CODES, compileSchema, errorsOf, evidenceExtractSchema } from "@workflow-forge/spec";
import {
  collapseWhitespace,
  squashWhitespace,
  type Evidence,
  type EvidenceExtract,
  type EvidenceSet,
  type FailedMaterial,
  type Material,
  type MaterialError,
  type MaterialResult,
} from "./types.js";

export type ExtractCheck =
  | { ok: true; value: EvidenceExtract }
  | { ok: false; error: MaterialError };

const extractValidator = (): ReturnType<typeof compileSchema> => compileSchema(evidenceExtractSchema, "EvidenceExtract");

function fail(code: string, detail: string): ExtractCheck {
  return { ok: false, error: { code, detail } };
}

/** Reject an extract that is structurally valid but not usable as evidence. */
export function validateEvidenceExtract(material: Material, raw: unknown): ExtractCheck {
  const validate = extractValidator();
  if (!validate(raw)) {
    const first = errorsOf(validate)[0];
    return fail("INVALID_EXTRACT_SCHEMA", first ? `${first.instancePath || "facts"} ${first.message ?? ""}`.trim() : "schema");
  }
  const extract = raw as EvidenceExtract;
  if (extract.facts.length === 0) {
    return fail(DIAGNOSTIC_CODES.EMPTY_FACTS, `material ${material.id} returned no facts`);
  }
  const paragraphs = new Map(material.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph.text]));
  for (const [index, fact] of extract.facts.entries()) {
    const paragraph = paragraphs.get(fact.paragraphId);
    if (paragraph === undefined) {
      return fail(
        DIAGNOSTIC_CODES.UNKNOWN_PARAGRAPH_ID,
        `facts/${index}: paragraphId "${fact.paragraphId}" does not exist in material ${material.id}`,
      );
    }
    if (collapseWhitespace(fact.statement).length === 0) {
      return fail(DIAGNOSTIC_CODES.EMPTY_STATEMENT, `facts/${index}: statement is empty`);
    }
    const quote = squashWhitespace(fact.quote);
    if (quote.length === 0) {
      return fail(DIAGNOSTIC_CODES.QUOTE_NOT_FOUND, `facts/${index}: quote is empty`);
    }
    if (!squashWhitespace(paragraph).includes(quote)) {
      return fail(
        DIAGNOSTIC_CODES.QUOTE_NOT_FOUND,
        `facts/${index}: quote not found in paragraph ${fact.paragraphId} of material ${material.id}`,
      );
    }
  }
  return { ok: true, value: extract };
}

/** evidenceId = material id + the fact's 1-based position inside that material. */
export function evidenceIdFor(materialId: string, factIndex: number): string {
  return `${materialId}:${factIndex}`;
}

/**
 * Build the EvidenceSet from per-material results. Array position always stays
 * aligned with the input position; failures are kept, never filtered away.
 */
export function collectEvidence(materials: Material[], results: MaterialResult[]): EvidenceSet {
  const evidence: Evidence[] = [];
  const failedMaterials: FailedMaterial[] = [];
  let successCount = 0;

  for (const [index, material] of materials.entries()) {
    const result = results[index];
    if (!result || result.materialId !== material.id) {
      failedMaterials.push({
        materialId: material.id,
        index,
        code: "RESULT_MISALIGNED",
        detail: result ? `result was for ${result.materialId}` : "no result for this position",
      });
      continue;
    }
    if (!result.ok) {
      failedMaterials.push({
        materialId: material.id,
        index,
        code: result.error.code,
        ...(result.error.detail !== undefined ? { detail: result.error.detail } : {}),
      });
      continue;
    }
    successCount += 1;
    for (const [factIndex, fact] of result.value.facts.entries()) {
      evidence.push({
        evidenceId: evidenceIdFor(material.id, factIndex + 1),
        materialId: material.id,
        paragraphId: fact.paragraphId,
        quote: fact.quote,
        statement: fact.statement,
      });
    }
  }

  return { evidence, successCount, failedMaterials };
}

export type EvidenceSetCheck =
  | { ok: true }
  | { ok: false; code: string; detail: string };

/** Host-side re-verification of an EvidenceSet against the stored materials. */
export function checkEvidenceSet(evidenceSet: EvidenceSet, materials: Material[]): EvidenceSetCheck {
  const paragraphs = new Map<string, Map<string, string>>();
  for (const material of materials) {
    paragraphs.set(material.id, new Map(material.paragraphs.map((p) => [p.paragraphId, p.text])));
  }
  const seen = new Set<string>();
  const matrix = [...paragraphs.keys()].map((materialId) => ({
    materialId,
    ok: evidenceSet.evidence.some((item) => item.materialId === materialId),
  }));

  for (const item of evidenceSet.evidence) {
    if (seen.has(item.evidenceId)) {
      return { ok: false, code: "EVIDENCE_ID_DUPLICATED", detail: item.evidenceId };
    }
    seen.add(item.evidenceId);
    const paragraph = paragraphs.get(item.materialId)?.get(item.paragraphId);
    if (paragraph === undefined) {
      return {
        ok: false,
        code: DIAGNOSTIC_CODES.UNKNOWN_PARAGRAPH_ID,
        detail: `${item.evidenceId}: ${item.materialId}/${item.paragraphId}`,
      };
    }
    if (!squashWhitespace(paragraph).includes(squashWhitespace(item.quote))) {
      return { ok: false, code: DIAGNOSTIC_CODES.QUOTE_NOT_FOUND, detail: item.evidenceId };
    }
  }

  const expectedSuccess = matrix.filter((entry) => entry.ok).length;
  if (evidenceSet.successCount !== expectedSuccess) {
    return {
      ok: false,
      code: "EVIDENCE_SUCCESS_COUNT_MISMATCH",
      detail: `successCount ${evidenceSet.successCount} does not match materials with evidence (${expectedSuccess})`,
    };
  }
  return { ok: true };
}
