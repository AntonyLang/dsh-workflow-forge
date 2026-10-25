/**
 * Coarse structural typing used for static reference checking.
 *
 * The type comes from the product JSON Schema subset the compiler accepts, so
 * field access, optional reads and condition operand types can be rejected
 * before any code is emitted.
 */
import type { JsonSchema, JsonValue } from "@workflow-forge/spec";

export type FieldType =
  | { kind: "null" }
  | { kind: "boolean" }
  | { kind: "number" }
  | { kind: "string" }
  | { kind: "unknown" }
  | { kind: "array"; items: FieldType }
  | {
      kind: "object";
      properties: Record<string, { type: FieldType; required: boolean }>;
      open: boolean;
    };

export type PropertyAccess =
  | { ok: true; type: FieldType }
  | { ok: false; reason: "UNKNOWN_FIELD" | "NOT_AN_OBJECT" | "OPTIONAL_FIELD"; segment: string | number };

export function fieldTypeFromSchema(schema: JsonSchema): FieldType {
  const constValue = schema["const"];
  if (constValue !== undefined) return typeOfLiteral(constValue);

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const kinds = new Set(enumValues.map((value) => typeOfLiteral(value).kind));
    if (kinds.size === 1) {
      const [only] = kinds;
      return only === "number" ? { kind: "number" } : only === "string" ? { kind: "string" } : only === "boolean" ? { kind: "boolean" } : { kind: "unknown" };
    }
    return { kind: "unknown" };
  }

  switch (schema["type"]) {
    case "string":
      return { kind: "string" };
    case "integer":
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "null":
      return { kind: "null" };
    case "array": {
      const items = schema["items"];
      return {
        kind: "array",
        items: items && typeof items === "object" && !Array.isArray(items) ? fieldTypeFromSchema(items as JsonSchema) : { kind: "unknown" },
      };
    }
    case "object": {
      const propertiesRaw = schema["properties"];
      const properties: Record<string, { type: FieldType; required: boolean }> = {};
      if (propertiesRaw && typeof propertiesRaw === "object" && !Array.isArray(propertiesRaw)) {
        const required = new Set(Array.isArray(schema["required"]) ? (schema["required"] as string[]) : []);
        for (const [name, child] of Object.entries(propertiesRaw as Record<string, JsonSchema>)) {
          properties[name] = {
            type: fieldTypeFromSchema(child),
            required: required.has(name),
          };
        }
      }
      const additional = schema["additionalProperties"];
      return { kind: "object", properties, open: additional !== false };
    }
    default:
      return { kind: "unknown" };
  }
}

function typeOfLiteral(value: JsonValue): FieldType {
  switch (typeof value) {
    case "string":
      return { kind: "string" };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    default:
      return value === null ? { kind: "null" } : { kind: "unknown" };
  }
}

export function accessProperty(type: FieldType, segment: string | number): PropertyAccess {
  if (type.kind === "unknown") return { ok: true, type: { kind: "unknown" } };
  if (typeof segment === "number") {
    if (type.kind !== "array") return { ok: false, reason: "NOT_AN_OBJECT", segment };
    return { ok: true, type: type.items };
  }
  if (type.kind !== "object") return { ok: false, reason: "NOT_AN_OBJECT", segment };
  const property = type.properties[segment];
  if (!property) {
    if (type.open) return { ok: true, type: { kind: "unknown" } };
    return { ok: false, reason: "UNKNOWN_FIELD", segment };
  }
  if (!property.required) return { ok: false, reason: "OPTIONAL_FIELD", segment };
  return { ok: true, type: property.type };
}

export function isNumberType(type: FieldType): boolean {
  return type.kind === "number";
}

export function isArrayLike(type: FieldType): boolean {
  return type.kind === "array" || type.kind === "string" || type.kind === "object" || type.kind === "unknown";
}

export function describeType(type: FieldType): string {
  switch (type.kind) {
    case "array":
      return `array<${describeType(type.items)}>`;
    case "object":
      return `object{${Object.keys(type.properties).join(",")}}`;
    default:
      return type.kind;
  }
}

export const EVIDENCE_SET_TYPE: FieldType = {
  kind: "object",
  open: false,
  properties: {
    evidence: {
      required: true,
      type: {
        kind: "array",
        items: {
          kind: "object",
          open: false,
          properties: {
            evidenceId: { required: true, type: { kind: "string" } },
            materialId: { required: true, type: { kind: "string" } },
            paragraphId: { required: true, type: { kind: "string" } },
            quote: { required: true, type: { kind: "string" } },
            statement: { required: true, type: { kind: "string" } },
          },
        },
      },
    },
    successCount: { required: true, type: { kind: "number" } },
    failedMaterials: {
      required: true,
      type: {
        kind: "array",
        items: {
          kind: "object",
          open: false,
          properties: {
            materialId: { required: true, type: { kind: "string" } },
            index: { required: true, type: { kind: "number" } },
            code: { required: true, type: { kind: "string" } },
            detail: { required: false, type: { kind: "string" } },
          },
        },
      },
    },
  },
};

export const ASSERT_RESULT_TYPE: FieldType = {
  kind: "object",
  open: false,
  properties: {
    ok: { required: true, type: { kind: "boolean" } },
    checks: {
      required: true,
      type: {
        kind: "array",
        items: {
          kind: "object",
          open: false,
          properties: {
            rule: { required: true, type: { kind: "string" } },
            ok: { required: true, type: { kind: "boolean" } },
            detail: { required: false, type: { kind: "string" } },
          },
        },
      },
    },
  },
};
