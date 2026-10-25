/**
 * Native ESM bundle for the scenario package.
 *
 * DSH and Cordis packages are external peers: the bundle imports nothing from
 * them, and the host resolves those relationships from the manifest. Everything
 * the scenario needs at run time (thin runtime, checks, risk-free helpers) is
 * bundled in.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = new URL(".", import.meta.url);

export function workspaceAliases(): Record<string, string> {
  return {
    "@workflow-forge/runtime": fileURLToPath(new URL("../../runtime/src/index.ts", PACKAGE_ROOT)),
    "@workflow-forge/checks": fileURLToPath(new URL("../../checks/src/index.ts", PACKAGE_ROOT)),
    "@workflow-forge/spec": fileURLToPath(new URL("../../spec/src/index.ts", PACKAGE_ROOT)),
  };
}

export const PLUGIN_ENTRY = `import { createScenarioPlugin } from "@workflow-forge/runtime";

const plugin = createScenarioPlugin();

export const name = plugin.name;
export const inject = ["workflowEngine"];

export function apply(ctx, config) {
  return plugin.apply(ctx, config ?? {});
}
`;

export type BundleResult =
  | { ok: true; bytes: number; warnings: number }
  | { ok: false; message: string };

export async function bundlePlugin(outfile: string, entry: string = PLUGIN_ENTRY): Promise<BundleResult> {
  try {
    const result = await build({
      stdin: {
        contents: entry,
        resolveDir: fileURLToPath(new URL(".", import.meta.url)),
        sourcefile: "scenario-plugin-entry.ts",
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      outfile,
      alias: workspaceAliases(),
      external: ["@deepseek-ai/*"],
      legalComments: "none",
      logLevel: "silent",
      metafile: false,
    });
    return { ok: true, bytes: result.outputFiles?.[0]?.contents.byteLength ?? 0, warnings: result.warnings.length };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
