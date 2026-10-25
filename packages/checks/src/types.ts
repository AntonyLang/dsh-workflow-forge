/**
 * Business data model shared by the host wrapper, the checks and the emitted
 * script's helpers. These names are the contract between the three layers.
 */

export type Paragraph = { paragraphId: string; text: string };

export type Material = {
  id: string;
  title: string;
  paragraphs: Paragraph[];
  sourceRef?: string;
};

export type NormalizedInput = {
  topic: string;
  materials: Material[];
  dimensions: string[];
  language: string;
  minSuccessful: number;
};

export type EvidenceFact = { paragraphId: string; quote: string; statement: string };
export type EvidenceExtract = { facts: EvidenceFact[] };

export type MaterialError = { code: string; detail?: string };

export type MaterialResult =
  | { materialId: string; index: number; ok: true; value: EvidenceExtract }
  | { materialId: string; index: number; ok: false; error: MaterialError };

export type Evidence = {
  evidenceId: string;
  materialId: string;
  paragraphId: string;
  quote: string;
  statement: string;
};

export type FailedMaterial = {
  materialId: string;
  index: number;
  code: string;
  detail?: string;
};

export type EvidenceSet = {
  evidence: Evidence[];
  successCount: number;
  failedMaterials: FailedMaterial[];
};

export type FindingKind = "fact" | "recommendation";

export type Finding = { kind: FindingKind; text: string; evidenceIds: string[] };

export type DimensionFindings = { dimension: string; findings: Finding[] };

export type Brief = {
  title: string;
  dimensions: DimensionFindings[];
  conclusions: Finding[];
};

export type CheckRecord = { rule: string; ok: boolean; detail?: string };

export type ScenarioStatus = "completed" | "insufficient_input" | "failed" | "cancelled";

export type ScenarioResult = {
  status: ScenarioStatus;
  brief: Brief | null;
  evidence: EvidenceSet;
  failedMaterials: FailedMaterial[];
  checks: CheckRecord[];
};

/** Business-facing output of a check pass, independent of the transport layer. */
export type CheckOutcome = { ok: boolean; checks: CheckRecord[] };

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Whitespace-insensitive form used only for quote location: a quote may wrap
 * across lines or drop a space without becoming a different quote.
 */
export function squashWhitespace(text: string): string {
  return text.replace(/\s+/gu, "");
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}
