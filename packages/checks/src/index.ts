export * from "./types.js";
export { NORMALIZER_VERSION, normalizeInput, splitParagraphs, describeInput } from "./normalize.js";
export type { NormalizeInputResult } from "./normalize.js";
export { collectEvidence, evidenceIdFor, validateEvidenceExtract, checkEvidenceSet } from "./evidence.js";
export type { ExtractCheck, EvidenceSetCheck } from "./evidence.js";
export { checkBrief, checkDimensions, checkEvidenceIds, checkNonEmpty, checkResultSize } from "./brief.js";
export type { BriefCheckInput } from "./brief.js";
export { runHostBusinessChecks, HOST_RULES } from "./rules.js";
export type { HostCheckInput, HostCheckOutcome } from "./rules.js";
