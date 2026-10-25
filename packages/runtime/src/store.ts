/**
 * Plugin-owned file store.
 *
 * Every path is resolved under one host-provided data directory; a resolved path
 * that escapes it is rejected instead of followed. Writes go through a temp file
 * in the same directory and an atomic rename, so a crash leaves either the old
 * record or the new one, never half of each.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { JsonValue } from "@workflow-forge/spec";
import { ScenarioError } from "./errors.js";

export class FileStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  resolveInside(...segments: string[]): string {
    const target = resolve(this.root, ...segments);
    const rel = relative(this.root, target);
    if (rel !== "" && (rel.startsWith(`..${sep}`) || rel === ".." || /^[A-Za-z]:/.test(rel))) {
      throw new ScenarioError("PATH_ESCAPE", `path escapes the plugin data directory: ${target}`);
    }
    if (resolve(target) !== target) {
      throw new ScenarioError("PATH_ESCAPE", `path is not normalized: ${target}`);
    }
    return target;
  }

  draftDir(draftHash: string): string {
    return this.resolveInside("drafts", safeSegment(stripHashPrefix(draftHash)));
  }

  buildDir(buildHash: string): string {
    return this.resolveInside("builds", safeSegment(stripHashPrefix(buildHash)));
  }

  runDir(runId: string): string {
    return this.resolveInside("runs", safeSegment(runId));
  }

  ensureDir(path: string): string {
    this.assertInside(path);
    mkdirSync(path, { recursive: true });
    return path;
  }

  writeJsonAtomic(filePath: string, value: JsonValue): void {
    this.assertInside(filePath);
    mkdirSync(dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temp, filePath);
  }

  writeTextAtomic(filePath: string, text: string): void {
    this.assertInside(filePath);
    mkdirSync(dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(temp, text, "utf8");
    renameSync(temp, filePath);
  }

  readJson(filePath: string): JsonValue {
    this.assertInside(filePath);
    return JSON.parse(readFileSync(filePath, "utf8")) as JsonValue;
  }

  readText(filePath: string): string {
    this.assertInside(filePath);
    return readFileSync(filePath, "utf8");
  }

  exists(filePath: string): boolean {
    this.assertInside(filePath);
    return existsSync(filePath);
  }

  listDir(path: string): string[] {
    this.assertInside(path);
    if (!existsSync(path)) return [];
    return readdirSync(path).filter((entry) => statSync(join(path, entry)).isDirectory());
  }

  listFiles(path: string): string[] {
    this.assertInside(path);
    if (!existsSync(path)) return [];
    return readdirSync(path).filter((entry) => statSync(join(path, entry)).isFile());
  }

  listRunIds(): string[] {
    return this.listDir(this.resolveInside("runs")).sort();
  }

  remove(path: string): void {
    this.assertInside(path);
    rmSync(path, { recursive: true, force: true });
  }

  private assertInside(path: string): void {
    const target = resolve(path);
    const rel = relative(this.root, target);
    if (rel.startsWith(`..${sep}`) || rel === ".." || (rel !== "" && /^[A-Za-z]:/.test(rel))) {
      throw new ScenarioError("PATH_ESCAPE", `path escapes the plugin data directory: ${target}`);
    }
  }
}

/** Hashes and run ids become directory names; keep them to a safe alphabet. */
export function safeSegment(segment: string): string {
  if (segment.length === 0 || segment.length > 128) {
    throw new ScenarioError("PATH_ESCAPE", `invalid path segment: ${JSON.stringify(segment)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
    throw new ScenarioError("PATH_ESCAPE", `path segment contains unsupported characters: ${JSON.stringify(segment)}`);
  }
  if (segment === "." || segment === "..") {
    throw new ScenarioError("PATH_ESCAPE", "path segment may not be a relative directory marker");
  }
  return segment;
}

/** `sha256:<hex>` -> `<hex>`: the algorithm label is not part of a file name. */
export function stripHashPrefix(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
}

export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function newBootId(): string {
  return `boot-${randomBytes(6).toString("hex")}`;
}
