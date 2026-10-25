/**
 * Author plugin: registers the four forge tools and the author Skill.
 *
 * The author package is an authoring environment only. The shipped scenario
 * package never depends on it, and unloading it must leave existing runs
 * finishing through the wrapper's own cancel-and-drain path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@workflow-forge/spec";
import { ScenarioError, type PluginContext, type ToolExecContext, type WorkflowEngine } from "@workflow-forge/runtime";
import { createAuthorTools, type AuthorApi, type AuthorProfile } from "./tools.js";

export type AuthorPluginOptions = {
  dataDir?: string;
  outputDir?: string;
  engine?: WorkflowEngine;
  deadlineMs?: number;
  hostVersion?: string;
  engineKind?: "host" | "mock";
  profile?: AuthorProfile;
  skillPath?: string;
  now?: () => Date;
};

export type AuthorPlugin = {
  name: string;
  apply(ctx: PluginContext, config?: Record<string, JsonValue>): Promise<void>;
  api?: AuthorApi;
};

export const AUTHOR_TOOL_NAMES = ["forge_validate", "forge_trial", "forge_package", "forge_inspect"] as const;

export function createAuthorPlugin(options: AuthorPluginOptions = {}): AuthorPlugin {
  const plugin: AuthorPlugin = {
    name: "dsh-workflow-forge-author",
    async apply(ctx, config) {
      const engine = options.engine ?? ctx.workflowEngine;
      if (!engine) {
        throw new ScenarioError(
          "CALLER_AGENT_REQUIRED",
          "the author plugin needs workflowEngine; without it candidates cannot be trialled",
        );
      }
      const dataDir = options.dataDir ?? readString(config?.["dataDir"]);
      if (!dataDir) {
        throw new ScenarioError("INPUT_INVALID", "the author plugin requires a host-provided dataDir");
      }
      const outputDir = options.outputDir ?? readString(config?.["outputDir"]) ?? `${dataDir}\\packages`;

      const api = createAuthorTools({
        dataDir,
        outputDir,
        engine,
        ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
        ...(options.hostVersion !== undefined ? { hostVersion: options.hostVersion } : {}),
        ...(options.engineKind !== undefined ? { engineKind: options.engineKind } : {}),
        ...(options.profile !== undefined ? { profile: options.profile } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      plugin.api = api;

      for (const tool of api.tools) {
        registerTool(ctx, {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execute: (args: Record<string, JsonValue>, exec: ToolExecContext) => tool.execute(args, exec),
        });
      }

      const skillPath = options.skillPath ?? fileURLToPath(new URL("../skills/forge/SKILL.md", import.meta.url));
      if (ctx.skills?.register) {
        let body = "# Workflow Forge\n\nUse forge_validate, then forge_trial twice, then forge_package.";
        try {
          body = readFileSync(skillPath, "utf8");
        } catch {
          // A missing skill file must not prevent the tools from being registered.
        }
        ctx.skills.register({
          name: "forge",
          description: "Turn a proven task into a checked, trialled, packaged DSH scenario plugin.",
          body,
          root: skillPath,
        });
      }

      ctx.effect?.(() => async () => {
        await api.shutdown();
      });
      api.getRuntime().recover();
    },
  };
  return plugin;
}

function registerTool(
  ctx: PluginContext,
  tool: {
    name: string;
    description: string;
    parameters: Record<string, { type: string; required?: boolean; description: string }>;
    execute(args: Record<string, JsonValue>, exec: ToolExecContext): Promise<JsonValue>;
  },
): void {
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

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
