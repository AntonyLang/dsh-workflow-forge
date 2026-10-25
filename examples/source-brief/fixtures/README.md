# source-brief fixtures

五个脱敏输入，覆盖方案 §11.3 要求的五类情况。它们只包含**公开可提交**的材料文本，不含任何真实账号、内部链接或个人信息。

| 文件 | 覆盖的情况 | 预期 |
| --- | --- | --- |
| `01-normal.json` | 3 份材料、3 个维度，全部抽取成功 | `COMPLETED`，报告含 3 个维度与来源片段 |
| `02-conflicting.json` | 两份材料互相冲突、2 个维度 | `COMPLETED`，冲突以两条事实并列呈现 |
| `03-partial-failure.json` | 3 份材料，其中 1 份抽取失败，`minSuccessful: 2` | `COMPLETED`，失败材料进入"未覆盖材料" |
| `04-insufficient.json` | 2 份材料全部抽取失败，`minSuccessful: 2` | `INSUFFICIENT_INPUT`，不生成报告 |
| `05-second-topic.json` | 完全不同的主题与材料 | `COMPLETED`，证明参数路径使用新值 |

## 离线演示如何注入失败

`pnpm demo` 使用离线 mock 引擎，它按主题和 agent label 决定返回什么：

- 主题含"两个方案"→ 所有提取 agent 返回 `null`；
- 主题含"客服知识库迁移"且 label 为 `m3` → 该材料返回 `null`。

这只影响演示与测试，不影响真实运行：真实运行时由模型返回结构化 JSON。mock 产生的运行记录会标记 `engineKind: "mock"`，构建只会记为 `packaged`，不会声称 `runtime_verified`。
