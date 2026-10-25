/**
 * End-to-end demo without a model.
 *
 * validate -> trial x5 -> package -> "fresh session" run from the packaged bytes.
 * The engine is the offline mock, so records are marked `engineKind: "mock"` and
 * the build stays at verification state `packaged`.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAuthorTools } from "@workflow-forge/author";
import {
  createMockEngine,
  createScenarioRuntime,
  defaultResponder,
  fakeExec,
  loadBuild,
  type MockCallContext,
} from "@workflow-forge/runtime";
import type { JsonValue } from "@workflow-forge/spec";

const root = process.cwd();
const exampleDir = join(root, "examples", "source-brief");
const dataDir = join(root, ".forge", "demo");
const outputDir = join(exampleDir, "packaged");
const freshDir = join(root, ".forge", "fresh-session");

mkdirSync(dataDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });
mkdirSync(freshDir, { recursive: true });

const spec = JSON.parse(readFileSync(join(exampleDir, "spec.json"), "utf8")) as JsonValue;
const fixtures = readdirSync(join(exampleDir, "fixtures"))
  .filter((name) => /^\d\d-.*\.json$/.test(name))
  .sort();

/** The offline stand-in for the model: it also knows which materials it fails. */
const FAILED_LABELS: Array<{ topic: string; labels: string[] }> = [
  { topic: "两个方案", labels: ["m1", "m2"] },
  { topic: "客服知识库迁移", labels: ["m3"] },
];

function responder(context: MockCallContext): JsonValue | null {
  const args = context.args as Record<string, JsonValue>;
  const topic = typeof args["topic"] === "string" ? (args["topic"] as string) : "";
  const failed = FAILED_LABELS.find((entry) => topic.includes(entry.topic))?.labels ?? [];
  if (context.label !== undefined && failed.includes(context.label)) return null;
  if (context.label === "synthesize") return briefFrom(args, failed);
  return defaultResponder(context);
}

/** A readable brief derived from each successful material's first paragraph. */
function briefFrom(args: Record<string, JsonValue>, failed: string[]): JsonValue {
  const materials = Array.isArray(args["materials"]) ? (args["materials"] as JsonValue[]) : [];
  const dimensions = Array.isArray(args["dimensions"]) ? (args["dimensions"] as JsonValue[]).map(String) : [];
  const excerpts = materials
    .filter((entry): entry is Record<string, JsonValue> => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    .filter((entry) => !failed.includes(String(entry["id"] ?? "")))
    .map((entry) => {
      const id = String(entry["id"] ?? "m");
      const title = String(entry["title"] ?? id);
      const paragraphs = Array.isArray(entry["paragraphs"]) ? (entry["paragraphs"] as JsonValue[]) : [];
      const first = paragraphs[0];
      const text =
        first && typeof first === "object" && !Array.isArray(first) && typeof (first as Record<string, JsonValue>)["text"] === "string"
          ? String((first as Record<string, JsonValue>)["text"])
          : "";
      return { id, title, text: text.split("。")[0] ?? text };
    });
  const names = dimensions.length > 0 ? dimensions : ["总体印象"];
  return {
    title: `${String(args["topic"] ?? "资料")}：对比简报`,
    dimensions: names.map((dimension) => ({
      dimension,
      findings: excerpts.slice(0, 3).map((excerpt) => ({
        kind: "fact",
        text: `${excerpt.title}在「${dimension}」上的说法：${excerpt.text}`,
        evidenceIds: [`${excerpt.id}:1`],
      })),
    })),
    conclusions: [
      {
        kind: "fact",
        text: `${excerpts.length} 份材料在 ${names.length} 个维度上都给出了可定位的原文表述，可以作为后续判断的起点。`,
        evidenceIds: excerpts.slice(0, 2).map((excerpt) => `${excerpt.id}:1`),
      },
      {
        kind: "recommendation",
        text: "结构化检查只确认引用可以定位；结论是否成立仍需要按材料抽样核对。",
        evidenceIds: excerpts.length > 0 ? [`${excerpts[0]!.id}:1`] : [],
      },
    ],
  };
}

const mock = createMockEngine({ responder, emitEvents: true, delayMs: 2 });
const author = createAuthorTools({
  dataDir,
  outputDir,
  engine: mock.engine,
  engineKind: "mock",
  hostVersion: "demo-mock",
  now: () => new Date(),
  profile: {
    packageName: "dsh-scenario-source-brief",
    skillBody: readFileSync(join(exampleDir, "SKILL.md"), "utf8"),
    examples: fixtures.map((name) => ({
      path: `examples/fixtures/${name}`,
      content: readFileSync(join(exampleDir, "fixtures", name), "utf8"),
    })),
  },
});

const exec = fakeExec();

async function callTool(name: string, args: Record<string, JsonValue>): Promise<JsonValue> {
  const tool = author.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  return tool.execute(args, exec);
}

function line(text = ""): void {
  console.log(text);
}

line("== 1. forge_validate ==");
const validated = (await callTool("forge_validate", { spec })) as Record<string, JsonValue>;
if (validated["ok"] !== true) {
  console.error(JSON.stringify(validated, null, 2));
  process.exit(1);
}
const draftRef = String(validated["draftRef"]);
line(`draftRef: ${draftRef}`);
line(`staticReport: ${JSON.stringify(validated["staticReport"])}`);
line();

line("== 2. forge_trial (5 fixtures) ==");
const trials: Array<{ fixture: string; runId: string; state: string; inputHash: string }> = [];
for (const fixture of fixtures) {
  const input = JSON.parse(readFileSync(join(exampleDir, "fixtures", fixture), "utf8")) as JsonValue;
  const result = (await callTool("forge_trial", { draftRef, input })) as Record<string, JsonValue>;
  const summary = {
    fixture,
    runId: String(result["runId"] ?? ""),
    state: String(result["state"] ?? "UNKNOWN"),
    inputHash: String(result["inputHash"] ?? ""),
  };
  trials.push(summary);
  line(`${fixture.padEnd(24)} ${summary.state.padEnd(20)} ${summary.inputHash.slice(0, 23)}`);
}
line();

line("== 3. forge_package (3 completed trials with distinct inputs) ==");
const completed = trials.filter((trial) => trial.state === "COMPLETED").map((trial) => trial.runId);
const packaged = (await callTool("forge_package", { draftRef, trialRunIds: completed as unknown as JsonValue })) as Record<string, JsonValue>;
if (packaged["ok"] !== true) {
  console.error(JSON.stringify(packaged, null, 2));
  process.exit(1);
}
const bundleDir = String(packaged["bundleDir"]);
const buildHash = String(packaged["buildHash"]);
line(`buildHash: ${buildHash}`);
line(`bundleDir: ${bundleDir}`);
line(`verification: ${JSON.stringify(packaged["verification"])}`);
line();

line("== 4. 独立运行：新会话数据目录 + 打包产物（不加载作者插件）==");
const build = loadBuild(join(bundleDir, "assets"));
const fresh = createScenarioRuntime({
  engine: mock.engine,
  config: { dataDir: freshDir, hostVersion: "demo-mock", engineKind: "mock" },
});
const freshInput = JSON.parse(readFileSync(join(exampleDir, "fixtures", "01-normal.json"), "utf8")) as JsonValue;
const freshOutcome = await fresh.run(build, freshInput, fakeExec());
line(`state: ${freshOutcome.state} | businessStatus: ${freshOutcome.businessStatus}`);
line(`runId: ${freshOutcome.runId}`);
line(`agentsStarted: ${String(freshOutcome.agentsStarted)}`);
line(`report: ${freshOutcome.reportPath}`);
line(`checks: ${freshOutcome.checks.map((check) => `${check.rule}=${check.ok}`).join(", ")}`);
line();

line("== 5. 失败路径：材料不足 ==");
const insufficientInput = JSON.parse(readFileSync(join(exampleDir, "fixtures", "04-insufficient.json"), "utf8")) as JsonValue;
const insufficient = await fresh.run(build, insufficientInput, fakeExec());
line(`state: ${insufficient.state} | businessStatus: ${insufficient.businessStatus} | reportPath: ${insufficient.reportPath}`);
line();

line("== 6. 报告片段 ==");
if (freshOutcome.reportPath) {
  const report = readFileSync(freshOutcome.reportPath, "utf8");
  line(report.split("\n").slice(0, 26).join("\n"));
}

writeFileSync(
  join(outputDir, "DEMO-SUMMARY.md"),
  [
    `# Demo summary`,
    "",
    `- draftRef: \`${draftRef}\``,
    `- buildHash: \`${buildHash}\``,
    `- bundleDir: \`${bundleDir}\``,
    `- verification: \`${JSON.stringify(packaged["verification"])}\``,
    "",
    "| fixture | state | inputHash |",
    "| --- | --- | --- |",
    ...trials.map((trial) => `| ${trial.fixture} | ${trial.state} | \`${trial.inputHash}\` |`),
  ].join("\n"),
  "utf8",
);

line();
line("demo complete");
