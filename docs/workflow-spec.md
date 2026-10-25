# WorkflowSpec 0.1 参考

`WorkflowSpec` 是本项目自定义的格式，**不是** DSH 原生文件格式。它是纯数据：没有任何用户函数体、表达式字符串或文件路径。

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `specVersion` | `"0.1"` | 是 | 格式版本；其他值直接拒绝 |
| `workflowId` | string | 是 | `^[a-z][a-z0-9-]{1,62}$`，决定工具名与包名 |
| `version` | string | 是 | semver，如 `0.1.0` |
| `title` / `description` | string | 否 | 供人阅读 |
| `inputContract` | string | 是 | 必须是内置的 `source-brief-input@1` |
| `normalizedInputContract` | string | 是 | 必须是内置的 `source-brief-normalized@1` |
| `outputContract` | string | 是 | 必须是内置的 `source-brief-result@1` |
| `limits` | object | 是 | `maxMaterials`(1-4)、`mapConcurrency`(1-2)、`maxDirectAgents`(1-5) |
| `assets.prompts` | `Record<string,string>` | 是 | 逻辑键 → 提示词正文，至少一条 |
| `assets.schemas` | `Record<string,JsonSchema>` | 是 | 逻辑键 → agent 输出 schema，至少一条 |
| `steps` | Step[] | 是 | 1-32 个，最后一条必须能终结路径 |

未知字段一律报 `UNKNOWN_FIELD`，不会被忽略。

## 值表达式

```ts
type ValueRef = { ref: { scope: "input" | "node" | "item"; node?: string; path: Array<string | number> } };
type ValueExpr = ValueRef | { literal: JsonValue };
```

| scope | 可读内容 | 限制 |
| --- | --- | --- |
| `input` | 规范化输入（`topic`、`materials[].paragraphs`…） | 不携带 `node` |
| `node` | 已完成节点的输出 | 必须写 `node`；不能引用未来节点或兄弟分支 |
| `item` | `agent_map` 当前元素 | 只能在 `agent_map.task` 内使用 |

- `path` 只由字段名和非负数组下标组成，禁止 `__proto__`、`prototype`、`constructor`。
- 解析走对象自有字段，不执行 getter、不做原型查找。
- 读取 agent 输出里未声明或非 required 的字段会被拒绝（`UNKNOWN_FIELD_ACCESS` / `OPTIONAL_FIELD_READ`）。

## 六类节点

### `agent`

```json
{ "id": "synthesize", "kind": "agent", "prompt": "synthesize", "outputSchema": "Brief",
  "label": { "literal": "synthesize" },
  "bindings": { "topic": { "ref": { "scope": "input", "path": ["topic"] } } } }
```

一个自包含任务。必须给出 object-rooted 的 `outputSchema`；编译器生成 `await agent(...)` 加 null 检查（null → `AGENT_RESULT_MISSING`）。`label` 是字符串表达式，仅用于观测。

### `agent_map`

```json
{ "id": "extract", "kind": "agent_map",
  "items": { "ref": { "scope": "input", "path": ["materials"] } },
  "task": { "prompt": "extract", "outputSchema": "EvidenceExtract",
            "label": { "ref": { "scope": "item", "path": ["id"] } },
            "bindings": { "material": { "ref": { "scope": "item", "path": [] } } } },
  "failurePolicy": "collect" }
```

- `items` 必须是**有上界**的数组（v0.1 只接受 `input.materials`，上界为 `limits.maxMaterials`）。
- 编译成按输入序号切批的有限 `for`，每批最多 `mapConcurrency` 个 thunk，等待整批结束。
- 输出与输入**位置对齐**的 `MaterialResult[]`：成功保留 `value`，失败保留 `{ materialId, index, error }`。
- `failurePolicy` 默认 `collect`；这是唯一会被展开的默认值，并记录在 `defaultsApplied`。
- 不能嵌套 `agent_map` 或 `branch`。

### `transform`

```json
{ "id": "collect", "kind": "transform", "op": "collect_evidence",
  "bindings": { "materials": { "ref": { "scope": "input", "path": ["materials"] } },
                "results":   { "ref": { "scope": "node", "node": "extract", "path": [] } } } }
```

| op | 必需 binding | 附加字段 | 输出 |
| --- | --- | --- | --- |
| `collect_evidence` | `materials`、`results` | – | `EvidenceSet` |
| `select_fields` | `source` | `fields: string[]` | 投影后的对象 |
| `stable_sort` | `items` | `fields: string[]` | 同类型数组，稳定排序 |

所有 op 都是注册白名单里的纯 JSON 操作，没有 `functionBody` 入口。

### `assert`

```json
{ "id": "verify", "kind": "assert",
  "rules": ["evidence_ids_exist", "required_dimensions", "non_empty_brief", "result_size"],
  "bindings": { "brief": { "ref": { "scope": "node", "node": "synthesize", "path": [] } },
                "evidence": { "ref": { "scope": "node", "node": "collect", "path": ["evidence"] } },
                "dimensions": { "ref": { "scope": "input", "path": ["dimensions"] } } } }
```

| 规则 | 需要 binding | 作用 |
| --- | --- | --- |
| `input_limits` | –（脚本内读 `args`） | 复核材料数、维度数、`minSuccessful` |
| `evidence_ids_exist` | `brief`、`evidence` | 每条 fact 至少一个引用，且引用真实存在 |
| `required_dimensions` | `brief`、`dimensions` | 每个维度恰好出现一次、无多余维度、有 findings |
| `non_empty_brief` | `brief` | 标题、结论、每条 finding 文本非空；至少一条带有效证据的 fact |
| `result_size` | `brief` | 规范化结果不超过 512 KiB |

失败即抛结构化错误（`ASSERTION_FAILED`），停止该路径；不会生成成功报告，也不会自动“修复”内容。

### `branch`

```json
{ "id": "gate", "kind": "branch",
  "condition": { "op": "lt",
    "left":  { "ref": { "scope": "node", "node": "collect", "path": ["successCount"] } },
    "right": { "ref": { "scope": "input", "path": ["minSuccessful"] } } },
  "then": [ { "id": "insufficient", "kind": "result", "status": "insufficient_input" } ],
  "else": [ { "id": "synthesize", "kind": "agent", "...": "..." },
            { "id": "verify", "kind": "assert", "...": "..." },
            { "id": "report", "kind": "result", "status": "completed" } ] }
```

- 只能是**顶层最后一步**；不能嵌套；两支都是直线块，各以 `result` 结束，不发生合流。
- 条件操作：`eq`、`lt`、`is_empty`、`any`/`all`（最多 8 个，`any`/`all` 可嵌套）。
- 因此每条执行路径的可见结果与结束位置都能静态确定。

### `result`

```json
{ "id": "report", "kind": "result", "status": "completed",
  "value": { "brief":   { "ref": { "scope": "node", "node": "synthesize", "path": [] } },
             "evidence":{ "ref": { "scope": "node", "node": "collect", "path": [] } },
             "failedMaterials": { "ref": { "scope": "node", "node": "collect", "path": ["failedMaterials"] } },
             "checks":  { "ref": { "scope": "node", "node": "verify", "path": ["checks"] } } } }
```

- `status` 只能是 `completed` 或 `insufficient_input`；`cancelled`/`failed` 由宿主赋值，用户写不了。
- `value` 的键只能是 `brief`、`evidence`、`failedMaterials`、`checks`。
- 编译器生成 `return finalize(status, {...})`，`status` 是程序常量，不是用户代码。

## 提示词占位

提示词正文里用 `{{bindingName}}` 引用绑定。编译期检查：

- 每个占位都必须有同名 binding（`PROMPT_BINDING_MISSING`，错误）；
- 每个 binding 都必须被提示词用到（`PROMPT_BINDING_UNUSED`，警告）；
- 渲染时字符串原样插入，其他值 JSON 序列化；缺键在运行期抛 `MISSING_PROMPT_BINDING`。

## limits 与预算

| 限额 | 值 | 在哪检查 |
| --- | --- | --- |
| 材料数 | 1-4 | 输入规范化 + `input_limits` |
| 单个维度数 | 1-6，不重复 | 输入规范化 |
| 单份材料 | 8000 code point | 输入规范化 |
| 合计 | 24000 code point | 输入规范化 |
| 每批并发 | 1-2 | spec limits + 自检断言 |
| 最坏直接 Agent | ≤ 5 | 编译器静态预算 |
| 结果体积 | ≤ 512 KiB | `result_size` |

## 常见诊断码

| 码 | 含义 |
| --- | --- |
| `UNKNOWN_FIELD` | 定义了 schema 之外的字段 |
| `UNKNOWN_NODE_REFERENCE` | 引用了不存在的节点 |
| `FORWARD_NODE_REFERENCE` | 引用了尚未完成的节点 |
| `SIBLING_BRANCH_REFERENCE` | 引用了另一分支的结果 |
| `ITEM_SCOPE_OUTSIDE_TASK` | 在 `agent_map.task` 之外用了 `scope=item` |
| `UNKNOWN_FIELD_ACCESS` | 读 schema 未声明的字段 |
| `OPTIONAL_FIELD_READ` | 未检查就直读可选字段 |
| `TYPE_MISMATCH` | 引用类型与操作不符（如对字符串用 `lt`） |
| `FORBIDDEN_PATH_SEGMENT` | path 里出现 `__proto__` 等片段 |
| `UNSUPPORTED_AGENT_SCHEMA` | agent schema 用了原生子集之外的字段 |
| `BRANCH_NOT_TERMINAL` / `NESTED_BRANCH` / `MISSING_RESULT` | 控制流结构不合法 |
| `AGENT_BUDGET_EXCEEDED` | 最坏路径 Agent 数超限 |
| `UNBOUNDED_MAP_ITEMS` | map 的 items 没有确定上界 |
| `PROMPT_BINDING_MISSING` / `PROMPT_BINDING_UNUSED` | 占位与绑定不一致 |
| `UNKNOWN_ASSET_KEY` | 引用了未定义的 prompt/schema |
| `SCRIPT_SYNTAX_ERROR` / `SCRIPT_SELF_CHECK_FAILED` | 生成脚本或自检失败（编译器缺陷） |

每条诊断都带 `fieldPath`（如 `steps/gate/condition/left`）、可选的 `nodeId`、`message` 和 `fix`。

## 最小完整定义

```json
{
  "specVersion": "0.1",
  "workflowId": "tiny-flow",
  "version": "0.1.0",
  "inputContract": "source-brief-input@1",
  "normalizedInputContract": "source-brief-normalized@1",
  "outputContract": "source-brief-result@1",
  "limits": { "maxMaterials": 2, "mapConcurrency": 2, "maxDirectAgents": 2 },
  "assets": {
    "prompts": { "only": "主题：{{topic}}" },
    "schemas": {
      "Facts": { "type": "object", "additionalProperties": false,
                 "required": ["facts"],
                 "properties": { "facts": { "type": "array", "items": { "type": "string" } } } }
    }
  },
  "steps": [
    { "id": "extract", "kind": "agent", "prompt": "only", "outputSchema": "Facts",
      "bindings": { "topic": { "ref": { "scope": "input", "path": ["topic"] } } } },
    { "id": "done", "kind": "result", "status": "insufficient_input" }
  ]
}
```

完整场景见 `examples/source-brief/spec.json`。
