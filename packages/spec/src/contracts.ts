/**
 * v0.1 built-in contracts.
 *
 * The public input contract describes text materials. The normalized contract
 * describes the paragraph-bearing snapshot the emitted script reads from
 * `scope=input`. Keeping them separate prevents the compiler from validating
 * paragraph fields against the public schema.
 */
import type { JsonSchema } from "./types.js";

export const INPUT_CONTRACT_ID = "source-brief-input@1";
export const NORMALIZED_INPUT_CONTRACT_ID = "source-brief-normalized@1";
export const OUTPUT_CONTRACT_ID = "source-brief-result@1";

const materialInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "text"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    text: { type: "string" },
    sourceRef: { type: "string" },
  },
};

export const sourceBriefInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "materials"],
  properties: {
    topic: { type: "string" },
    materials: { type: "array", items: materialInputSchema },
    dimensions: { type: "array", items: { type: "string" } },
    language: { type: "string" },
    minSuccessful: { type: "integer" },
  },
};

const paragraphSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["paragraphId", "text"],
  properties: {
    paragraphId: { type: "string" },
    text: { type: "string" },
  },
};

const normalizedMaterialSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "paragraphs"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    paragraphs: { type: "array", items: paragraphSchema },
    sourceRef: { type: "string" },
  },
};

export const sourceBriefNormalizedSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "materials", "dimensions", "language", "minSuccessful"],
  properties: {
    topic: { type: "string" },
    materials: { type: "array", items: normalizedMaterialSchema },
    dimensions: { type: "array", items: { type: "string" } },
    language: { type: "string" },
    minSuccessful: { type: "integer" },
  },
};

const evidenceItemSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["evidenceId", "materialId", "paragraphId", "quote", "statement"],
  properties: {
    evidenceId: { type: "string" },
    materialId: { type: "string" },
    paragraphId: { type: "string" },
    quote: { type: "string" },
    statement: { type: "string" },
  },
};

const failedMaterialSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["materialId", "index", "code"],
  properties: {
    materialId: { type: "string" },
    index: { type: "integer" },
    code: { type: "string" },
    detail: { type: "string" },
  },
};

const evidenceSetSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["evidence", "successCount", "failedMaterials"],
  properties: {
    evidence: { type: "array", items: evidenceItemSchema },
    successCount: { type: "integer" },
    failedMaterials: { type: "array", items: failedMaterialSchema },
  },
};

const findingSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "text", "evidenceIds"],
  properties: {
    kind: { type: "string", enum: ["fact", "recommendation"] },
    text: { type: "string" },
    evidenceIds: { type: "array", items: { type: "string" } },
  },
};

const dimensionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["dimension", "findings"],
  properties: {
    dimension: { type: "string" },
    findings: { type: "array", items: findingSchema },
  },
};

const briefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "dimensions", "conclusions"],
  properties: {
    title: { type: "string" },
    dimensions: { type: "array", items: dimensionSchema },
    conclusions: { type: "array", items: findingSchema },
  },
};

const checkRecordSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rule", "ok"],
  properties: {
    rule: { type: "string" },
    ok: { type: "boolean" },
    detail: { type: "string" },
  },
};

export const scenarioResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "brief", "evidence", "failedMaterials", "checks"],
  properties: {
    status: { type: "string", enum: ["completed", "insufficient_input", "failed", "cancelled"] },
    brief: { oneOf: [{ type: "null" }, briefSchema] },
    evidence: evidenceSetSchema,
    failedMaterials: { type: "array", items: failedMaterialSchema },
    checks: { type: "array", items: checkRecordSchema },
  },
};

/** EvidenceExtract — the per-material agent output schema (native subset). */
export const evidenceExtractSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["paragraphId", "quote", "statement"],
        properties: {
          paragraphId: { type: "string" },
          quote: { type: "string" },
          statement: { type: "string" },
        },
      },
    },
  },
};

/** Brief — the synthesis agent output schema (native subset). */
export const briefAgentSchema: JsonSchema = briefSchema;

export type ContractKind = "input" | "normalized" | "output";

export type ContractEntry = {
  id: string;
  kind: ContractKind;
  schema: JsonSchema;
};

export const CONTRACTS: Record<string, ContractEntry> = {
  [INPUT_CONTRACT_ID]: { id: INPUT_CONTRACT_ID, kind: "input", schema: sourceBriefInputSchema },
  [NORMALIZED_INPUT_CONTRACT_ID]: {
    id: NORMALIZED_INPUT_CONTRACT_ID,
    kind: "normalized",
    schema: sourceBriefNormalizedSchema,
  },
  [OUTPUT_CONTRACT_ID]: { id: OUTPUT_CONTRACT_ID, kind: "output", schema: scenarioResultSchema },
};

export function getContract(id: string): ContractEntry | undefined {
  return CONTRACTS[id];
}
