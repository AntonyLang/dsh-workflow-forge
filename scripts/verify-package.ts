/**
 * Verify the distributable artifact, not the source tree.
 *
 * 1. pack packages/scenario-source-brief into a tarball;
 * 2. install it into a throwaway project (no workspace, no dev dependencies);
 * 3. apply the installed plugin to a fake host context and run the packaged
 *    workflow script with a local mock engine;
 * 4. require a COMPLETED run with a written report and a run record.
 *
 * This is still not a real DSH host: it proves that the bytes npm would receive
 * actually load, register their tool and skill, and execute end to end.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const packageDir = join(root, "packages", "scenario-source-brief");
const workspace = mkdtempSync(join(tmpdir(), "wf-install-"));
const fromRegistry = process.argv.includes("--from-registry");

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, encoding: "utf8", stdio: "pipe" });
}

console.log(`workspace: ${workspace}`);
console.log(fromRegistry ? "mode: install from the public npm registry" : "mode: install from a local tarball");

if (!fromRegistry) run(`npm pack "${packageDir}" --pack-destination "${workspace}"`, root);
const projectDir = join(workspace, "project");
run(`mkdir "${projectDir}"`, workspace);
run(`npm init -y --silent`, projectDir);
if (fromRegistry) {
  run(`npm install --silent --no-audit --no-fund --legacy-peer-deps --ignore-scripts dsh-scenario-source-brief@0.1.0 --registry=https://registry.npmjs.org`, projectDir);
} else {
  run(`npm install --silent --no-audit --no-fund --legacy-peer-deps --ignore-scripts "${workspace}\\dsh-scenario-source-brief-0.1.0.tgz"`, projectDir);
}
console.log("installed dsh-scenario-source-brief into a clean project");

const harness = String.raw`
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const plugin = await import("dsh-scenario-source-brief");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function mockEngine() {
  return {
    on() { return () => {}; },
    start(request) {
      const fn = new AsyncFunction("agent", "parallel", "log", "phase", "args", request.script);
      const result = (async () => {
        const materials = Array.isArray(request.args.materials) ? request.args.materials : [];
        const agent = async (prompt, options) => {
          const properties = (options && options.schema && options.schema.properties) || {};
          if (properties.facts) {
            const material = materials.find((entry) => entry.id === options.label) || materials[0];
            const paragraph = material && material.paragraphs && material.paragraphs[0];
            if (!paragraph) return null;
            return { facts: [{ paragraphId: paragraph.paragraphId, quote: paragraph.text.slice(0, 20), statement: "mock fact for " + material.id }] };
          }
          if (properties.dimensions && properties.conclusions) {
            const dimensions = Array.isArray(request.args.dimensions) ? request.args.dimensions : ["概述"];
            const ids = materials.map((entry) => entry.id + ":1");
            return {
              title: "验证报告",
              dimensions: dimensions.map((dimension) => ({
                dimension,
                findings: [{ kind: "fact", text: "关于 " + dimension + " 的事实", evidenceIds: [ids[0]] }],
              })),
              conclusions: [{ kind: "fact", text: "总体结论", evidenceIds: ids.slice(0, 2) }],
            };
          }
          return null;
        };
        const parallel = async (thunks) => Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)));
        const value = await fn(agent, parallel, () => {}, () => {}, request.args);
        return { stopReason: "completed", value };
      })();
      return { id: "verify-engine-run", result, dispose: async () => {} };
    },
  };
}

const registered = { tools: [], skills: [], disposers: [] };
const dataDir = join(process.cwd(), ".verify-data");
const ctx = {
  workflowEngine: mockEngine(),
  tools: { register(tool) { registered.tools.push(tool); } },
  skills: { register(skill) { registered.skills.push(skill); } },
  effect(register) { const dispose = register(); if (typeof dispose === "function") registered.disposers.push(dispose); },
  logger: { info() {}, warn() {}, error() {} },
};

await plugin.apply(ctx, { dataDir, hostVersion: "verify-install", engineKind: "mock" });
const tool = registered.tools[0];
if (!tool) throw new Error("the installed plugin registered no tool");

const materials = [
  { id: "m1", title: "材料一", text: "第一段原文。\n第二段原文。" },
  { id: "m2", title: "材料二", text: "另一段原文。" },
];
const outcome = await tool.execute(
  { topic: "安装产物验证", materials, dimensions: ["成本", "风险"], language: "zh", minSuccessful: 2 },
  { agent: { id: "verify-agent" }, signal: new AbortController().signal },
);

const reportPath = outcome.reportPath;
const report = reportPath && existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
const recordPath = outcome.runId ? join(dataDir, "runs", outcome.runId, "run.json") : "";
const record = recordPath && existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null;

for (const dispose of registered.disposers) await dispose();

console.log(JSON.stringify({
  exports: { name: plugin.name, apply: typeof plugin.apply, inject: plugin.inject },
  toolName: tool.name,
  skillName: registered.skills[0] && registered.skills[0].name,
  state: outcome.state,
  businessStatus: outcome.businessStatus,
  agentsStarted: outcome.agentsStarted,
  reportHasDimensions: report.includes("## 逐维度比较"),
  reportHasEvidence: report.includes("m1:1"),
  recordState: record && record.state,
  recordEngineKind: record && record.engineKind,
}, null, 2));
`;

writeFileSync(join(projectDir, "verify.mjs"), harness, "utf8");
const output = run("node verify.mjs", projectDir);
console.log(output);

const parsed = JSON.parse(output) as Record<string, unknown>;
const checks: Array<[string, boolean]> = [
  ["plugin exports apply", parsed["exports"] !== undefined && (parsed["exports"] as Record<string, unknown>)["apply"] === "function"],
  ["tool registered", typeof parsed["toolName"] === "string" && parsed["toolName"] === "source_brief"],
  ["skill registered", parsed["skillName"] === "source-brief"],
  ["run completed", parsed["state"] === "COMPLETED"],
  ["report rendered", parsed["reportHasDimensions"] === true && parsed["reportHasEvidence"] === true],
  ["record written", parsed["recordState"] === "COMPLETED"],
];

let failed = false;
for (const [label, ok] of checks) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log("installed-artifact verification passed");
