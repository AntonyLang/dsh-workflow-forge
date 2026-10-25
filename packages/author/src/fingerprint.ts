/**
 * Implementation fingerprints.
 *
 * A draft identity binds to the actual implementation bytes that will execute
 * it. These hashes are computed from the source trees that the author plugin and
 * the scenario bundle both ship, so changing the runtime or the checks produces a
 * new draft identity and invalidates older trials.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFiles } from "@workflow-forge/spec";

export function hashSourceTree(root: string): string {
  const files: Array<{ path: string; content: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      files.push({ path: relative(root, full).replace(/\\/g, "/"), content: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return hashFiles(files);
}

function packageSource(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export const RUNTIME_ARTIFACT_HASH = hashSourceTree(packageSource("../../runtime/src"));
export const CHECKS_HASH = hashSourceTree(packageSource("../../checks/src"));
