# 数据合同

本文件描述 `source-brief` 场景的输入、中间值与输出。所有字段都在 Ajv 严格模式下校验：额外字段是错误，不会静默删除。

## 1. 公开输入（`source-brief-input@1`）

工具参数直接对应这个结构：

```json
{
  "topic": "三款笔记应用的取舍",
  "materials": [
    { "id": "m1", "title": "用户访谈记录", "text": "第一段。\n第二段。", "sourceRef": "interview-2026-09" }
  ],
  "dimensions": ["同步与离线", "检索与整理"],
  "language": "zh",
  "minSuccessful": 2
}
```

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `topic` | 是 | 去空白后非空 |
| `materials` | 是 | 1-4 份 |
| `materials[].id` | 是 | `^[A-Za-z0-9_-]{1,32}$`，不得重复；**不是**文件路径 |
| `materials[].title` | 是 | 去空白后非空 |
| `materials[].text` | 是 | 已读取的纯文本 |
| `materials[].sourceRef` | 否 | 只作出处说明，不参与身份 |
| `dimensions` | 否 | 1-6 个不重复的非空字符串 |
| `language` | 否 | 语言标签，默认 `zh` |
| `minSuccessful` | 否 | 整数 1..材料数；默认等于材料数 |

超限会返回“需要分批”的具体原因，不会截断原文：单份 8000、合计 24000 个 Unicode code point。

## 2. 规范化输入（`source-brief-normalized@1`）

wrapper 在调用引擎前完成，`scope=input` 读到的是这一层：

```json
{
  "topic": "…",
  "materials": [
    { "id": "m1", "title": "…", "paragraphs": [{ "paragraphId": "p1", "text": "第一段。" }] }
  ],
  "dimensions": ["…"],
  "language": "zh",
  "minSuccessful": 2
}
```

- 换行统一为 `\n`（`\r\n`、`\r` 都归一到 `\n`）。
- 按换行切分，逐段去空白，丢弃空段；`paragraphId` 是段落在该材料内的 1 基序号（`p1`、`p2`…），对同一文本稳定。
- **公开契约与规范化契约分开**：工具参数用前者校验，脚本符号表用后者推导类型，避免用公开 schema 去检查段落字段。

`normalizedInputHash` 覆盖：normalizer 版本、`topic`、每份材料的 `id/title/paragraphs`、`dimensions`、`language`、`minSuccessful`。改主题、改维度、改阈值都算新输入；`sourceRef` 只是出处说明，不进 hash。

## 3. 中间值

| 对象 | 必需字段 | 约束 |
| --- | --- | --- |
| `EvidenceFact` | `paragraphId`、`quote`、`statement` | quote 必须能在该段落定位（忽略空白差异） |
| `MaterialResult` | `materialId`、`index`、`ok`，以及 `value` 或 `error` | 数组位置与输入位置一致，失败也保留 |
| `Evidence` | `evidenceId`、`materialId`、`paragraphId`、`quote`、`statement` | `evidenceId = <materialId>:<材料内事实序号>`，程序生成 |
| `EvidenceSet` | `evidence`、`successCount`、`failedMaterials` | `successCount` 只计有有效事实的材料 |
| `Finding` | `kind`、`text`、`evidenceIds` | `kind` 为 `fact` 或 `recommendation` |
| `Brief` | `title`、`dimensions`、`conclusions` | 每个维度含 findings；conclusions 也是 Finding 数组 |
| `ScenarioResult` | `status`、`brief`、`evidence`、`failedMaterials`、`checks` | 非成功状态 `brief` 必须为 `null` |

规则：

- 空 facts、空 statement、引用不存在的段落、quote 不在该段落内，都会把**该材料**记为失败并保存原因；v0.1 没有“挽救部分错误事实”的分支。
- 相同语句出现在不同材料时保留各自来源（`m1:1` 与 `m2:1` 是两条证据），去重会丢出处。
- `evidenceId` 只由材料 id 与事实序号组合，因此唯一；同一材料内序号从 1 开始。
- 每个请求维度必须**恰好出现一次**；不含未请求的维度。
- `title`、`statement`、每条 `Finding.text` 去空白后必须非空；每个维度至少一条 finding，`conclusions` 至少一条，且至少一条 fact 带有效 `evidenceId`。

## 4. 输出（`source-brief-result@1`）

```json
{
  "status": "completed",
  "brief": {
    "title": "…",
    "dimensions": [{ "dimension": "…", "findings": [{ "kind": "fact", "text": "…", "evidenceIds": ["m1:1"] }] }],
    "conclusions": [{ "kind": "recommendation", "text": "…", "evidenceIds": [] }]
  },
  "evidence": { "evidence": [], "successCount": 2, "failedMaterials": [] },
  "failedMaterials": [],
  "checks": [{ "rule": "evidence_ids_exist", "ok": true }]
}
```

- `status` 由程序赋值：`completed` / `insufficient_input` / `failed` / `cancelled`。
- `checks` 由脚本内 assert 与宿主复核合并，同一规则只保留一条（宿主结论优先）。
- 报告由固定模板从 `ScenarioResult` 渲染，格式不交给模型。

## 5. 运行记录 `run.json`

| 字段 | 说明 |
| --- | --- |
| `recordVersion` | `"0.1"` |
| `runId` / `engineRunId` | 本项目生成 / 引擎返回后填入；启动前取消时后者为 `null` |
| `workflowId` / `workflowVersion` | 场景身份 |
| `specHash` / `draftHash` / `scriptHash` / `runtimeArtifactHash` / `checksHash` / `buildHash` | 本次使用的定义与实现快照 |
| `compilerVersion` / `runtimeVersion` | 实现版本 |
| `inputHash` | 规范化输入 hash；输入无效时为 `null` |
| `hostVersion` / `hostBootId` | 目标宿主标识 |
| `engineKind` | `host` 或 `mock`（区分真实引擎与离线演示） |
| `state` | `STARTING` / `RUNNING` / `SETTLING` / 终态 |
| `engineStopReason` | 引擎原值：`completed` / `cancelled` / `error` / `null` |
| `businessStatus` | 业务状态：`completed` / `insufficient_input` / `null` |
| `agentsStarted` | 观察到的 agent 启动数；无法观察时为 `null`，不估算 |
| `startedAt` / `finishedAt` | 实际时间 |
| `deadlineMs` | 本次生效的运行期限 |
| `checks` / `artifacts` / `error` / `cleanupError` | 检查记录、产物路径、错误与清理错误 |

时间、模型标识与实际用量都来自观察；宿主没有给出的 token/费用保留 unknown，不用直接 Agent 数推算。

## 6. 限额汇总

| 限额 | 值 | 超限结果 |
| --- | --- | --- |
| 材料数 | 1-4 | `INPUT_LIMIT_EXCEEDED`，不启动 Agent |
| 单份材料 | 8000 code point | `INPUT_LIMIT_EXCEEDED` |
| 材料合计 | 24000 code point | `INPUT_LIMIT_EXCEEDED` |
| 维度数 | 1-6 | `INPUT_LIMIT_EXCEEDED` |
| 每批并发 | 2 | 编译期固定，自检断言 |
| 最坏直接 Agent | 5 | `AGENT_BUDGET_EXCEEDED` |
| 结果体积 | 512 KiB | `RESULT_TOO_LARGE` |
