# 架构与实现说明

本文说明 Workflow Forge 0.1 的实际实现，以及与《DSH 工作流插件详细架构方案》的对应关系。所有结论都对应仓库里的代码与测试；未在真实宿主验证的部分会明确标出。

## 1. 范围

首版只做一条链路：**给定资料生成结构化报告**。

- 作者阶段：把方法写成 `WorkflowSpec`，静态检查、试跑、打包。
- 运行阶段：只读固定资产（脚本 + 资产 + manifest），调用宿主原生 workflow 引擎，保存本次记录与报告。
- 运行期不加载作者插件、不解释 DSL、不允许模型修改脚本。

明确的非目标：跨重启恢复、任意循环、自由 DAG、嵌套工作流、通用确定性工具节点、拖拽编辑器、第二套运行后端、自动上传市场。

## 2. 系统组成

| 模块 | 位置 | 责任 |
| --- | --- | --- |
| 定义与静态语义 | `packages/spec` | meta-schema、契约注册表、引用形状、资产键、prompt 占位、规范化 hash、draft 身份 |
| 业务检查 | `packages/checks` | 输入规范化与段落切分、quote 定位、证据集、维度完整性、非空与体积、宿主复核 |
| 编译器 | `packages/compiler` | 字段类型推导、IR、符号表、预算、schema 子集映射、固定 JS 发射、mock 自检 |
| 运行包装层 | `packages/runtime` | admission、取消、期限、dispose、记录、状态机、Markdown 模板、场景插件入口 |
| 打包器 | `packages/packager` | 资产清单、buildHash、esbuild bundle、版本化包目录、验证状态迁移 |
| 作者插件 | `packages/author` | 源码指纹、候选仓库、试跑仓库、四个 forge 工具、作者 Skill |
| 首个场景 | `examples/source-brief` | Spec、提示词、schema、5 份 fixtures、SKILL.md |
| 测试 | `tests` | 编译负例、检查、取消/超时、打包、端到端 |

依赖方向严格单向，无循环：

```
spec  <-  checks  <-  compiler
   ^         ^           ^
   |         |           |
 runtime ----+           |
   ^                     |
 packager ---------------+
   ^
 author
```

编译器与打包器不会被运行期加载：`dist/index.js` 只包含 `runtime`、`checks`、`spec` 三者的必要部分。

## 3. 宿主边界：我们消费什么、声明什么

`packages/runtime/src/engine.ts` 用结构化类型声明了本项目消费的宿主能力：

| 能力 | 项目内的用法 | 验证状态 |
| --- | --- | --- |
| `workflowEngine.start({ script, meta, args, parent, signal, subagentProvider, maxTotalAgents })` | 以 `exec.agent` 作为 parent 启动固定脚本 | 按方案接口声明；mock 引擎按同一合同实现，**未在真实宿主调用** |
| `run.result` → `{ stopReason, value?, error? }` | 只把 `stopReason === "completed"` 当候选，value 仍要过输出契约 | 同上 |
| `run.dispose()` | 所有出口都 await，清理失败单独记录 | 同上 |
| `agent(prompt, { schema, label })` | 由编译产物调用，schema 来自候选资产 | 同上 |
| `parallel(thunks)` | 只接收零参数 thunk 数组；编译成每批最多 2 个 | 同上 |
| `subagentProvider: "spawn"` | 固定 fresh child，材料显式传入 | 同上 |
| `ctx.tools` / `ctx.skills` / `ctx.effect` | 注册工具、注册 Skill、注销并 drain | 通过 `PluginContext` 结构化声明 |

场景包**不 import 任何 `@deepseek-ai/*` 包**。`package.json` 里的 peerDependencies 与 `engines.dsh` 只负责版本门禁；bundle 内部没有任何伪造的宿主 API。这带来一个明确后果：接口是否真的可用，只能在目标宿主上验证，不能用“类型能编译”代替。

三处语义容易被误读，实现里都按保守方向处理：

1. `spawn` 只保证空会话，不保证工具隔离；模板要求模型只依据显式材料做只读分析，但**没有**声称编译器强制禁止外部工具。
2. `agent()` 没有 `context`/`tools`/`timeoutMs`/`agentPreset`；运行期限由包装层的 timer 实现，不依赖未核验的默认行为。
3. 普通子任务失败可能返回 `null`；helper 参数错误、越界 schema 会成为脚本级错误。项目保留每份材料的失败记录，不用 `filter(Boolean)` 丢掉它。

## 4. 编译流水线

`compileSpec()`（`packages/compiler/src/compile.ts`）按文档的八步执行：

1. **解析与 meta-schema**：Ajv 2020-12，`strict: true`、`allErrors: true`、不加强转/默认值/删字段。未知字段是错误，不是被忽略。
2. **资产物化**：prompt 存为 `extract.md`，schema 存为 `Brief.json`，逐个算 sha256；节点只引用逻辑键，不接受任意路径或远程 schema。
3. **默认值展开为显式 IR**：目前唯一的默认是 `agent_map.failurePolicy = "collect"`，会记入 `defaultsApplied`，而不是在校验时悄悄改写。
4. **逐块符号表**：输入类型来自 normalized 契约；节点输出类型来自原生 schema 子集；检查未知字段、可选字段直读、数组越界、scope 误用、未来节点、兄弟分支引用。
5. **最坏直接 Agent 数**：顺序相加、map 按最大元素数、branch 取两支最大；超过 `limits.maxDirectAgents` 直接拒绝。首模板为 4 + 1 = 5。
6. **固定模板发射**：变量名 `v0…`、循环变量 `__i/__b/__r/__j/__x` 全由编译器分配。用户文字只以 JSON 字符串/字面量形式进入脚本。
7. **语法 + mock 自检**：`vm.Script` 编译校验；再用 mock `agent`/`parallel` 跑一遍，验证顺序、批次上限、分支可达、null 处理、返回 envelope。自检失败不会产出候选。
8. **静态报告**：节点数、Agent 清单、资产 hash、自检结论、警告数，写入候选目录并参与打包前置检查。

### 引用与类型

```ts
type ValueRef = { ref: { scope: "input" | "node" | "item"; node?: string; path: Array<string | number> } };
type ValueExpr = ValueRef | { literal: JsonValue };
```

- `scope=input` 读规范化输入；`scope=node` 只能读已完成节点；`scope=item` 只在 `agent_map.task` 内可用。
- 只访问对象自有字段；`__proto__`、`prototype`、`constructor` 在 spec 层就被拒绝。
- 类型推导覆盖 `type/properties/required/additionalProperties/items/enum/const`，即 agent schema 的同一子集；因此“字段不存在”和“可选字段未检查就直读”都能在编译期报出来。

### 原生 schema 子集

`toNativeAgentSchema()` 拒绝 `$ref`、`$defs`、`oneOf/anyOf/allOf`、`minLength/maxLength`、`minimum/maximum`、`minItems/maxItems`、`pattern`、`format`、`patternProperties`、`if/then/else` 等，并给出 `Brief/properties/title/minLength` 这样的定位。长度、数量、引用关系全部放到确定性 limits/checks 里——这是“不静默丢弃约束”的具体做法。

## 5. 运行生命周期

`createScenarioRuntime()`（`packages/runtime/src/execute.ts`）的一次调用：

```
admission 检查（同步）
  └─ 登记 ownedExecution（同步，首个 await 之前）
      ├─ 保存 input.json（真实输入快照）
      ├─ 规范化输入；失败 → FAILED + INPUT_INVALID（不启动引擎）
      ├─ 写 STARTING（含 inputHash）
      ├─ 转发 exec.signal → 内部 AbortController；注册期限 timer
      ├─ engine.start(...) → 登记 activeRuns → 写 RUNNING(engineRunId)
      ├─ await run.result
      ├─ await run.dispose()（无论成功、失败、取消）
      ├─ 分类：引擎结果 + 业务复核
      ├─ 渲染报告到临时文件
      ├─ 冻结终态（最后一次取消检查）
      ├─ 提交：提升 report.md / 写 result.json / 写 run.json
      └─ finally：注销 ownedExecution，结算完成 Promise
```

状态：`STARTING → RUNNING → SETTLING → 终态`。终态集合为 `COMPLETED / INSUFFICIENT_INPUT / FAILED / CANCELLED / INTERRUPTED / UNKNOWN`。

### 取消、期限与卸载

- `exec.signal`、运行期限（默认 180 秒，可配置）、插件卸载都转成同一个取消请求；监听器先注册、再检查是否已经 abort，避免启动窗口漏掉取消。
- 不用 `Promise.race` 抢返回：取消后仍然等待 `run.result` 与 `run.dispose()`，然后才提交 `CANCELLED`。
- 终态冻结之后到达的取消记为迟到通知，不重写已提交状态。
- 卸载时先关闭 admission，再取消所有 ownedExecution 并 `allSettled`；`ctx.effect` 的异步 disposer 让宿主等待清理完成。
- `dispose` 失败时，成功结果降级为 `UNKNOWN` + `CLEANUP_FAILED`，不会显示为干净完成。

### 错误分类

分类不看错误文本里的关键词：

| 条件 | 终态 | error.code |
| --- | --- | --- |
| 引擎 `stopReason=completed`，业务 completed，清理正常 | `COMPLETED` | – |
| 引擎 completed，材料成功数不足 | `INSUFFICIENT_INPUT` | – |
| 脚本内 assertion 抛出（`__WF_ERROR__{...}` 信封） | `FAILED` | `ASSERTION_FAILED` |
| 引擎 completed 但 value 不满足输出契约 | `FAILED` | `INVALID_RESULT` |
| 引擎 cancelled / 调用方取消 / 期限 / 卸载 | `CANCELLED` | `WORKFLOW_CANCELLED` 或 `WORKFLOW_DEADLINE` |
| 引擎 error，且不是结构化信封 | `FAILED` | `SCRIPT_ERROR` |
| 清理失败 | `UNKNOWN` | `CLEANUP_FAILED` |
| 记录写入失败 | `UNKNOWN` | `RECORD_WRITE_FAILED` |
| 重启后发现旧非终态记录 | `INTERRUPTED` | `INTERRUPTED` |

唯一允许的文本识别是脚本发出的 `__WF_ERROR__<json>` 信封。测试里专门构造了一条同时包含 “timeout / workflow deadline / cancelled” 的普通错误，断言它被归为 `SCRIPT_ERROR`——防止用关键词猜分类。

## 6. 版本身份与存储

四类数据分开保存（`run.json` 字段见 `docs/data-contract.md`）：

| 数据 | 位置 | 生命周期 |
| --- | --- | --- |
| 候选定义 | `<dataDir>/drafts/<draftHash>/` | 通过检查后不可变 |
| 试跑记录 | 候选目录下 `trials/<runId>.json` | 每次运行新增，不覆盖 |
| 运行实例 | `<dataDir>/runs/<runId>/` | 每次独立 |
| 构建产物 | `<dataDir>/builds/<buildHash>/`、发布目录 | 版本化，不原位覆盖 |

三组 hash 的覆盖范围：

```
specHash  = H(规范化 spec，含内嵌 prompts 与 schemas)
draftHash = H(specHash, compilerVersion, runtimeArtifactHash, checksHash, targetAdapterVersion)
buildHash = H(draftHash, scriptHash, compilerVersion, runtimeVersion, targetAdapterVersion, 分发资产清单)
```

- `runtimeArtifactHash` / `checksHash` 由作者包从**实际源码文件字节**计算（`packages/author/src/fingerprint.ts`），改了实现就换身份。仓库用 `.gitattributes` 固定 `eol=lf`，避免不同平台的换行符造成同一提交算出不同的身份。
- `buildHash` 不包含自身、时间戳和试跑摘要，避免自引用；`assets/build.json` 里也不写 `buildHash`，它由目录名和打包结果承载。
- 只改提示词也会改变 `specHash → draftHash → buildHash`，旧试跑在打包时会被 `TRIAL_IDENTITY_MISMATCH` 拒绝。

仓库里的 `packages/scenario-source-brief/` 是 `pnpm build:scenario` 产出的**当前版本**分发目录（含 `dist/index.js`），其不可变历史由 git 提交与 `assets/build.json` 里的 hash 共同承载；同一份包也发布为 npm `dsh-scenario-source-brief`。

`run.json` 使用同目录临时文件 + 原子 rename；一个运行只有一个 writer，更新按队列顺序落盘，终态提交前等待队列排空。目录名只允许 `[A-Za-z0-9._-]`，解析后的路径必须仍在 `dataDir` 内，否则 `PATH_ESCAPE`。

## 7. 报告与模板

`renderReport()` 由项目维护，用户材料只作为**数据**进入：

- 所有插值先折叠空白（不能伪造标题/列表项），再中和反引号（不能开启代码围栏）。
- 事实与建议分标；每条结论带 `evidenceId`；末尾固定列出“未覆盖材料”和“检查记录”。
- `INSUFFICIENT_INPUT` 走另一套模板，明确说明“没有生成报告”和下一步，不冒充成功。

## 8. 与原始方案的差异（有意为之）

| 方案表述 | 实现 | 原因 |
| --- | --- | --- |
| `assets.prompts`/`schemas` 内嵌在候选 | 与方案一致；validate 时物化为文件 | 便于复核与分发 |
| `forge_validate` 保存候选 | 与方案一致（会写 `drafts/<hash>/`） | 名称与描述都写明写入副作用 |
| 场景包声明 peerDependencies | 与方案一致，但 dist 不 import 它们 | 避免伪造宿主 API；版本门禁仍生效 |
| `verification` 依次 packaged / installed / runtime_verified | 只实现状态记录与迁移函数；当前停在 `packaged` | 缺少目标宿主与真实模型 |
| `events.jsonl` 可选 | 未实现文件写入，进度事件仅通过 `attachProgress` 观察 | 首版以 run/result/report 为主，避免把事件当检查点 |
| 第二、第三个模板 | 未实现 | 方案要求“一个模板稳定后再扩”，首版只交付一个 |
| `forge_inspect` 版本差异 | 读候选/运行/构建记录，未做 diff 视图 | 记录齐全，diff 属于 UI 增量 |

## 9. 里程碑状态

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 原生接入 | 手写两步工具、spawn、结构化返回、取消与 dispose | 以结构化 adapter + mock 引擎完成；真实宿主未接 |
| M1 手写场景 | source-brief、材料快照、证据检查、JSON 与 Markdown | 完成 |
| M2 定义与编译 | 受限 Spec、schema 映射、静态分析、固定 JS | 完成（28 个编译器用例） |
| M3 作者链路 | Skill + 四个 forge 工具 | 完成 |
| M4 场景交付 | 原生 bundle、版本 hash、独立 runtime、兼容表 | 构建、独立运行、npm 发布与发布产物验证完成；真实宿主安装与真实模型试跑待做 |
| M5 开源维护 | 固定 case、教程、失败复现、版本记录 | 5 份 fixtures、两个 demo、验证矩阵完成 |

## 10. 第三方与出处

- DSH / Cordis 的接口语义、生命周期与限制来自方案引用的官方文档与源码基线（提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，根 manifest `0.2.1-rc.3`，Cordis `4.0.5`）。本仓库只做消费者侧适配，不复制宿主实现。
- 构建工具：TypeScript、Ajv 8、esbuild、Vitest、tsx，均为 MIT 许可。
- 仓库内所有 fixtures 为自写脱敏文本，不含真实账号、内部链接或个人信息。
