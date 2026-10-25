/**
 * Failure showcase.
 *
 * Three layers of failure, each with the diagnostic a user would actually see:
 * 1. static analysis rejects a definition before any code runs;
 * 2. a run produces a report that cites evidence which does not exist;
 * 3. packaging refuses stale trial records.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "@workflow-forge/compiler";
import { createAuthorTools } from "@workflow-forge/author";
import { createMockEngine, createScenarioRuntime, defaultResponder, fakeExec } from "@workflow-forge/runtime";
import type { JsonValue } from "@workflow-forge/spec";
import { RUNTIME_ARTIFACT_HASH, CHECKS_HASH } from "@workflow-forge/author";
import { TARGET_ADAPTER_VERSION } from "@workflow-forge/runtime";
import { loadFixture, tempDir } from "../tests/support/helpers.js";

const root = process.cwd();
const exampleDir = join(root, "examples", "source-brief");
const spec = JSON.parse(readFileSync(join(exampleDir, "spec.json"), "utf8")) as Record<string, unknown>;

function header(title: string): void {
  console.log(`\n== ${title} ==`);
}

function printDiagnostics(diagnostics: Array<Record<string, unknown>>): void {
  for (const diagnostic of diagnostics) {
    const where = [diagnostic["nodeId"] ? `node ${diagnostic["nodeId"]}` : "", diagnostic["fieldPath"]].filter(Boolean).join(" ");
    console.log(`  ${diagnostic["code"]}  ${where}`);
    console.log(`    ${diagnostic["message"]}`);
    if (diagnostic["fix"]) console.log(`    修复方向：${diagnostic["fix"]}`);
  }
}

header("A1 静态拒绝：引用未来节点");
{
  const broken = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  const steps = broken["steps"] as Array<Record<string, unknown>>;
  const collect = steps[1]!;
  collect["bindings"] = {
    materials: { ref: { scope: "input", path: ["materials"] } },
    results: { ref: { scope: "node", node: "synthesize", path: [] } },
  };
  const result = await compile(broken, {
    runtimeArtifactHash: RUNTIME_ARTIFACT_HASH,
    checksHash: CHECKS_HASH,
    targetAdapterVersion: TARGET_ADAPTER_VERSION,
  });
  console.log(`  compiled: ${result.ok}`);
  if (!result.ok) printDiagnostics(result.diagnostics as unknown as Array<Record<string, unknown>>);
}

header("A2 静态拒绝：agent schema 使用 minLength");
{
  const broken = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  const assets = broken["assets"] as Record<string, Record<string, unknown>>;
  const schemas = assets["schemas"] as Record<string, Record<string, unknown>>;
  const brief = schemas["Brief"] as Record<string, unknown>;
  const properties = brief["properties"] as Record<string, Record<string, unknown>>;
  properties["title"] = { type: "string", minLength: 8 };
  const result = await compile(broken, {
    runtimeArtifactHash: RUNTIME_ARTIFACT_HASH,
    checksHash: CHECKS_HASH,
    targetAdapterVersion: TARGET_ADAPTER_VERSION,
  });
  console.log(`  compiled: ${result.ok}`);
  if (!result.ok) printDiagnostics(result.diagnostics.slice(0, 4) as unknown as Array<Record<string, unknown>>);
}

header("A3 静态拒绝：branch 不在末尾");
{
  const broken = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  const steps = broken["steps"] as Array<Record<string, unknown>>;
  const branch = steps.pop()!;
  steps.unshift(branch);
  const result = await compile(broken, {
    runtimeArtifactHash: RUNTIME_ARTIFACT_HASH,
    checksHash: CHECKS_HASH,
    targetAdapterVersion: TARGET_ADAPTER_VERSION,
  });
  console.log(`  compiled: ${result.ok}`);
  if (!result.ok) printDiagnostics(result.diagnostics.slice(0, 4) as unknown as Array<Record<string, unknown>>);
}

header("B 运行失败：结论引用了不存在的 evidenceId");
{
  const dataDir = tempDir("wf-failure-");
  const mock = createMockEngine({
    responder: (context) =>
      context.label === "synthesize"
        ? {
            title: "引用不存在的证据",
            dimensions: [{ dimension: "同步与离线", findings: [{ kind: "fact", text: "x", evidenceIds: ["m9:9"] }] }],
            conclusions: [{ kind: "fact", text: "y", evidenceIds: ["m9:9"] }],
          }
        : defaultResponder(context),
  });
  const compiled = await compile(spec, {
    runtimeArtifactHash: RUNTIME_ARTIFACT_HASH,
    checksHash: CHECKS_HASH,
    targetAdapterVersion: TARGET_ADAPTER_VERSION,
  });
  if (!compiled.ok) throw new Error("example no longer compiles");
  const runtime = createScenarioRuntime({ engine: mock.engine, config: { dataDir, engineKind: "mock" } });
  const build = {
    manifest: {
      manifestVersion: "0.1" as const,
      workflowId: "source-brief",
      workflowVersion: "0.1.0",
      specVersion: "0.1",
      specHash: compiled.specHash,
      draftHash: compiled.draftHash ?? "sha256:draft",
      scriptHash: compiled.scriptHash,
      assetsHash: compiled.specHash,
      checksHash: CHECKS_HASH,
      runtimeArtifactHash: RUNTIME_ARTIFACT_HASH,
      compilerVersion: "0.1.0",
      runtimeVersion: "0.1.0",
      targetAdapterVersion: TARGET_ADAPTER_VERSION,
      limits: compiled.workflow.spec.limits,
      worstCaseAgents: compiled.workflow.worstCaseAgents,
      agents: compiled.staticReport.agents,
      prompts: [],
      schemas: [],
      trials: [],
      verification: { state: "packaged" as const, runtimeVerified: false, notes: [] },
      builtAt: "2026-10-25T00:00:00.000Z",
    },
    script: compiled.script,
    meta: compiled.meta,
    assetsDir: dataDir,
  };
  const outcome = await runtime.run(build, loadFixture("01-normal.json"), fakeExec());
  console.log(`  state: ${outcome.state}`);
  console.log(`  businessStatus: ${String(outcome.businessStatus)}`);
  console.log(`  reportPath: ${String(outcome.reportPath)}`);
  console.log(`  error: ${JSON.stringify(outcome.error)}`);
  console.log("  说明：引擎完成了脚本，但业务检查拒绝生成成功报告；这不是编排故障。");
}

header("C1 打包拒绝：只有一份试跑");
{
  const dataDir = tempDir("wf-pkg-fail-");
  const outputDir = tempDir("wf-pkg-fail-out-");
  const mock = createMockEngine({ responder: defaultResponder });
  const author = createAuthorTools({ dataDir, outputDir, engine: mock.engine, engineKind: "mock" });
  const exec = fakeExec();
  const validate = author.tools.find((tool) => tool.name === "forge_validate")!;
  const trial = author.tools.find((tool) => tool.name === "forge_trial")!;
  const pack = author.tools.find((tool) => tool.name === "forge_package")!;
  const validated = (await validate.execute({ spec: spec as JsonValue }, exec)) as Record<string, JsonValue>;
  const draftRef = String(validated["draftRef"]);
  await trial.execute({ draftRef, input: loadFixture("01-normal.json") }, exec);
  const packaged = (await pack.execute({ draftRef }, exec)) as Record<string, unknown>;
  console.log(`  ok: ${String(packaged["ok"])}`);
  printDiagnostics((packaged["diagnostics"] ?? []) as Array<Record<string, unknown>>);
  await author.shutdown();
}

header("C2 打包拒绝：改了提示词后复用旧试跑");
{
  const dataDir = tempDir("wf-pkg-stale-");
  const outputDir = tempDir("wf-pkg-stale-out-");
  const mock = createMockEngine({ responder: defaultResponder });
  const author = createAuthorTools({ dataDir, outputDir, engine: mock.engine, engineKind: "mock" });
  const exec = fakeExec();
  const validate = author.tools.find((tool) => tool.name === "forge_validate")!;
  const trial = author.tools.find((tool) => tool.name === "forge_trial")!;
  const pack = author.tools.find((tool) => tool.name === "forge_package")!;

  const validated = (await validate.execute({ spec: spec as JsonValue }, exec)) as Record<string, JsonValue>;
  const draftRef = String(validated["draftRef"]);
  await trial.execute({ draftRef, input: loadFixture("01-normal.json") }, exec);
  await trial.execute({ draftRef, input: loadFixture("02-conflicting.json") }, exec);

  // Edit the prompt and validate again: a new candidate, but the old trials remain on disk.
  const edited = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  const assets = edited["assets"] as Record<string, Record<string, string>>;
  assets["prompts"]!["extract"] = `${assets["prompts"]!["extract"]}\n\n补充：引用必须逐字摘录。`;
  const revalidated = (await validate.execute({ spec: edited as JsonValue }, exec)) as Record<string, JsonValue>;
  const newDraftRef = String(revalidated["draftRef"]);
  console.log(`  old draftRef: ${draftRef}`);
  console.log(`  new draftRef: ${newDraftRef}`);
  console.log(`  draft identity changed: ${draftRef !== newDraftRef}`);

  // Packaging the new candidate with only the old trials must fail.
  const staleTrials = author.trialStore.list(author.draftStore.load(draftRef).dir).map((entry) => entry.runId);
  const packaged = (await pack.execute({ draftRef: newDraftRef, trialRunIds: staleTrials as unknown as JsonValue }, exec)) as Record<string, unknown>;
  console.log(`  ok: ${String(packaged["ok"])}`);
  printDiagnostics((packaged["diagnostics"] ?? []) as Array<Record<string, unknown>>);
  await author.shutdown();
}

console.log("\nfailure demo complete");
