# Workflow Forge

把一次**已经跑通**的任务，整理成可参数化、可静态检查、可试跑、可打包的 DSH 场景插件。

一次资料整理方法，通常只存在于某次对话里：输入什么、先做什么、什么时候算完成、例外怎么处理，全靠人再讲一遍。Workflow Forge 把这套方法固化成一个受限的 `WorkflowSpec`，用确定性工具检查它、跑它、把它打包成别人可以直接安装的场景包；日后在新会话里，用户只需要提供参数。

> 本仓库复现的是《DSH 工作流插件详细架构方案》中的 Workflow Forge 0.1：一个作者插件 + 一个可独立安装的 `source-brief` 资料报告场景 + 可复现的样例与测试。

## 它解决什么问题

| 方式 | 复用一次方法需要做什么 | 结果可检查吗 |
| --- | --- | --- |
| 每次重新描述 | 重讲输入、步骤、交付标准 | 不能 |
| 保存为普通 Skill | 复制一段说明，模型自行理解 | 不能 |
| 本项目的场景插件 | 填参数，调用固定版本的工具 | 能：证据可定位、检查有记录、版本有 hash |

代价是必须先有结构。只表达偏好、没有执行结构的任务，继续用普通 Skill 就好——这也是项目里反复强调的判断标准。

## 一次调用的输入与输出

输入是**已经读取成文本**的材料（URL、PDF 由宿主能力先读成文本），不是文件路径：

```json
{
  "topic": "三款笔记应用的取舍",
  "materials": [
    { "id": "m1", "title": "用户访谈记录", "text": "第一段……\n第二段……", "sourceRef": "interview-2026-09" }
  ],
  "dimensions": ["同步与离线", "检索与整理", "协作与权限"],
  "language": "zh",
  "minSuccessful": 1
}
```

输出是 canonical JSON + 一份 Markdown 报告：

```json
{
  "runId": "20261025T022959Z-598fdd",
  "state": "COMPLETED",
  "businessStatus": "completed",
  "agentsStarted": 4,
  "checks": [
    { "rule": "evidence_ids_exist", "ok": true },
    { "rule": "required_dimensions", "ok": true },
    { "rule": "non_empty_brief", "ok": true },
    { "rule": "result_size", "ok": true }
  ],
  "reportPath": "…/runs/20261025T022959Z-598fdd/report.md",
  "resultPath": "…/runs/20261025T022959Z-598fdd/result.json"
}
```

报告片段（由固定模板渲染，用户文字只作为数据进入）：

```markdown
## 逐维度比较

### 1. 同步与离线
- **事实**：用户访谈记录：重度笔记用户 A在「同步与离线」上的说法：我每天在不同设备之间切换，最在意的是打开就能写，不要等同步（证据：m1:1）
- **事实**：官方文档摘录：同步与离线能力在「同步与离线」上的说法：本地优先架构：编辑先写入本地数据库，再在后台同步（证据：m2:1）

## 来源片段
- `m1:1` 用户访谈记录：重度笔记用户 A · `p1`：`我每天在不同设备之间切换，最在意的是打开就能写，不要等同步。`

## 未覆盖材料
- `m3` 内部试用记录：三周协作试验 (NO_STRUCTURED_RESULT)：agent output is not {facts: []}
```

## 快速开始

需要 Node.js ≥ 22.11 与 pnpm。

```bash
pnpm install
pnpm typecheck       # 全仓 TypeScript 严格模式
pnpm test            # 114 个用例：编译负例、证据检查、取消/超时、打包、端到端
pnpm demo            # 离线全链路：validate → trial×5 → package → 新会话运行
pnpm demo:failure    # 三个层次的失败与对应诊断
pnpm build:scenario  # 生成可直接安装的包：packages/scenario-source-brief/
pnpm pack:scenario   # 生成发布用的 tarball：release/dsh-scenario-source-brief-0.1.0.tgz
pnpm verify:package  # 从 tarball 安装到干净项目并跑通；加 --from-registry 验证 npm 产物
```

`pnpm demo` 不需要模型和 API Key：它用一个**离线 mock 引擎**执行真实编译产物，覆盖真实的分批、空结果、分支和报告渲染。这也是为什么它的运行记录会写 `engineKind: "mock"`，构建只会标成 `packaged`。

## 安装这个场景

已发布到 npm：**[`dsh-scenario-source-brief@0.1.0`](https://www.npmjs.com/package/dsh-scenario-source-brief)**

```bash
dsh plugin add dsh-scenario-source-brief
```

也可以直接从仓库里的预构建包安装：

```bash
dsh plugin add ./packages/scenario-source-brief
```

安装后必须配置 `dataDir`（宿主允许的绝对目录）：运行输入、报告与记录都写在这里，模型不能选择写入路径。

发布产物做过一次独立验证（`pnpm verify:package --from-registry`）：在干净项目里从 npm 安装、注册 `source_brief` 工具与 `source-brief` Skill、跑完一次 `COMPLETED` 并写出报告与运行记录。它用的仍是本地 mock 引擎，所以验证状态停在 `packaged`：真实宿主安装（`installed`）与真实模型试跑（`runtime_verified`）尚未执行。

## 三个层次的验证状态

| 状态 | 含义 | 本仓库当前 |
| --- | --- | --- |
| `packaged` | 静态检查通过、两份不同输入的试跑通过、原生包已生成 | ✅ 已完成 |
| `installed` | 通过目标 DSH 版本的 Plugin Manager 安装并激活 | ⛔ 未执行（需要目标宿主环境） |
| `runtime_verified` | 真实模型 + 真实宿主上的试跑通过 | ⛔ 未执行 |

安装成功不等于业务可用；mock 返回了合法 JSON 也不等于结构化输出可用。这两个结论都留在真实环境里验证。

## 仓库结构

```
packages/
  spec/       WorkflowSpec 类型、meta-schema、契约、hash、引用解析
  checks/     输入规范化、段落切分、证据检查、维度完整性、报告内容检查
  compiler/   受限 IR、符号表、类型检查、预算、固定 JS 发射、mock 自检
  runtime/    运行包装层：取消、期限、dispose、记录、报告模板、场景插件
  packager/   构建 hash、esbuild 原生 bundle、版本化场景包
  author/     作者插件：Skill + forge_validate / forge_trial / forge_package / forge_inspect
examples/
  source-brief/   首个场景：Spec、5 份脱敏 fixtures、SKILL.md
packages/scenario-source-brief/   已构建、可直接安装/发布 `dsh-scenario-source-brief`
tests/             114 个用例，11 个文件
docs/              架构、DSL、数据合同、验证矩阵、作品集博客、awesome 投稿材料
```

## 设计要点（详见 `docs/architecture.md`）

- **流程是一份数据，不是一段代码**：用户只写 `steps`、引用、提示词和 schema；代码由编译器按固定模板生成，没有任何用户函数体进入脚本。
- **引用只能是结构化路径**：`{ scope, node?, path }`，只读对象自有字段，`__proto__` / `prototype` / `constructor` 直接拒绝。
- **每条路径都必须以 result 结束**：顺序 steps + 末尾单层 branch，两支互斥且都终结；最坏直接 Agent 数在编译期算清（首模板为 5）。
- **失败不会被静默吞掉**：每份材料的位置和成功/失败都保留；`filter(Boolean)` 那种“少一份材料”的写法在测试里被明确禁止。
- **业务结果与引擎结果分开**：`stopReason` 只说明脚本怎么结束；是否有可交付报告由 wrapper 的业务复核决定。
- **版本身份是字节级的**：`specHash` 覆盖规范化定义与内嵌资产，`draftHash` 再绑定 compiler/runtime/checks/adapter 的源码指纹，`buildHash` 覆盖实际分发资产。改一个提示词就会产生新候选，旧试跑自动失效。
- **取消和清理只有一条路径**：`exec.signal`、运行期限、插件卸载都转换成同一个取消请求；所有出口都 `await run.dispose()`。

## 兼容性

| 项 | 值 | 验证方式 |
| --- | --- | --- |
| Node.js | ≥ 22.11（开发机 v24.14.0） | CI 与本机测试 |
| npm 包 | `dsh-scenario-source-brief@0.1.0` | `npm view` + 干净项目安装运行 |
| 目标 DSH | `0.2.1-rc.3`（方案源码基线提交 `22ddee3`） | 仅声明在 `engines.dsh`，**未在真实宿主安装** |
| Cordis | `4.0.5`（peer） | 同上 |
| 原生能力 | workflowEngine.start / run.result / run.dispose / agent / parallel / spawn | 以结构化 adapter 类型声明，mock 引擎按同一合同实现 |
| 平台 | Windows / macOS / Linux | 路径与 hash 规范化按平台无关实现 |

场景包只通过 Cordis context 使用宿主能力，不直接 `import` 任何 `@deepseek-ai/*` 包；这些包只作为 peerDependencies 参与版本门禁。这样 bundle 里没有伪造的宿主 API，也避免把“读到了类型声明”当成“接口已经验证”。

## 边界与已知限制

- 首版只处理已读取的文本，不做文件读取、不做联网检索。
- 不提供跨重启恢复：`run.json` 是诊断记录，不是断点。重启只会把上一进程留下的非终态记录标为 `INTERRUPTED`。
- 不提供并行 DAG、循环、嵌套分支、通用确定性工具节点或第二套运行后端。
- 结构化检查只证明 quote 能定位、evidenceId 存在、维度齐全；**不证明事实判断正确**。抽样语义核对仍由人完成。
- 真实模型与真实宿主的贯通（`runtime_verified`）尚未执行，原因与验证步骤写在 `docs/verification.md`。

## 来源与许可

- 本仓库的 DSH 适配层是按官方文档、源码基线与现有测试确定的**消费者侧**接口；workflow 引擎、Cordis 生命周期、spawn 子 Agent 均由 DSH 提供，不是本项目的实现。
- 代码以 MIT 许可发布。第三方材料的出处与修改记录见 `docs/architecture.md` 末尾。

## License

MIT © 2026 AntonyLang
