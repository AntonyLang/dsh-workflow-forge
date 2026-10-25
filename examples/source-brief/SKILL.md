---
name: source-brief
description: 把 1-4 份已经读取成文本的材料，抽取为可定位证据，再按指定维度生成带 evidenceId 引用的结构化报告（JSON + Markdown）。
---

# source-brief 场景

当用户给出几份**已经读取成文本**的材料，并希望得到一份可以回溯到原文片段的对比报告时，调用本场景。它不负责读网页、读 PDF 或读本地文件：那些由宿主已有能力完成，再把文本作为 `text` 投递进来。

## 调用

工具名：`source_brief`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `topic` | 是 | 报告主题，一句话。它会进入 `normalizedInputHash`，改主题等于换输入。 |
| `materials` | 是 | 1-4 份材料，每份 `{ id, title, text, sourceRef? }`。`id` 只用于本场景，不要放文件路径。 |
| `dimensions` | 否 | 1-6 个比较维度，重复项会被拒绝。每个维度在报告里必须恰好出现一次。 |
| `language` | 否 | 输出语言标签，默认 `zh`。 |
| `minSuccessful` | 否 | 至少需要成功的材料数，默认等于材料总数。允许部分覆盖时才降低它。 |

单份材料最多 8000 个 Unicode code point，合计最多 24000；超限会返回"需要分批"的原因，不会静默截断。

## 结果处理

工具返回一个 canonical JSON，不要再解析散文：

| 字段 | 含义 |
| --- | --- |
| `runId` | 本次运行标识；重跑一定是新的 runId |
| `state` | `COMPLETED` / `INSUFFICIENT_INPUT` / `FAILED` / `CANCELLED` / `UNKNOWN` |
| `businessStatus` | `completed` 或 `insufficient_input` |
| `checks` | 每条业务检查的规则名与是否通过 |
| `reportPath` / `resultPath` | Markdown 报告与 JSON 结果的实际路径 |
| `error` | `{ code, message }`，按 code 解释，不要靠错误文本猜 |

- `COMPLETED`：把 `reportPath` 的内容作为回答主体，并说明"未覆盖材料"一节。
- `INSUFFICIENT_INPUT`：不要伪造报告。说明哪些材料失败、需要补什么，或询问是否可以降低 `minSuccessful`。
- `FAILED` 且 `error.code` 为 `ASSERTION_FAILED`：报告没有通过引用或维度检查，说明是哪条规则，不要当成编排故障。
- `CANCELLED`：说明取消来源（调用方、运行期限或插件卸载）。
- `UNKNOWN`：结果或清理没有干净完成，提示用户查看 `runId` 对应的记录。

## 边界

- 结构化检查通过只证明 quote 能在指定段落里定位、evidenceId 存在、维度齐全；**不证明**事实判断一定正确。抽样核对仍然需要人来做。
- 建议项在报告里标为"建议"，与"事实"分开；不要把推断写成事实。
- 未覆盖材料会列在报告末尾；不要把它们的内容写进结论。
- 运行记录是诊断依据，不保证同样输入得到逐字相同的输出。
