# source-brief：资料结构化报告场景

首个场景，也是作者链路的验收对象：把 1-4 份已读取的文本材料抽取为可定位证据，再按指定维度生成带 `evidenceId` 引用的结构化报告。

## 文件

| 路径 | 内容 |
| --- | --- |
| `spec.json` | 完整的 WorkflowSpec 0.1：两个提示词、两个 schema、7 个节点 |
| `SKILL.md` | 打包进场景包的调用说明（参数、结果处理、边界） |
| `fixtures/` | 5 份脱敏输入，覆盖正常/冲突/部分失败/材料不足/换主题 |
| `packaged/` | `pnpm demo` 生成的构建产物（已 gitignore） |

## 节点结构

```text
extract   agent_map   对 1-4 份材料分批（每批 ≤2）抽取 facts
collect   transform   collect_evidence：证据编号 + 成功数 + 失败材料
gate      branch      successCount < minSuccessful ?
          ├─ then     insufficient → result(insufficient_input)
          └─ else     synthesize (agent) → verify (assert) → report (result)
```

最坏路径：4 个提取 Agent + 1 个汇总 Agent = 5，等于 `limits.maxDirectAgents`。

## 试跑与打包

`pnpm demo` 会自动完成：validate → 5 份 fixture 试跑 → 用 4 份 `COMPLETED` 的试跑打包 → 在新数据目录里从打包产物运行一次。

真实模型试跑：

```bash
# 在已安装作者插件的 DSH 会话里
forge_validate  { "spec": <spec.json> }
forge_trial     { "draftRef": "…", "input": <fixtures/01-normal.json> }
forge_trial     { "draftRef": "…", "input": <fixtures/05-second-topic.json> }
forge_package   { "draftRef": "…" }
```

`forge_package` 只返回 `packaged`。安装与真实模型贯通是另外两步，见 `docs/verification.md`。

## 说明

- fixtures 是自写脱敏文本，不含真实账号、内部链接或个人信息。
- mock 演示里的失败注入规则见 `fixtures/README.md`；真实运行时失败来自模型输出或材料本身。
