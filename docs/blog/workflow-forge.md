# 把一次跑通的任务做成插件：Workflow Forge 复现记

> 一个受限 DSL、一个确定性编译器和一个运行包装层，如何把「这次资料整理得不错」变成「下次换个主题也能用，而且结果可检查」。
>
> 项目：`workflow-forge` ／ 场景：`source-brief` ／ 日期：2026-10 ／ 许可：MIT

## 一、起点：为什么「再讲一遍」是个工程问题

一次任务里真正有价值的东西，往往不是最终那份报告，而是**方法**：先读哪几份材料、按什么维度比较、什么算完成、材料读不出来时怎么办。

问题是方法只存在于对话里。下次遇到同类任务，用户要么重新讲一遍（还讲不全），要么把上次的输出当模板改（结构早就不匹配新材料），要么存一段 Skill 说明让模型自行理解（理解成什么样不可控，也没有任何东西可以检查）。

所以我想做的不是「更好的提示词」，而是把方法变成**有身份、可检查、可分发**的东西：

- 输入是参数，不是「上次那几份材料」；
- 步骤是数据，不是散文；
- 交付条件是程序能判断的；
- 改动一次提示词，就会产生一个新的版本，而不是悄悄覆盖旧行为。

这就是 Workflow Forge：一个作者插件 + 一个可独立安装的场景包。作者插件负责把方法收敛成 `WorkflowSpec`、检查、试跑、打包；场景包只负责在新会话里**按固定字节**运行。

## 二、目标与不做什么

首版只做一条链路：**给定已读取的文本材料，生成带段落级证据引用的结构化报告**。

明确的非目标，都是在动手之前就写下的：

- 不做任意循环、自由 DAG、嵌套工作流；
- 不做「通用确定性工具节点」——那会立刻打开一扇叫 `functionBody` 的后门；
- 不做跨重启恢复：运行记录是诊断依据，不是断点；
- 不做第二套编排引擎，也不自己实现子 Agent；
- 不做拖拽编辑器。

最后一组取舍尤其重要：**DSH 原生的 workflow 引擎（workflow-ptc + spawn 子 Agent）负责执行**，我写的是它上面的消费者层。这个项目里没有一行「子 Agent 引擎」的代码，把它们说成自己的实现是不诚实的。

## 三、架构：把流程当数据

```mermaid
flowchart LR
  A[用户描述 / 材料] --> B[作者 Skill]
  B --> C[WorkflowSpec 候选]
  C --> D[forge_validate<br/>静态检查 + 自检]
  D -->|diagnostics| C
  D --> E[候选 drafts/&lt;hash&gt;/]
  E --> F[forge_trial<br/>真实 wrapper + 引擎]
  F --> G[trials/&lt;runId&gt;.json]
  G --> H[forge_package<br/>身份核对 + esbuild]
  H --> I[场景包 dist + assets + SKILL.md]
  I --> J[新会话<br/>source_brief 工具]
  J --> K[run.json / result.json / report.md]
```

运行期只加载 `runtime + checks + spec` 的产物，不加载编译器和作者工具。这条边界是编译时强制的：`dist/index.js` 里根本没有 `forge_*`。

### 1) 流程表示：顺序 steps + 末尾单层 branch

六类节点：`agent`、`agent_map`、`transform`、`assert`、`branch`、`result`。

只有一层分支、两支都以 `result` 结束、不能合流。约束看起来很强，但它换来了两个很实用的性质：

- **每条路径的结束位置可以静态确定**，不会出现「跑到一半既没有报告也没有错误」；
- **最坏情况下直接启动的 Agent 数可以算清**：顺序相加、map 按最大元素数、branch 取两支最大。首模板是 4 份材料 + 1 次汇总 = 5。

这不是为了限制用户，而是为了让「这个工作流要花多少子 Agent」在编译期就有一个确定的答案，而不是跑到一半才发现。

### 2) 引用即数据，不是表达式

```ts
type ValueRef = {
  ref: {
    scope: "input" | "node" | "item";
    node?: string;
    path: Array<string | number>;
  };
};
```

没有 JavaScript 表达式字符串。解析只走对象自有字段，不执行 getter、不做原型查找；`__proto__`、`prototype`、`constructor` 在 spec 层就被拒绝。因为类型从受支持的 schema 子集推导，所以「字段根本不存在」和「这个字段是可选的，但你没检查就直读」都能在编译期报出来：

```text
OPTIONAL_FIELD_READ  node second  steps/second/bindings/topic
  field "note" is optional; reading it without a check is not allowed in v0.1
```

### 3) 编译器八步

1. 解析 + meta-schema（Ajv 2020-12，`strict`、`allErrors`、不强转、不注入默认值、不删额外字段）
2. 物化资产：`extract.md`、`Brief.json`，逐个算 sha256；节点只引用逻辑键
3. 默认值展开成显式 IR（唯一的默认 `failurePolicy=collect` 会记录在 `defaultsApplied`）
4. 逐块符号表：引用、字段类型、分支终结、每条路径的 result
5. 最坏 Agent 预算
6. 固定模板发射 JS（变量名全部由编译器分配）
7. `vm.Script` 语法检查 + mock 自检
8. 静态报告（节点数、Agent 清单、资产 hash、自检结论）

第 7 步不是形式主义。它用 mock 的 `agent`/`parallel` 真跑一遍生成代码，验证批次上限、分支可达、null 处理和返回 envelope。如果生成器写错了，在这一步就会炸，而不是等用户装好包之后。

生成出来的代码长这样（节选，来自 `pnpm demo` 的真实产物）：

```js
const v0 = [];
for (let __i = 0; __i < args["materials"].length; __i += 2) {
  const __b = args["materials"].slice(__i, __i + 2);
  const __r = await parallel(__b.map((__item) => () => agent(
    renderPrompt(__P["extract"], { "topic": args["topic"], "language": args["language"], "material": __item }),
    { schema: __S["EvidenceExtract"], label: __item["id"] })));
  for (let __j = 0; __j < __b.length; __j++) {
    const __x = __r[__j];
    v0.push(__x === null || __x === undefined
      ? failedMaterial(itemId(__b[__j], __i + __j), __i + __j, "NO_STRUCTURED_RESULT")
      : checkedMaterial(__b[__j], __i + __j, __x));
  }
}
const v1 = collectEvidence(args["materials"], v0);
if (lt(v1["successCount"], args["minSuccessful"])) {
  return finalize("insufficient_input", { … });
} else {
  const v4 = await agent(renderPrompt(__P["synthesize"], { … }), { schema: __S["Brief"], label: "synthesize" });
  if (v4 === null || v4 === undefined) throw __wfError("AGENT_RESULT_MISSING", { node: "synthesize" });
  const v5 = runAssertRules({ rules: [ … ], "brief": v4, … });
  return finalize("completed", { "brief": v4, "evidence": v1, … });
}
```

注意两件事：失败是 `failedMaterial(...)` 这个**数据对象**，不是 `filter(Boolean)` 丢掉；`status` 是程序常量，不是模型能写的字段。

## 四、四个关键取舍

### 取舍一：证据「可定位」不等于事实「正确」，而且不能假装相等

结构检查能证明：`quote` 能在指定段落里找到、`evidenceId` 真实存在、每个维度恰好出现一次、结论非空、体积不超限。

它**不能**证明：这条 quote 是否真的支持这个结论。

所以我在产品语言里把这两件事分开：检查项叫 `evidence_ids_exist`、`required_dimensions`，报告末尾固定写一句「结构与引用检查通过并不等于事实准确」，验证章节里也单列「抽样语义核对仍由人完成」。

这不是免责声明，而是设计约束：如果我在 UI 上说「已验证」，用户就会停止抽查，而系统并没有那个能力。

### 取舍二：版本身份精确到字节

三组 hash：

```text
specHash  = H(规范化 spec，含内嵌 prompts 与 schemas)
draftHash = H(specHash, compilerVersion, runtimeArtifactHash, checksHash, targetAdapterVersion)
buildHash = H(draftHash, scriptHash, compilerVersion, runtimeVersion, targetAdapterVersion, 分发资产清单)
```

`runtimeArtifactHash` 和 `checksHash` 不是手写常量，而是从**实际源码文件字节**算出来的（`hashSourceTree`）。这样「改了实现但忘了改版本号」不会让旧试跑继续有效。

同样的，`buildHash` 不包含自己、不包含时间戳、不包含试跑摘要——所以两个不同时间、不同试跑数量的构建，只要资产字节一致，hash 就一致。这条性质有专门的测试：`derives the same build hash regardless of timestamps and trial summary`。

效果是：**只改一个提示词，也会产生新的候选身份，旧试跑在打包时被拒绝**。`pnpm demo:failure` 里的 C2 就是演示这个：

```text
old draftRef: sha256:52f652d0…
new draftRef: sha256:b2c6d4d9…
draft identity changed: true
ok: false
TRIAL_NOT_FOUND  trialRunIds
  no stored trial for 20261025T023849Z-464e36, …
```

### 取舍三：取消和清理只有一条路径，不用 `Promise.race`

运行包装层里最容易写出 bug 的地方是「取消后提前返回，把子任务留在后台」。所以：

- `exec.signal`、运行期限、插件卸载，全部转换成同一个内部 `AbortController`；
- 监听器先注册，再检查是否已经 aborted（避免启动窗口漏掉取消）；
- 取消之后**仍然等待** `run.result` 与 `run.dispose()`，然后才提交 `CANCELLED`；
- 终态只冻结一次；冻结之后到达的取消记为迟到通知，不重写已提交状态；
- 卸载时先关 admission，再取消所有 ownedExecution 并 `allSettled`。

有一类错误特别容易被误判：引擎返回 `stopReason: "error"`，错误文本里恰好有 `timeout`。如果按关键词分类，它会被当成「期限取消」，用户看到的下一步建议就全错了。所以分类只认两种信息：结构化的 `stopReason`，以及脚本自己发出的 `__WF_ERROR__{...}` 信封。测试里专门构造了这条「关键词陷阱」错误，断言它被归为 `SCRIPT_ERROR`。

### 取舍四：报告模板归项目，用户文字只能是数据

报告由固定模板渲染。所有插值先折叠空白（不能伪造标题或列表项），再中和反引号（不能开代码围栏）：

```markdown
### 1. 同步与离线
- **事实**：用户访谈记录：重度笔记用户 A在「同步与离线」上的说法：我每天在不同设备之间切换，最在意的是打开就能写，不要等同步（证据：m1:1）

## 来源片段
- `m1:1` 用户访谈记录：重度笔记用户 A · `p1`：`我每天在不同设备之间切换，最在意的是打开就能写，不要等同步。`

## 未覆盖材料
- `m3` 内部试用记录：三周协作试验 (NO_STRUCTURED_RESULT)：agent output is not {facts: []}
```

「未覆盖材料」是固定小节，不是可选项。因为部分材料失败时，最容易出现的错误行为就是「只写成功的那部分，让读者以为这就是全部」。

## 五、验证：不仅证明它能跑，还证明它会拒绝

`pnpm test` 现在是 **11 个文件 / 114 个用例**，覆盖四层里能离线覆盖的两层：

| 层 | 覆盖 |
| --- | --- |
| 静态检查 | meta-schema、未知字段、契约、预算、schema 子集、引用/类型/分支合法性 |
| 包装层与编译 | 顺序与批次、null、位置对齐、取消、期限、卸载、错误分类、记录与报告、打包身份 |
| 发布产物 | `pnpm verify:package`：空项目安装 tarball 或 npm 包，注册工具/Skill，跑完一次并校验报告与记录 |

我特意写了一批「应该失败」的用例，因为一个检查器最值得信任的部分是它的拒绝路径：

| 拒绝场景 | 得到的诊断 |
| --- | --- |
| 引用未来节点 | `FORWARD_NODE_REFERENCE` |
| 引用另一分支的结果 | `SIBLING_BRANCH_REFERENCE` |
| branch 不在末尾 | `BRANCH_NOT_TERMINAL` |
| 嵌套 branch | `NESTED_BRANCH` |
| 缺 result | `MISSING_RESULT` |
| agent schema 用 `minLength` | `UNSUPPORTED_AGENT_SCHEMA`（定位到 `Brief/properties/title/minLength`） |
| 第 5 份材料 | `INPUT_LIMIT_EXCEEDED`，不启动任何 Agent |
| 结论引用不存在的证据 | 运行期 `ASSERTION_FAILED`，不生成报告 |
| 一份材料返回 null | 保留失败记录，按阈值决定是否汇总 |
| 完成顺序颠倒 | 证据仍按输入 index 对齐 |
| 改提示词后复用旧试跑 | `TRIAL_IDENTITY_MISMATCH` |

还有一个数字值得单独说：`forge_package` 要求**两份 inputHash 不同**的 `COMPLETED` 试跑。只改空格不算，第二份必须真的换材料或主题。它的意义不是「多跑一次」，而是证明参数路径真的在使用新值——这也是「方法可复用」与「输出可复刻」的分界线。

## 六、交付物

一次 `pnpm demo` 会产出（`pnpm build:scenario` 另会把它落到仓库里的 `packages/scenario-source-brief/`，并发布为 npm 包）：

```text
packages/scenario-source-brief/
├── package.json            engines.dsh / peerDependencies / dsh.bundle.patch
├── cordis.patch.yml        insert 入口
├── dist/index.js           ESM bundle：薄 runtime + checks + 校验器
├── assets/
│   ├── workflow.js         固定脚本（原生引擎实际执行的字节）
│   ├── workflow.json       固定 Spec，便于复核
│   ├── build.json          版本、hash、依赖、验证摘要
│   ├── prompts/extract.md
│   ├── prompts/synthesize.md
│   ├── schemas/Brief.json
│   └── schemas/EvidenceExtract.json
├── skills/source-brief/SKILL.md
├── examples/fixtures/*.json
├── README.md
└── LICENSE
```

发布形态有两个：npm 上的 `dsh-scenario-source-brief@0.1.0`，以及 GitHub Release `v0.1.0` 的预构建 tarball。两者字节一致，都由 `pnpm verify:package` 在空项目里装过一次并跑通。

`dist/index.js` 里没有任何 `@deepseek-ai/*` 的 import：场景只通过 Cordis context 使用宿主能力，那些包只作为 peer 参与版本门禁。这样做的代价是——「类型能编译」不能证明「接口真的可用」，所以验证状态必须停在 `packaged`，直到在目标宿主上真的装一次、跑一次。

## 七、诚实的边界

这个项目做完之后，我知道自己**没有**证明什么：

- 没有在真实 DSH 宿主上安装运行过（`installed`）；
- 没有用真实模型试跑过（`runtime_verified`）；
- 没有证明 quote 与结论语义一致，只证明了可定位；
- 没有覆盖卸载恰好在终态写入窗口发生的时序；
- 没有模拟记录写入失败的只读目录场景。

已经做掉的一层是「发布产物」：包被装进一个没有工作区、没有开发依赖的空项目，从 npm 注册表拉下来，注册工具和 Skill，用本地 mock 引擎跑完一次并写出报告。它证明的是**分发出去的那份字节能加载、能注册、能跑**，不是「真实宿主能跑」。

前两条是环境问题：本机没有可用的目标宿主与模型凭据，而「用一个像宿主的 mock」替代，只会制造已经验证过的错觉。所以我把它们写进 README、写进 build manifest 的 `verification.state`、也写进运行记录的 `engineKind`。

后三条是测试设计问题，已经在 `docs/verification.md` 里逐条列出，并说明了为什么会难测（需要可控的文件写入延迟、只读目录、真实事件源）。

## 八、如果继续做

按方案里的里程碑，下一步不是加模板，而是把 M4 收尾：

1. 在目标宿主上安装一次，记录 exports、注入、spawn、PTC 与取消链路的实际行为；
2. 用真实模型跑两份不同输入，把实际模型标识、耗时、用量写进记录；
3. 只有这两步都过了，才把 `verification.state` 推到 `runtime_verified`。

再往后才轮到第二个模板（联网扩展调研）和 UI 增量（只读预览、历史与结构 diff）。方案里对「何时该扩」写得很清楚：现有样例是否稳定复用、新增能力是否被至少两个真实场景需要、维护成本是否还适合个人投入。在第一条链路没有被真实使用之前加模板，只是把未验证的面积做大。

## 九、复盘：哪些决定事后看是对的

- **先写失败用例**。一批「不该通过」的用例（编译负例、检查拒绝、打包拒绝），在重构编译器时救了我两次。
- **把 `status` 从模型手里拿走**。模型只产出 brief；`status`、`checks`、`evidenceId` 都是程序生成的。这消掉了一整类「模型说自己成功了」的问题。
- **hash 覆盖实现字节**。手写版本号一定会忘，源码指纹不会。
- **报告模板不开放**。它挡住了标题注入、代码围栏逃逸，也顺带让报告格式可预测。
- **明确说出「没验证」**。这反而让「验证过的部分」更可信。

如果重做一次，我会把两件事提前：

1. **先接真实宿主的最小调用**，再写编译器。现在的 adapter 类型是按文档确定的，风险集中在那一次真实验证上；
2. **把失败注入能力做成运行期的 debug 开关**，而不是写在 demo 脚本里。现在的 mock 引擎已经能做，但接口还是测试导向的。

## 参考

- DSH 官方文档、源码基线提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（根 manifest `0.2.1-rc.3`，Cordis `4.0.5`）
- LangGraph JS 的持久化与 interrupt 语义（仅作为状态与执行语义的参照，未引入第二套引擎）
- Ajv 8、esbuild、Vitest、TypeScript 官方文档

---

仓库：`AntonyLang/dsh-workflow-forge` ／ 架构说明：`docs/architecture.md` ／ 验证矩阵：`docs/verification.md` ／ DSL：`docs/workflow-spec.md`
