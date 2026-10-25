# 验证矩阵

本项目把“通过”拆成四层，每层证明的范围不同。**上层通过不能代替下层通过**：mock 返回了合法 JSON 不等于结构化输出可用，安装成功也不等于业务可用。

| 层次 | 运行方式 | 证明范围 | 当前状态 |
| --- | --- | --- | --- |
| 静态检查 | `pnpm typecheck` + 编译器单测 | 定义格式、引用、类型、资产、预算、脚本语法与自检 | ✅ 通过 |
| 包装层与编译测试 | `pnpm test`（mock 引擎） | 分支、null、取消、期限、错误映射、文件状态、打包身份 | ✅ 114 个用例 |
| 宿主集成 | 目标 DSH profile + Plugin Manager 安装 | exports、注入、spawn、PTC、生命周期、平台组合 | ⛔ 未执行 |
| 业务试跑 | 真实模型 + 不同材料 | 内容质量、证据忠实度、复用价值、实际开销 | ⛔ 未执行 |

## 1. 静态检查

```bash
pnpm typecheck   # tsc --noEmit，strict + noUncheckedIndexedAccess
pnpm test        # 11 个文件 / 114 个用例
pnpm demo        # 真实编译产物 + 离线 mock 引擎
pnpm demo:failure
```

编译器自身还会在每次 `forge_validate` 里做两层自检：

1. 用 `vm.Script` 确认生成脚本能解析；
2. 用 mock `agent`/`parallel` 真跑一遍，确认批次上限、分支可达、null 处理与返回 envelope。

自检失败不会产生候选（`SCRIPT_SELF_CHECK_FAILED`）。

## 2. 方案要求的 16 个案例与测试对应

| # | 案例（方案 §11.2） | 预期 | 覆盖测试 |
| --- | --- | --- | --- |
| 1 | 引用未来节点 / 另一分支结果 | 编译前拒绝并定位 ref | `negative.test.ts`：later node / sibling arm |
| 2 | 非末尾 branch、嵌套 branch、缺 result | 编译前拒绝 | `negative.test.ts`：branch not last / nested / arm without result / no result |
| 3 | agent schema 含 `minLength` 或 `$ref` | 明确拒绝，不静默删除 | `negative.test.ts`：minLength / $ref / oneOf / array-rooted |
| 4 | 第 5 份材料、`minSuccessful` 大于材料数 | 输入校验拒绝，不启动 Agent | `normalize.test.ts`：fifth material / minSuccessful above count |
| 5 | 两份材料完成顺序颠倒 | 输出仍按输入 index 对齐 | `run.test.ts`：keeps results aligned when materials finish out of order |
| 6 | 一个子任务返回 null | 保留失败材料；按阈值决定是否汇总 | `run.test.ts`：partial failure（COMPLETED）/ insufficient（INSUFFICIENT_INPUT） |
| 7 | quote 不在指定段落 | 该材料失败，错误不能成为证据 | `evidence.test.ts`：quote not in paragraph |
| 8 | 结论包含不存在的 evidenceId | 业务失败，不能生成成功报告 | `run.test.ts`：cites an evidence id that does not exist；`evidence.test.ts`：unknown id |
| 9 | 维度齐全但 findings/conclusions 为空 | `non_empty_brief` 拒绝 | `evidence.test.ts`：empty conclusions / empty finding text / no supported fact |
| 10 | 调用开始前已取消 | 不创建脚本或子任务 | `cancel.test.ts`：cancels before the engine starts |
| 11 | 启动中取消，子任务迟到出现 | 仍完成清理，不遗留活跃 handle | `cancel.test.ts`：cancels during the run（activeHandles = 0） |
| 12 | 运行期限触发 / 插件卸载 | 停止新增工作，等待 result 与 dispose | `cancel.test.ts`：deadline / drains on unload |
| 13 | 宿主退出后重新打开 | 遗留记录显示中断，不自动重跑 | `records.test.ts`：marks non-terminal runs INTERRUPTED |
| 14 | 修改 prompt 后复用旧 trialIds | 打包拒绝资产不一致 | `end-to-end.test.ts`：changed assets；`package.test.ts`：identity mismatch |
| 15 | spec 结构不变但 prompt/runtime 字节改变 | draftRef 改变，旧试跑不得复用 | `compile.test.ts`：draft identity changes；`demo-failure.ts` C2 |
| 16 | 卸载发生在 start 前或终态写入期间 | 等待 ownedExecution 完整结束 | `cancel.test.ts`：unload drain（终态写入窗口为部分覆盖，见下） |
| 17 | 安装后禁用作者插件，更换材料 | 场景工具仍可交付 | `end-to-end.test.ts`：runs without the author plugin |

补充覆盖（方案未逐条列出，但属于同一风险面）：

- 未知字段、未知契约、越界版本、重复节点 id、原型路径片段；
- 可选字段直读、未知字段读写、`lt` 比较字符串；
- 结果体积上限、报告模板的标题/代码围栏逃逸；
- 引擎 value 不满足输出契约 → `INVALID_RESULT`；
- 含 “timeout / deadline / cancelled” 关键词的普通错误不得被误判为取消；
- 同一 build 与时间戳、试跑条数无关；验证状态迁移不改 buildHash。

## 3. mock 能证明什么、不能证明什么

**能证明**：控制流顺序、批次上限、位置对齐、null → 失败材料、assert 的拒绝路径、取消与 dispose 顺序、终态冻结、记录与报告写入、打包身份校验、bundle 的导出形状。

**不能证明**：

- 模型是否遵守 schema 与提示词（mock 的返回值由 fixture 构造）；
- 真实 spawn 子 Agent 的继承边界、工具隔离与配额；
- 宿主真实的事件顺序与取消链路；
- 事实是否被 quote 支持（结构检查只证明可定位）；
- 语言质量与成本。

因此 `engineKind: "mock"` 会写进运行记录，构建只会停在 `packaged`。

## 4. 如何把状态推进到 installed / runtime_verified

1. 在目标 DSH 版本（`0.2.1-rc.3` 基线）的 profile 上用 Plugin Manager 安装构建产物：
   `examples/source-brief/packaged/<hash>/dsh-scenario-source-brief/`。
2. 插件配置必须提供宿主允许的绝对 `dataDir`；模型不得选择写入路径。
3. 新会话调用 `source_brief`，确认 `state` 为 `COMPLETED`、`reportPath` 可读；调用 `forge_package` 之外的入口不再需要作者插件。
4. 关闭作者插件再重复一次，记录 `installed`。
5. 用真实模型跑至少两份不同输入，记录 `runtime_verified`，并把实际模型标识、耗时与用量写进记录。

在此之前，README 与构建 manifest 都会明确标注“未在真实宿主验证”。这不是保守措辞，而是方案本身要求的区分：打包成功、安装成功、业务通过是三件事。

## 5. 当前证据

- `pnpm typecheck`：0 error。
- `pnpm test`：11 个文件、114 个用例通过。
- `pnpm demo`：
  - `forge_validate` → 自检 `passed`，最坏直接 Agent 数 5；
  - 5 份 fixture 试跑：4 份 `COMPLETED`、1 份 `INSUFFICIENT_INPUT`；
  - `forge_package` → `packaged`，`runtimeVerified: false`，notes 说明 mock；
  - 新数据目录 + 打包产物运行 → `COMPLETED`，`agentsStarted: 4`，报告含 3 个维度与来源片段。
- `pnpm demo:failure`：三类失败的诊断文本（编译拒绝、运行期 `ASSERTION_FAILED`、打包 `TRIAL_REQUIRED` / `TRIAL_NOT_FOUND`）。

## 6. 已知未覆盖

- 卸载恰好在终态写入窗口内发生：代码路径会等待 writer 队列排空并冻结终态，但没有构造出稳定复现该时序的测试（需要可控的文件写入延迟）。
- `RECORD_WRITE_FAILED`：没有在 Windows 上稳定模拟只读目录，路径设计与错误分支存在但未被测试触发。
- 多 Host 共享同一 `dataDir`：首版明确不支持，未测。
- 真实宿主的 `workflow/*` 事件顺序：`attachProgress` 的缓冲与匹配逻辑有单测覆盖思路，但没有真实事件源。
