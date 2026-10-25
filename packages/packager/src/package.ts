/**
 * Scenario package assembly.
 *
 * The packager reads real trial records, refuses to build on missing, mismatched
 * or unpassed trials, and writes a versioned directory so a new version never
 * overwrites old assets. It does not publish, upload or install anything: those
 * remain explicit host operations whose result is recorded as verification state.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DIAGNOSTIC_CODES,
  diagnostic,
  hasErrors,
  sha256Hex,
  type Diagnostic,
  type WorkflowSpec,
} from "@workflow-forge/spec";
import type { MaterializedAsset, StaticReport } from "@workflow-forge/compiler";
import type { BuildManifest, BuildTrialRef, BuildVerificationState, RunState } from "@workflow-forge/runtime";
import { computeAssetsHash, computeBuildHash } from "./hash.js";
import { bundlePlugin } from "./bundle.js";

export type DraftSnapshot = {
  draftRef: string;
  draftHash: string;
  spec: WorkflowSpec;
  specHash: string;
  script: string;
  scriptHash: string;
  meta: { name: string; phases: string[] };
  assets: MaterializedAsset[];
  staticReport: StaticReport;
  compilerVersion: string;
  runtimeVersion: string;
  runtimeArtifactHash: string;
  checksHash: string;
  targetAdapterVersion: string;
};

export type TrialRecord = {
  runId: string;
  draftHash: string;
  specHash: string;
  scriptHash: string;
  runtimeArtifactHash: string;
  checksHash: string;
  compilerVersion: string;
  inputHash: string;
  state: RunState;
  businessStatus: string | null;
  engineKind: "host" | "mock";
  startedAt: string;
  reportPath: string | null;
};

export type PackageRequest = {
  draft: DraftSnapshot;
  trials: TrialRecord[];
  /** Parent directory; the build is written to <outputDir>/<buildHash>/<packageName>/. */
  outputDir: string;
  /**
   * Exact output directory for a checked-in, publishable package. When set, the
   * versioned directory layout is skipped; immutability comes from git history and
   * the hashes recorded in assets/build.json instead.
   */
  targetDir?: string;
  packageName?: string;
  dshVersion?: string;
  licenseText?: string;
  repository?: string;
  skillBody?: string;
  readme?: string;
  examples?: Array<{ path: string; content: string }>;
  now?: () => Date;
  skipBundle?: boolean;
};

export type PackageOk = {
  ok: true;
  buildHash: string;
  packageDir: string;
  manifest: BuildManifest;
  verification: BuildManifest["verification"];
  files: string[];
};

export type PackageFailure = { ok: false; diagnostics: Diagnostic[]; buildHash?: string };
export type PackageResult = PackageOk | PackageFailure;

const DEFAULT_SKILL = (workflowId: string): string => `---
name: ${workflowId}
description: 运行已安装的 ${workflowId} 场景，把已读取的文本材料变成带证据引用的结构化报告。
---

# ${workflowId}

当用户提供了 1 至 4 份**已经读取成文本**的材料，并希望得到一份按维度比较、结论可回溯到原文片段的结构化报告时，使用本场景。

## 调用

调用工具 \`${workflowId.replace(/-/g, "_")}\`，参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| topic | 是 | 报告主题，一句话 |
| materials | 是 | 1-4 份材料，每份 \`{ id, title, text, sourceRef? }\`；\`id\` 只用于本场景，不要放文件路径 |
| dimensions | 否 | 1-6 个比较维度，重复项会被拒绝 |
| language | 否 | 输出语言，默认 \`zh\` |
| minSuccessful | 否 | 至少要成功的材料数，默认等于材料总数 |

## 结果处理

- \`state\` 为 \`COMPLETED\`：用 \`reportPath\` 的内容作为回答主体，并说明未覆盖材料。
- \`state\` 为 \`INSUFFICIENT_INPUT\`：不要伪造报告，向用户说明哪些材料失败以及下一步。
- \`state\` 为 \`CANCELLED\` / \`FAILED\` / \`UNKNOWN\`：按 \`error.code\` 解释，不要重试同一个 runId。
- 任何重新运行都会生成新的 runId。
`;

const DEFAULT_README = (manifest: BuildManifest, packageName: string, buildHash: string): string => `# ${packageName}

DSH 场景插件：${manifest.workflowId}@${manifest.workflowVersion}

把已读取的文本材料抽取为可定位证据，再按指定维度生成带 \`evidenceId\` 引用的结构化报告（JSON + Markdown）。报告由固定模板渲染，用户材料只作为数据进入。

## 一次调用

输入：

\`\`\`json
{
  "topic": "三款笔记应用的取舍",
  "materials": [{ "id": "m1", "title": "访谈记录", "text": "第一段……\\n第二段……" }],
  "dimensions": ["同步与离线", "检索与整理"],
  "language": "zh",
  "minSuccessful": 1
}
\`\`\`

输出（canonical JSON）：\`runId\`、\`state\`、\`businessStatus\`、\`checks\`、\`reportPath\`、\`resultPath\`、\`error\`。

## 安装

1. 从 npm 安装：\`dsh plugin add ${packageName}\`；
   离线或尚未发布时，用目标 DSH 版本的 Plugin Manager 指向本目录（或仓库中该子目录）。
2. **配置 \`dataDir\`**：必须是宿主允许的绝对目录。运行输入、报告与记录都写在这里；模型不能选择写入路径。
3. 在**新会话**中调用工具 \`${manifest.workflowId.replace(/-/g, "_")}\`。

## 内容

| 路径 | 作用 |
| --- | --- |
| \`dist/index.js\` | 场景工具、Skill 注册、薄 runtime 与校验器（ESM bundle，无 \`@deepseek-ai/*\` import） |
| \`assets/workflow.js\` | 固定脚本，原生 workflow 引擎实际执行的字节 |
| \`assets/workflow.json\` | 固定 WorkflowSpec，供解释与复核 |
| \`assets/build.json\` | 版本、hash、依赖与验证摘要 |
| \`assets/prompts\`、\`assets/schemas\` | 本版提示词与数据契约 |
| \`skills/${manifest.workflowId}/SKILL.md\` | 调用场景、参数说明、结果处理 |
| \`examples\` | 脱敏输入与失败案例说明 |
| \`cordis.patch.yml\` | 宿主 bundle 的 insert 入口 |

## 结果处理

| state | 该做什么 |
| --- | --- |
| \`COMPLETED\` | 用 \`reportPath\` 的内容作为回答主体，并说明"未覆盖材料"一节 |
| \`INSUFFICIENT_INPUT\` | 不要伪造报告；说明失败材料与下一步，或询问是否降低 \`minSuccessful\` |
| \`FAILED\` | 按 \`error.code\` 解释；\`ASSERTION_FAILED\` 表示引用/维度检查没通过 |
| \`CANCELLED\` / \`UNKNOWN\` | 说明取消来源或查看 runId 记录；重跑一定是新 runId |

## 兼容性

| 项 | 值 |
| --- | --- |
| \`engines.dsh\` | \`0.2.1-rc.3\`（方案源码基线提交 \`22ddee3\`） |
| target adapter | \`${manifest.targetAdapterVersion}\` |
| compiler | \`${manifest.compilerVersion}\` |
| runtime | \`${manifest.runtimeVersion}\` |
| 验证状态 | \`${manifest.verification.state}\` |
${manifest.verification.runtimeVerified ? "" : "\n> 本构建的试跑来自离线 mock 引擎，因此只记录为 `packaged`；真实模型与真实宿主的贯通需要另一次 host 试跑。\n"}
## 版本与 hash

- \`specHash\`: \`${manifest.specHash}\`
- \`scriptHash\`: \`${manifest.scriptHash}\`
- \`draftHash\`: \`${manifest.draftHash}\`
- \`buildHash\`: \`${buildHash}\`

安装不等于业务可用：安装证明 \`exports\`、依赖与 profile 配置正确，业务试跑才证明模型结构化输出与文件策略能一起工作。

## 边界

- 只处理已读取的文本；不读文件、不联网、不负责把 URL 变成文本。
- 不提供跨重启恢复；\`run.json\` 是诊断记录，不是断点。
- 结构化检查只证明 quote 可定位、evidenceId 存在、维度齐全，**不证明事实判断正确**。
- 不包含作者插件或编译器，运行期不解释 WorkflowSpec。
- 不包含任何模型密钥、用户材料或运行记录。

## License

MIT
`;

export async function packageScenario(request: PackageRequest): Promise<PackageResult> {
  const { draft, trials } = request;
  const diagnostics: Diagnostic[] = [];

  // 1. The static report must be valid and describe this exact draft.
  const report = draft.staticReport;
  if (report.selfCheck !== "passed") {
    diagnostics.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.STATIC_REPORT_INVALID,
        fieldPath: "staticReport/selfCheck",
        message: `the static report is "${report.selfCheck}"; a package requires a passing self-check`,
        fix: "fix the definition and validate it again",
      }),
    );
  }
  if (report.errors > 0) {
    diagnostics.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.STATIC_REPORT_INVALID,
        fieldPath: "staticReport/errors",
        message: `the static report still lists ${report.errors} error(s)`,
      }),
    );
  }
  if (report.specHash !== draft.specHash || report.scriptHash !== draft.scriptHash) {
    diagnostics.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.STATIC_REPORT_INVALID,
        fieldPath: "staticReport",
        message: "the static report does not describe this draft's spec and script bytes",
        fix: "recompile the definition instead of reusing an older report",
      }),
    );
  }

  // 2. Trials: at least two distinct inputs, all passed, all matching this draft.
  if (trials.length < 2) {
    diagnostics.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.TRIAL_REQUIRED,
        fieldPath: "trials",
        message: `at least 2 trials are required, got ${trials.length}`,
        fix: "run the scenario on the original sample and on a second input with different materials or topic",
      }),
    );
  }
  const inputHashes = new Set<string>();
  for (const trial of trials) {
    const at = `trials/${trial.runId}`;
    if (trial.draftHash !== draft.draftHash) {
      diagnostics.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.TRIAL_IDENTITY_MISMATCH,
          fieldPath: at,
          message: `trial was produced from draft ${trial.draftHash}, not ${draft.draftHash}`,
          fix: "re-run the trial against the current draft; changing a prompt or the runtime also invalidates old trials",
        }),
      );
    }
    for (const key of ["specHash", "scriptHash", "runtimeArtifactHash", "checksHash", "compilerVersion"] as const) {
      if (trial[key] !== draft[key]) {
        diagnostics.push(
          diagnostic({
            code: DIAGNOSTIC_CODES.TRIAL_IDENTITY_MISMATCH,
            fieldPath: at,
            message: `trial ${key} ${String(trial[key])} does not match the draft ${String(draft[key])}`,
            fix: "re-run the trial; asset bytes and implementation identity must match before packaging",
          }),
        );
      }
    }
    if (trial.state !== "COMPLETED") {
      diagnostics.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.TRIAL_NOT_PASSED,
          fieldPath: at,
          message: `trial state is ${trial.state}; only COMPLETED trials can prove the scenario`,
          fix: "fix the failing path and run a new trial (a new run id)",
        }),
      );
    }
    inputHashes.add(trial.inputHash);
  }
  if (trials.length >= 2 && inputHashes.size < 2) {
    diagnostics.push(
      diagnostic({
        code: DIAGNOSTIC_CODES.TRIAL_INPUTS_NOT_DISTINCT,
        fieldPath: "trials",
        message: "the trials used the same input hash twice; a second, genuinely different input is required",
        fix: "change the materials or the topic, not only whitespace",
      }),
    );
  }
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };

  // 3. Asset list and build identity.
  const assetEntries = draft.assets.map((asset) => ({
    path: `assets/${asset.kind === "prompt" ? "prompts" : "schemas"}/${asset.fileName}`,
    hash: asset.hash,
    content: asset.content,
  }));
  const scriptHash = report.scriptHash;
  const workflowJson = JSON.stringify(draft.spec, null, 2) + "\n";
  const workflowHash = hashOf(workflowJson);
  const allAssets = [
    ...assetEntries,
    { path: "assets/workflow.js", hash: scriptHash, content: draft.script },
    { path: "assets/workflow.json", hash: workflowHash, content: workflowJson },
  ];
  const assetsHash = computeAssetsHash(allAssets.map(({ path, content }) => ({ path, content })));
  const buildHash = computeBuildHash({
    draftHash: draft.draftHash,
    scriptHash,
    compilerVersion: draft.compilerVersion,
    runtimeVersion: draft.runtimeVersion,
    targetAdapterVersion: draft.targetAdapterVersion,
    assets: allAssets.map(({ path, hash }) => ({ path, hash })),
  });

  const mockTrials = trials.filter((trial) => trial.engineKind === "mock");
  const verification: BuildManifest["verification"] = {
    state: "packaged",
    runtimeVerified: false,
    notes: [
      mockTrials.length > 0
        ? `${mockTrials.length} of ${trials.length} trial(s) ran against the offline mock engine; runtime_verified still requires a host trial`
        : "trials ran against the host engine",
    ],
  };

  const packageName = request.packageName ?? `dsh-scenario-${draft.spec.workflowId}`;
  const builtAt = (request.now?.() ?? new Date()).toISOString();
  const manifest: BuildManifest = {
    manifestVersion: "0.1",
    workflowId: draft.spec.workflowId,
    workflowVersion: draft.spec.version,
    specVersion: draft.spec.specVersion,
    specHash: draft.specHash,
    draftHash: draft.draftHash,
    scriptHash,
    assetsHash,
    checksHash: draft.checksHash,
    runtimeArtifactHash: draft.runtimeArtifactHash,
    compilerVersion: draft.compilerVersion,
    runtimeVersion: draft.runtimeVersion,
    targetAdapterVersion: draft.targetAdapterVersion,
    limits: draft.spec.limits,
    worstCaseAgents: report.worstCaseAgents,
    agents: report.agents,
    prompts: draft.assets
      .filter((asset) => asset.kind === "prompt")
      .map((asset) => ({ kind: "prompt" as const, key: asset.key, fileName: asset.fileName, hash: asset.hash })),
    schemas: draft.assets
      .filter((asset) => asset.kind === "schema")
      .map((asset) => ({ kind: "schema" as const, key: asset.key, fileName: asset.fileName, hash: asset.hash })),
    trials: trials.map(
      (trial): BuildTrialRef => ({
        runId: trial.runId,
        inputHash: trial.inputHash,
        state: trial.state,
        businessStatus: trial.businessStatus,
      }),
    ),
    verification,
    builtAt,
  };

  // 4. Write the versioned package directory (or the exact publish directory).
  const versionDir = join(request.outputDir, buildHash.replace(/^sha256:/, "").slice(0, 16));
  const packageDir = request.targetDir ? resolve(request.targetDir) : join(versionDir, packageName);
  const files: string[] = [];
  const write = (relative: string, content: string): void => {
    const target = join(packageDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    files.push(relative);
  };

  const distDir = join(packageDir, "dist");
  mkdirSync(distDir, { recursive: true });

  write(
    "package.json",
    JSON.stringify(
      {
        name: packageName,
        version: draft.spec.version,
        type: "module",
        private: false,
        description: draft.spec.description ?? `DSH scenario ${draft.spec.workflowId}`,
        author: "AntonyLang",
        homepage: "https://github.com/AntonyLang/dsh-workflow-forge",
        bugs: { url: "https://github.com/AntonyLang/dsh-workflow-forge/issues" },
        keywords: ["dsh", "dsh-plugin", "scenario", "workflow", "report", "evidence"],
        exports: {
          ".": "./dist/index.js",
          "./package.json": "./package.json",
          "./cordis.patch.yml": "./cordis.patch.yml",
        },
        files: ["dist/", "assets/", "skills/", "examples/", "cordis.patch.yml", "README.md", "LICENSE"],
        engines: { dsh: request.dshVersion ?? "0.2.1-rc.3", node: ">=22.11" },
        peerDependencies: {
          "@deepseek-ai/cordis": "4.0.5",
          "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
          "@deepseek-ai/dsh-workflow": "0.2.1-rc.3",
          "@deepseek-ai/dsh-skill": "0.2.1-rc.3",
        },
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
        ...(request.repository
          ? { repository: { type: "git", url: request.repository, directory: `packages/${packageName}` } }
          : {
              repository: {
                type: "git",
                url: "https://github.com/AntonyLang/dsh-workflow-forge.git",
                directory: `packages/${packageName}`,
              },
            }),
        publishConfig: { access: "public" },
        license: "MIT",
      },
      null,
      2,
    ) + "\n",
  );

  write(
    "cordis.patch.yml",
    `# Bundle patch for ${packageName}.
# The id is local to the profile; the package name is resolved by the host.
- insert:
    - id: scenario-${draft.spec.workflowId}
      name: ${packageName}
      config: {}
`,
  );

  for (const asset of allAssets) write(asset.path, asset.content);
  write("assets/build.json", JSON.stringify(manifest, null, 2) + "\n");
  write(`skills/${draft.spec.workflowId}/SKILL.md`, request.skillBody ?? DEFAULT_SKILL(draft.spec.workflowId));
  write("README.md", request.readme ?? DEFAULT_README(manifest, packageName, buildHash));
  write("LICENSE", request.licenseText ?? defaultLicense());
  for (const example of request.examples ?? []) write(example.path, example.content);

  if (!request.skipBundle) {
    const bundled = await bundlePlugin(join(distDir, "index.js"));
    if (!bundled.ok) {
      diagnostics.push(
        diagnostic({
          code: DIAGNOSTIC_CODES.BUILD_FAILED,
          fieldPath: "dist/index.js",
          message: `esbuild could not bundle the scenario plugin: ${bundled.message}`,
          fix: "check that the runtime package resolves and that no DSH package is imported directly",
        }),
      );
      return { ok: false, diagnostics, buildHash };
    }
    files.push("dist/index.js");
  }

  return { ok: true, buildHash, packageDir, manifest, verification, files };
}

function hashOf(content: string): string {
  return sha256Hex(content);
}

function defaultLicense(): string {
  return `MIT License

Copyright (c) 2026 AntonyLang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

export function updateVerification(
  packageDir: string,
  state: BuildVerificationState,
  notes: string[],
): BuildManifest["verification"] {
  const path = join(packageDir, "assets", "build.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as BuildManifest;
  const runtimeVerified = state === "runtime_verified";
  manifest.verification = { state, runtimeVerified, notes };
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest.verification;
}

export type { BuildManifest, BuildVerificationState, RunState };
