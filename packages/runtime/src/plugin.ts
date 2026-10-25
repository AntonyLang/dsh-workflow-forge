/**
 * The shipped scenario plugin (thin runtime).
 *
 * It contains no compiler and no author tooling: it loads a fixed build, exposes
 * one tool that runs it and registers the scenario skill. Everything it needs from
 * the host arrives through the Cordis context, so the bundle imports nothing from
 * the DSH packages and only declares them as peers for version gating.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@workflow-forge/spec";
import { loadBuild, type LoadedBuild } from "./build.js";
import { createScenarioRuntime, type RunOutcome, type ScenarioRuntime } from "./execute.js";
import type { ToolExecContext, WorkflowEngine } from "./engine.js";
import { ScenarioError } from "./errors.js";
import { RUNTIME_VERSION, TARGET_ADAPTER_VERSION } from "./version.js";
import type { FileStore } from "./store.js";

/** Minimal structural view of the host tool registry. */
export type HostToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description?: string; required?: boolean }>;
  execute(args: Record<string, JsonValue>, exec: ToolExecContext): Promise<JsonValue>;
  render?(result: JsonValue): string;
};

export type HostSkillSpec = {
  name: string;
  description: string;
  body: string;
  root: string;
};

export type PluginContext = {
  workflowEngine?: WorkflowEngine;
  tools?: { register?(tool: HostToolSpec): unknown; define?(tool: HostToolSpec): unknown };
  skills?: { register?(skill: HostSkillSpec): unknown };
  effect?(register: () => (() => void | Promise<void>) | void): unknown;
  config?: Record<string, JsonValue>;
  logger?: { info?(message: string): void; warn?(message: string): void; error?(message: string): void };
};

export type ScenarioPluginOptions = {
  assetsDir?: string;
  skillPath?: string;
  dataDir?: string;
  deadlineMs?: number;
  toolName?: string;
};

export type ScenarioPlugin = {
  name: string;
  apply(ctx: PluginContext, config?: Record<string, JsonValue>): Promise<void>;
  runtime?: ScenarioRuntime;
  build?: LoadedBuild;
};

export const SCENARIO_TOOL_DESCRIPTION =
  "Run the installed source-brief scenario. Send already-extracted text materials and receive a structured brief whose findings cite paragraph-level evidence.";

export function createScenarioPlugin(options: ScenarioPluginOptions = {}): ScenarioPlugin {
  const assetsDir = options.assetsDir ?? join(dirnameOfModule(), "..", "assets");
  const skillPath = options.skillPath ?? join(dirnameOfModule(), "..", "skills", "source-brief", "SKILL.md");
  const toolName = options.toolName ?? "source_brief";

  let runtime: ScenarioRuntime | undefined;
  let build: LoadedBuild | undefined;

  const plugin: ScenarioPlugin = {
    name: "dsh-scenario-source-brief",
    async apply(ctx, config) {
      const engine = ctx.workflowEngine;
      if (!engine) {
        throw new ScenarioError("CALLER_AGENT_REQUIRED", "the target host does not expose workflowEngine; this scenario needs the native workflow engine");
      }
      build = loadBuild(assetsDir);
      const dataDir = resolveDataDir(options, ctx, config);
      const deadlineMs = options.deadlineMs ?? readNumber(config?.["deadlineMs"]) ?? 180_000;

      runtime = createScenarioRuntime({
        engine,
        config: {
          dataDir,
          deadlineMs,
          hostVersion: readString(config?.["hostVersion"]) ?? "unknown",
          engineKind: "host",
          ...(ctx.logger ? { onProgress: (event) => ctx.logger?.info?.(`workflow ${event.type}`) } : {}),
        },
      });
      plugin.runtime = runtime;
      plugin.build = build;

      const tool: HostToolSpec = {
        name: toolName,
        description: SCENARIO_TOOL_DESCRIPTION,
        parameters: {
          topic: { type: "string", required: true, description: "Report topic." },
          materials: {
            type: "array",
            required: true,
            description: "1-4 already-extracted materials: { id, title, text, sourceRef? }.",
          },
          dimensions: { type: "array", required: false, description: "1-6 comparison dimensions." },
          language: { type: "string", required: false, description: "Output language tag, default zh." },
          minSuccessful: { type: "integer", required: false, description: "Materials that must succeed; defaults to all." },
        },
        async execute(args, exec) {
          if (!runtime) throw new ScenarioError("ADMISSION_CLOSED", "the scenario plugin is not applied");
          const currentBuild = plugin.build;
          if (!currentBuild) throw new ScenarioError("BUILD_NOT_FOUND", "scenario assets were not loaded");
          const outcome = await runtime.run(currentBuild, args, exec);
          return summarizeOutcome(outcome);
        },
        render(result) {
          return JSON.stringify(result, null, 2);
        },
      };

      registerTool(ctx, tool);
      const recovery = runtime.recover();
      if (recovery.interrupted.length > 0) {
        ctx.logger?.warn?.(`${recovery.interrupted.length} run(s) from a previous host boot were marked INTERRUPTED`);
      }
      registerSkill(ctx, skillPath, build);

      ctx.effect?.(() => async () => {
        await runtime?.shutdown("plugin unloading");
      });
    },
  };

  return plugin;
}

export function summarizeOutcome(outcome: RunOutcome): JsonValue {
  const summary: Record<string, JsonValue> = {
    runId: outcome.runId,
    state: outcome.state,
    businessStatus: outcome.businessStatus,
    engineStopReason: outcome.engineStopReason,
    agentsStarted: outcome.agentsStarted,
    checks: outcome.checks as unknown as JsonValue,
    artifacts: outcome.artifacts.map((artifact) => artifact.path) as unknown as JsonValue,
    reportPath: outcome.reportPath,
    resultPath: outcome.resultPath,
    error: outcome.error as unknown as JsonValue,
    cleanupError: outcome.cleanupError,
  };
  if (outcome.result?.brief) {
    summary["brief"] = {
      title: outcome.result.brief.title,
      dimensions: outcome.result.brief.dimensions.map((dimension) => dimension.dimension) as unknown as JsonValue,
      conclusions: outcome.result.brief.conclusions.length,
    } as JsonValue;
  }
  if (outcome.result) {
    summary["evidenceCount"] = outcome.result.evidence.evidence.length;
    summary["failedMaterials"] = outcome.result.failedMaterials as unknown as JsonValue;
  }
  return summary as JsonValue;
}

function dirnameOfModule(): string {
  return fileURLToPath(new URL(".", import.meta.url));
}

function registerTool(ctx: PluginContext, tool: HostToolSpec): void {
  if (ctx.tools?.register) {
    ctx.tools.register(tool);
    return;
  }
  if (ctx.tools?.define) {
    ctx.tools.define(tool);
    return;
  }
  throw new ScenarioError("CALLER_AGENT_REQUIRED", "the target host does not expose a tool registry");
}

function registerSkill(ctx: PluginContext, skillPath: string, loaded: LoadedBuild): void {
  if (!ctx.skills?.register) return;
  let body = `# ${loaded.manifest.workflowId}\n\nUse the \`source_brief\` tool with already-extracted text materials.`;
  try {
    body = readFileSync(skillPath, "utf8");
  } catch {
    // The packaged SKILL.md is optional at runtime; the tool still works.
  }
  ctx.skills.register({
    name: loaded.manifest.workflowId,
    description: `Run the installed ${loaded.manifest.workflowId} scenario.`,
    body,
    root: skillPath,
  });
}

function resolveDataDir(options: ScenarioPluginOptions, ctx: PluginContext, config?: Record<string, JsonValue>): string {
  const fromConfig = readString(config?.["dataDir"]);
  const fromOptions = options.dataDir;
  if (fromOptions) return fromOptions;
  if (fromConfig) return fromConfig;
  throw new ScenarioError("INPUT_INVALID", "dataDir must be configured by the host; the model may not choose a write path");
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export type { FileStore };
export { RUNTIME_VERSION, TARGET_ADAPTER_VERSION };
