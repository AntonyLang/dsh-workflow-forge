/**
 * Trial records.
 *
 * A trial is written by the plugin after a real run of a candidate, next to the
 * candidate itself. The packager later reads these files; it never accepts a
 * caller-provided `passed: true`.
 */
import { join } from "node:path";
import type { JsonValue } from "@workflow-forge/spec";
import type { CheckRecord } from "@workflow-forge/checks";
import type { TrialRecord } from "@workflow-forge/packager";
import { FileStore } from "@workflow-forge/runtime";

export type StoredTrial = TrialRecord & {
  recordVersion: "0.1";
  checks: CheckRecord[];
  artifacts: string[];
  reportPath: string | null;
  resultPath: string | null;
  runDir: string;
  savedAt: string;
};

export class TrialStore {
  constructor(
    private readonly store: FileStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private dir(draftDir: string): string {
    return this.store.ensureDir(join(draftDir, "trials"));
  }

  save(draftDir: string, trial: Omit<StoredTrial, "recordVersion" | "savedAt">): StoredTrial {
    const stored: StoredTrial = {
      recordVersion: "0.1",
      savedAt: this.now().toISOString(),
      ...trial,
    };
    this.store.writeJsonAtomic(join(this.dir(draftDir), `${trial.runId}.json`), stored as unknown as JsonValue);
    return stored;
  }

  list(draftDir: string): StoredTrial[] {
    const dir = join(draftDir, "trials");
    if (!this.store.exists(dir)) return [];
    return this.store
      .listFiles(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.store.readJson(join(dir, name)) as unknown as StoredTrial)
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  }

  get(draftDir: string, runId: string): StoredTrial | undefined {
    const path = join(draftDir, "trials", `${runId}.json`);
    if (!this.store.exists(path)) return undefined;
    return this.store.readJson(path) as unknown as StoredTrial;
  }
}
