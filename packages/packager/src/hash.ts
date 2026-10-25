/**
 * Build identity.
 *
 * The build hash covers the draft identity, the script bytes and the actual
 * shipped asset list. It never covers itself, timestamps or the trial summary, so
 * the same inputs always describe the same build without a self-reference.
 */
import { hashCanonical, hashFiles } from "@workflow-forge/spec";

export type BuildHashInput = {
  draftHash: string;
  scriptHash: string;
  compilerVersion: string;
  runtimeVersion: string;
  targetAdapterVersion: string;
  assets: Array<{ path: string; hash: string }>;
};

export function computeBuildHash(input: BuildHashInput): string {
  return hashCanonical({
    draftHash: input.draftHash,
    scriptHash: input.scriptHash,
    compilerVersion: input.compilerVersion,
    runtimeVersion: input.runtimeVersion,
    targetAdapterVersion: input.targetAdapterVersion,
    assets: [...input.assets].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
}

export function computeAssetsHash(entries: Array<{ path: string; content: string }>): string {
  return hashFiles(entries);
}
