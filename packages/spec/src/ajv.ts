/**
 * Ajv wiring.
 *
 * strict: true, allErrors: true, coerceTypes: false, useDefaults: false,
 * removeAdditional: false. Defaults are expanded as an explicit compiler step
 * instead of being injected during validation.
 */
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { JsonSchema } from "./types.js";
import { workflowSpecSchema } from "./meta-schema.js";
import { scenarioResultSchema, sourceBriefInputSchema, sourceBriefNormalizedSchema } from "./contracts.js";

export const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  logger: false,
  allowUnionTypes: false,
});

const cache = new Map<string, ValidateFunction>();

function compile(id: string, schema: JsonSchema): ValidateFunction {
  const existing = cache.get(id);
  if (existing) return existing;
  const fn = ajv.compile(schema);
  cache.set(id, fn);
  return fn;
}

export function specValidator(): ValidateFunction {
  return compile("workflow-spec@0.1", workflowSpecSchema);
}

export function inputValidator(): ValidateFunction {
  return compile("source-brief-input@1", sourceBriefInputSchema);
}

export function normalizedInputValidator(): ValidateFunction {
  return compile("source-brief-normalized@1", sourceBriefNormalizedSchema);
}

export function scenarioResultValidator(): ValidateFunction {
  return compile("source-brief-result@1", scenarioResultSchema);
}

export function errorsOf(validate: ValidateFunction): readonly ErrorObject[] {
  return validate.errors ?? [];
}

/** Compile an arbitrary product JSON Schema (used for user-provided schema assets). */
export function compileSchema(schema: JsonSchema, key: string): ValidateFunction {
  return compile(`asset:${key}`, schema);
}
