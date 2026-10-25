/**
 * Reference helpers shared by the semantic validator and the compiler.
 *
 * Resolution only walks own enumerable fields: no getters, no prototype lookup
 * and no user expressions. `__proto__`, `prototype` and `constructor` are
 * rejected as path segments so a spec cannot reach into runtime internals.
 */
import type { JsonValue, ValueExpr, ValueRef } from "./types.js";

export const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function isValueRef(expr: ValueExpr): expr is ValueRef {
  return typeof expr === "object" && expr !== null && "ref" in expr;
}

export function isLiteral(expr: ValueExpr): expr is { literal: JsonValue } {
  return typeof expr === "object" && expr !== null && "literal" in expr;
}

export function isForbiddenSegment(segment: string | number): boolean {
  return typeof segment === "string" && FORBIDDEN_PATH_SEGMENTS.has(segment);
}

export type RefResolution =
  | { ok: true; value: JsonValue }
  | { ok: false; reason: "FORBIDDEN_SEGMENT" | "MISSING_FIELD" | "NOT_AN_OBJECT"; segment?: string | number };

/**
 * Resolve a reference path against a JSON value, own-properties only.
 * Number segments index arrays; string segments read own object fields.
 */
export function resolveJsonPath(root: JsonValue, path: ReadonlyArray<string | number>): RefResolution {
  let current: JsonValue = root;
  for (const segment of path) {
    if (isForbiddenSegment(segment)) return { ok: false, reason: "FORBIDDEN_SEGMENT", segment };
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return { ok: false, reason: "NOT_AN_OBJECT", segment };
      if (!Number.isInteger(segment) || segment < 0 || segment >= current.length) {
        return { ok: false, reason: "MISSING_FIELD", segment };
      }
      current = current[segment] as JsonValue;
      continue;
    }
    if (Array.isArray(current) || current === null || typeof current !== "object") {
      return { ok: false, reason: "NOT_AN_OBJECT", segment };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { ok: false, reason: "MISSING_FIELD", segment };
    }
    current = (current as Record<string, JsonValue>)[segment] as JsonValue;
  }
  return { ok: true, value: current };
}

/** Every ref path inside one value expression, depth-first. */
export function refsInExpr(expr: ValueExpr): ValueRef[] {
  return isValueRef(expr) ? [expr] : [];
}

/** Collect every ref path segment across a spec for the forbidden-segment pass. */
export function walkRefs(value: unknown, visit: (ref: ValueRef["ref"], path: string) => void, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkRefs(item, visit, `${path}/${index}`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record["ref"] && typeof record["ref"] === "object") {
    visit(record["ref"] as ValueRef["ref"], `${path}/ref`);
  }
  for (const [key, child] of Object.entries(record)) {
    walkRefs(child, visit, `${path}/${key}`);
  }
}
