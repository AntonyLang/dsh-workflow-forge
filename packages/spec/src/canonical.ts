/**
 * Canonical JSON + hashes.
 *
 * Hashes are computed over canonical bytes (sorted object keys, preserved array
 * order) so the same logical content yields the same identity on any machine.
 * Timestamps, self-hashes and post-hoc summaries are never part of a hash input
 * (see packager/build.json) to avoid self-referential identities.
 */
import { createHash } from "node:crypto";

export class CanonicalJsonError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${message} at ${path || "<root>"}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

export function canonicalJson(value: unknown): string {
  return write(value, "");
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(path, "non-finite number");
      if (Object.is(value, -0)) return "0";
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item, index) => write(item, `${path}/${index}`));
        return `[${items.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const child = record[key];
        if (child === undefined) throw new CanonicalJsonError(`${path}/${key}`, "undefined value");
        parts.push(`${JSON.stringify(key)}:${write(child, `${path}/${key}`)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(path, `unsupported JSON value: ${typeof value}`);
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(input);
  return `sha256:${hash.digest("hex")}`;
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Stable digest over a deterministic list of (path, content) file entries. */
export function hashFiles(entries: Array<{ path: string; content: string }>): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const payload = sorted.map((entry) => `${entry.path}\u0000${sha256Hex(entry.content)}`).join("\n");
  return sha256Hex(payload);
}
