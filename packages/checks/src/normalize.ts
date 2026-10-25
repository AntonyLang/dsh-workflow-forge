/**
 * Input snapshot: schema validation, product limits, newline normalization,
 * deterministic paragraph ids, and the normalized input hash.
 *
 * The wrapper stores the actual input before starting the engine, so a run can
 * always be re-read without trusting the model's description of it.
 */
import {
  DIAGNOSTIC_CODES,
  PRODUCT_LIMITS,
  canonicalJson,
  errorsOf,
  hashCanonical,
  inputValidator,
  type Diagnostic,
} from "@workflow-forge/spec";
import { codePointLength, type Material, type NormalizedInput, type Paragraph } from "./types.js";

export const NORMALIZER_VERSION = "0.1.0";

const MATERIAL_ID = /^[A-Za-z0-9_-]{1,32}$/;
const LANGUAGE = /^[a-z]{2}(-[A-Za-z]{2,8})?$/;

export type NormalizeInputResult =
  | { ok: true; input: NormalizedInput; inputHash: string; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

/** Split one material text into non-empty paragraphs with stable ids. */
export function splitParagraphs(text: string): Paragraph[] {
  return normalizeNewlines(text)
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => ({ paragraphId: `p${index + 1}`, text: line }));
}

export function normalizeInput(raw: unknown, options: { normalizerVersion?: string } = {}): NormalizeInputResult {
  const validate = inputValidator();
  if (!validate(raw)) {
    return {
      ok: false,
      diagnostics: errorsOf(validate).map((error) => ({
        code: DIAGNOSTIC_CODES.INPUT_INVALID,
        severity: "error" as const,
        fieldPath: error.instancePath.replace(/^\//u, "") || "input",
        message: error.message ?? "invalid input",
        fix: "see docs/data-contract.md for the source-brief input contract",
      })),
    };
  }

  const input = raw as {
    topic: string;
    materials: Array<{ id: string; title: string; text: string; sourceRef?: string }>;
    dimensions?: string[];
    language?: string;
    minSuccessful?: number;
  };

  const diagnostics: Diagnostic[] = [];
  const push = (partial: Omit<Diagnostic, "severity">): void => {
    diagnostics.push({ severity: "error", ...partial });
  };

  const topic = input.topic.trim();
  if (topic.length === 0) {
    push({
      code: DIAGNOSTIC_CODES.INPUT_INVALID,
      fieldPath: "topic",
      message: "topic must not be empty",
      fix: "describe the report topic in one short line",
    });
  }

  const materialsRaw = [...input.materials];
  if (materialsRaw.length < PRODUCT_LIMITS.minMaterials) {
    push({
      code: DIAGNOSTIC_CODES.INPUT_LIMIT_EXCEEDED,
      fieldPath: "materials",
      message: `at least ${PRODUCT_LIMITS.minMaterials} material is required`,
      fix: "add one material, or split the work into several runs",
    });
  }
  if (materialsRaw.length > PRODUCT_LIMITS.maxMaterials) {
    push({
      code: DIAGNOSTIC_CODES.INPUT_LIMIT_EXCEEDED,
      fieldPath: "materials",
      message: `${materialsRaw.length} materials exceed the v0.1 limit of ${PRODUCT_LIMITS.maxMaterials}; split them into batches`,
      fix: `send at most ${PRODUCT_LIMITS.maxMaterials} materials per run`,
    });
  }

  const seen = new Set<string>();
  const materials: Material[] = [];
  let totalCodePoints = 0;
  for (const [index, material] of materialsRaw.entries()) {
    const at = `materials/${index}`;
    if (!MATERIAL_ID.test(material.id)) {
      push({
        code: DIAGNOSTIC_CODES.INPUT_INVALID,
        fieldPath: `${at}/id`,
        message: "material id must be a simple identifier (letters, digits, _ or -), not a path",
        fix: "use a short stable id such as \"m1\"",
      });
    }
    if (seen.has(material.id)) {
      push({
        code: DIAGNOSTIC_CODES.INPUT_DUPLICATE_MATERIAL_ID,
        fieldPath: `${at}/id`,
        message: `material id "${material.id}" is used more than once`,
        fix: "give every material a unique id",
      });
    }
    seen.add(material.id);

    const normalizedText = normalizeNewlines(material.text);
    const length = codePointLength(normalizedText);
    totalCodePoints += length;
    if (length > PRODUCT_LIMITS.maxMaterialCodePoints) {
      push({
        code: DIAGNOSTIC_CODES.INPUT_LIMIT_EXCEEDED,
        fieldPath: `${at}/text`,
        message: `material "${material.id}" has ${length} code points; the v0.1 limit is ${PRODUCT_LIMITS.maxMaterialCodePoints} per material`,
        fix: "split the material or extract the relevant section first",
      });
    }
    const paragraphs = splitParagraphs(normalizedText);
    if (paragraphs.length === 0) {
      push({
        code: DIAGNOSTIC_CODES.INPUT_INVALID,
        fieldPath: `${at}/text`,
        message: "material text has no non-empty paragraph",
        fix: "provide the already-extracted text of the material",
      });
    }
    if (material.title.trim().length === 0) {
      push({
        code: DIAGNOSTIC_CODES.INPUT_INVALID,
        fieldPath: `${at}/title`,
        message: "material title must not be empty",
        fix: "give the material a short human-readable title",
      });
    }
    const built: Material = { id: material.id, title: material.title.trim(), paragraphs };
    if (material.sourceRef !== undefined) built.sourceRef = material.sourceRef;
    materials.push(built);
  }

  if (totalCodePoints > PRODUCT_LIMITS.maxTotalCodePoints) {
    push({
      code: DIAGNOSTIC_CODES.INPUT_LIMIT_EXCEEDED,
      fieldPath: "materials",
      message: `materials total ${totalCodePoints} code points; the v0.1 limit is ${PRODUCT_LIMITS.maxTotalCodePoints}`,
      fix: "reduce the material set before running the scenario",
    });
  }

  const dimensionsRaw = input.dimensions ?? [];
  const dimensions: string[] = [];
  const seenDimensions = new Set<string>();
  for (const [index, rawDimension] of dimensionsRaw.entries()) {
    const dimension = rawDimension.trim();
    if (dimension.length === 0) {
      push({
        code: DIAGNOSTIC_CODES.INPUT_DIMENSION_INVALID,
        fieldPath: `dimensions/${index}`,
        message: "dimension must not be empty",
      });
      continue;
    }
    if (seenDimensions.has(dimension)) {
      push({
        code: DIAGNOSTIC_CODES.INPUT_DIMENSION_INVALID,
        fieldPath: `dimensions/${index}`,
        message: `dimension "${dimension}" is duplicated`,
        fix: "list each comparison dimension once",
      });
      continue;
    }
    seenDimensions.add(dimension);
    dimensions.push(dimension);
  }
  if (dimensions.length > PRODUCT_LIMITS.maxDimensions) {
    push({
      code: DIAGNOSTIC_CODES.INPUT_LIMIT_EXCEEDED,
      fieldPath: "dimensions",
      message: `${dimensions.length} dimensions exceed the v0.1 limit of ${PRODUCT_LIMITS.maxDimensions}`,
      fix: "compare fewer dimensions per run",
    });
  }

  const language = (input.language ?? "zh").trim();
  if (!LANGUAGE.test(language)) {
    push({
      code: DIAGNOSTIC_CODES.INPUT_INVALID,
      fieldPath: "language",
      message: `language "${language}" is not a language tag such as "zh" or "en-US"`,
    });
  }

  const minSuccessful = input.minSuccessful ?? materials.length;
  if (!Number.isInteger(minSuccessful) || minSuccessful < 1 || minSuccessful > materials.length) {
    push({
      code: DIAGNOSTIC_CODES.INPUT_MIN_SUCCESSFUL_INVALID,
      fieldPath: "minSuccessful",
      message: `minSuccessful must be an integer between 1 and ${materials.length}`,
      fix: "omit minSuccessful to require every material, or lower it to allow partial coverage",
    });
  }

  if (diagnostics.some((d) => d.severity === "error")) return { ok: false, diagnostics };

  const normalized: NormalizedInput = { topic, materials, dimensions, language, minSuccessful };
  return {
    ok: true,
    input: normalized,
    inputHash: hashCanonical({
      normalizerVersion: options.normalizerVersion ?? NORMALIZER_VERSION,
      topic,
      materials: materials.map((material) => ({
        id: material.id,
        title: material.title,
        paragraphs: material.paragraphs,
      })),
      dimensions,
      language,
      minSuccessful,
    }),
    diagnostics,
  };
}

/** Convenience for diagnostics/debugging; never used as a cache key. */
export function describeInput(input: NormalizedInput): string {
  return canonicalJson({
    topic: input.topic,
    materials: input.materials.map((material) => material.id),
    dimensions: input.dimensions,
    language: input.language,
    minSuccessful: input.minSuccessful,
  });
}
