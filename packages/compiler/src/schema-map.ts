/**
 * Product JSON Schema (Ajv, any keyword) -> native agent schema (restricted
 * object-rooted subset).
 *
 * Unsupported keywords are rejected with a precise location; they are never
 * silently dropped, because a dropped `minLength` or `$ref` would change meaning.
 */
import { DIAGNOSTIC_CODES, diagnostic, type Diagnostic, type JsonSchema, type JsonValue } from "@workflow-forge/spec";
import { fieldTypeFromSchema, type FieldType } from "./field-types.js";

const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "title",
  "description",
]);

/** Keywords that are valid JSON Schema but not part of the native subset. */
const REJECTED_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "$id",
  "$schema",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "uniqueItems",
  "patternProperties",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "contains",
  "prefixItems",
  "unevaluatedProperties",
]);

export type NativeSchemaResult =
  | { ok: true; schema: JsonSchema; type: FieldType }
  | { ok: false; diagnostics: Diagnostic[] };

function pushUnsupported(out: Diagnostic[], key: string, path: string, hint: string): void {
  out.push(
    diagnostic({
      code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
      fieldPath: path ? `${path}/${key}` : key,
      message: `agent schemas cannot use "${key}"; ${hint}`,
      fix: `move this constraint into input limits, readiness checks or a deterministic transform`,
    }),
  );
}

/**
 * Validate one asset schema and return its native form plus the type used for
 * reference checking.
 */
export function toNativeAgentSchema(schema: JsonSchema, key: string): NativeSchemaResult {
  const diagnostics: Diagnostic[] = [];
  validateNode(schema, key, true, diagnostics, key);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, schema, type: fieldTypeFromSchema(schema) };
}

function validateNode(node: JsonValue, path: string, isRoot: boolean, out: Diagnostic[], key: string): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    out.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
        fieldPath: path || key,
        message: "a schema node must be an object",
        fix: "use an object schema such as { type: \"object\", properties: {} }",
      }),
    );
    return;
  }
  const record = node as JsonSchema;

  for (const property of Object.keys(record)) {
    if (REJECTED_KEYWORDS.has(property)) {
      pushUnsupported(out, property, path, "the native schema subset only accepts type/properties/required/additionalProperties/items/enum/const");
    } else if (!ALLOWED_KEYWORDS.has(property)) {
      pushUnsupported(out, property, path, "this keyword is not part of the verified native subset");
    }
  }

  const type = record["type"];
  if (isRoot) {
    if (type !== "object") {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
          fieldPath: path || key,
          message: "an agent output schema must be object-rooted",
          fix: "wrap the payload in { type: \"object\", properties: { ... } }",
        }),
      );
    }
    if (!record["properties"] || typeof record["properties"] !== "object") {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
          fieldPath: `${path || key}/properties`,
          message: "an agent output schema needs an explicit properties object",
          fix: "declare the fields the model must return",
        }),
      );
    }
  } else if (typeof type !== "string") {
    out.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
        fieldPath: path || key,
        message: "every schema node needs an explicit type",
        fix: "add type: object|array|string|number|integer|boolean|null",
      }),
    );
  }

  if (type !== undefined && type !== "object" && type !== "array" && type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "null") {
    out.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
        fieldPath: `${path}/type`,
        message: `unsupported type value ${JSON.stringify(type)}`,
        fix: "use one of the JSON primitive types",
      }),
    );
  }

  const properties = record["properties"];
  if (properties !== undefined) {
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
          fieldPath: `${path}/properties`,
          message: "properties must be an object of schemas",
        }),
      );
    } else {
      const names = new Set(Object.keys(properties));
      for (const [name, child] of Object.entries(properties as Record<string, JsonValue>)) {
        validateNode(child, `${path}/properties/${name}`, false, out, key);
      }
      const required = record["required"];
      if (required !== undefined) {
        if (!Array.isArray(required) || required.some((entry) => typeof entry !== "string")) {
          out.push(
            diagnostic({
              code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
              fieldPath: `${path}/required`,
              message: "required must be an array of property names",
            }),
          );
        } else {
          for (const name of required as string[]) {
            if (!names.has(name)) {
              out.push(
                diagnostic({
                  code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
                  fieldPath: `${path}/required`,
                  message: `required lists "${name}" which is not declared in properties`,
                  fix: "declare the property or remove it from required",
                }),
              );
            }
          }
        }
      }
    }
  }

  const additional = record["additionalProperties"];
  if (additional !== undefined && typeof additional !== "boolean") {
    out.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
        fieldPath: `${path}/additionalProperties`,
        message: "additionalProperties must be true or false in the native subset",
        fix: "use additionalProperties: false and declare every field",
      }),
    );
  }

  const items = record["items"];
  if (items !== undefined) {
    if (Array.isArray(items)) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
          fieldPath: `${path}/items`,
          message: "tuple form (array items) is not supported",
          fix: "use a single items schema",
        }),
      );
    } else {
      validateNode(items, `${path}/items`, false, out, key);
    }
  }

  const enumValues = record["enum"];
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues) || enumValues.length === 0) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
          fieldPath: `${path}/enum`,
          message: "enum must be a non-empty array of primitive values",
        }),
      );
    } else if (enumValues.some((value) => value !== null && typeof value === "object")) {
      out.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
          fieldPath: `${path}/enum`,
          message: "enum values must be primitives in the native subset",
        }),
      );
    }
  }

  const constValue = record["const"];
  if (constValue !== undefined && constValue !== null && typeof constValue === "object") {
    out.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.UNSUPPORTED_AGENT_SCHEMA,
        fieldPath: `${path}/const`,
        message: "const must be a primitive value in the native subset",
      }),
    );
  }
}
