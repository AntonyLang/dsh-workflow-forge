# dsh-scenario-source-brief

DSH 场景插件：source-brief@0.1.0

把已读取的文本材料抽取为可定位证据，再按指定维度生成带 `evidenceId` 引用的结构化报告（JSON + Markdown）。报告由固定模板渲染，用户材料只作为数据进入。

## 一次调用

输入：

```json
{
  "topic": "三款笔记应用的取舍",
  "materials": [{ "id": "m1", "title": "访谈记录", "text": "第一段……\n第二段……" }],
  "dimensions": ["同步与离线", "检索与整理"],
  "language": "zh",
  "minSuccessful": 1
}
```

输出（canonical JSON）：`runId`、`state`、`businessStatus`、`checks`、`reportPath`、`resultPath`、`error`。

## 安装

1. 从 npm 安装：`dsh plugin add dsh-scenario-source-brief`；
   离线或尚未发布时，用目标 DSH 版本的 Plugin Manager 指向本目录（或仓库中该子目录）。
2. **配置 `dataDir`**：必须是宿主允许的绝对目录。运行输入、报告与记录都写在这里；模型不能选择写入路径。
3. 在**新会话**中调用工具 `source_brief`。

## 内容

| 路径 | 作用 |
| --- | --- |
| `dist/index.js` | 场景工具、Skill 注册、薄 runtime 与校验器（ESM bundle，无 `@deepseek-ai/*` import） |
| `assets/workflow.js` | 固定脚本，原生 workflow 引擎实际执行的字节 |
| `assets/workflow.json` | 固定 WorkflowSpec，供解释与复核 |
| `assets/build.json` | 版本、hash、依赖与验证摘要 |
| `assets/prompts`、`assets/schemas` | 本版提示词与数据契约 |
| `skills/source-brief/SKILL.md` | 调用场景、参数说明、结果处理 |
| `examples` | 脱敏输入与失败案例说明 |
| `cordis.patch.yml` | 宿主 bundle 的 insert 入口 |

## 结果处理

| state | 该做什么 |
| --- | --- |
| `COMPLETED` | 用 `reportPath` 的内容作为回答主体，并说明"未覆盖材料"一节 |
| `INSUFFICIENT_INPUT` | 不要伪造报告；说明失败材料与下一步，或询问是否降低 `minSuccessful` |
| `FAILED` | 按 `error.code` 解释；`ASSERTION_FAILED` 表示引用/维度检查没通过 |
| `CANCELLED` / `UNKNOWN` | 说明取消来源或查看 runId 记录；重跑一定是新 runId |

## 兼容性

| 项 | 值 |
| --- | --- |
| `engines.dsh` | `0.2.1-rc.3`（方案源码基线提交 `22ddee3`） |
| target adapter | `dsh-workflow-ptc-adapter@0.1.0` |
| compiler | `0.1.0` |
| runtime | `0.1.0` |
| 验证状态 | `packaged` |

> 本构建的试跑来自离线 mock 引擎，因此只记录为 `packaged`；真实模型与真实宿主的贯通需要另一次 host 试跑。

## 版本与 hash

- `specHash`: `sha256:09562031c1dfb55641919b66624f77a3d5b821ad6068898104a4b5bcd602555b`
- `scriptHash`: `sha256:0227ab9faf3321495f852096907c43381ca36636beae1134032ffa5f32fc7b89`
- `draftHash`: `sha256:ad858dc6b4da10e943d171ec714a060deb107967318241f37cc592f9de16f15a`
- `buildHash`: `sha256:1f2e13472402f2bbc7e614e700136a9a3930bb52955ebe609f38dbeb4453620c`

安装不等于业务可用：安装证明 `exports`、依赖与 profile 配置正确，业务试跑才证明模型结构化输出与文件策略能一起工作。

## 边界

- 只处理已读取的文本；不读文件、不联网、不负责把 URL 变成文本。
- 不提供跨重启恢复；`run.json` 是诊断记录，不是断点。
- 结构化检查只证明 quote 可定位、evidenceId 存在、维度齐全，**不证明事实判断正确**。
- 不包含作者插件或编译器，运行期不解释 WorkflowSpec。
- 不包含任何模型密钥、用户材料或运行记录。

## License

MIT
