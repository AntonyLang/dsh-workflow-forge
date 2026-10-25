/* Workflow Forge generated script — do not edit.
 * workflow: source-brief@0.1.0
 * specHash: sha256:09562031c1dfb55641919b66624f77a3d5b821ad6068898104a4b5bcd602555b
 * compiler: 0.1.0
 */
const __P = {
  "extract": "你是资料抽取助手。只依据下面这一份材料提取可核验的事实，不要引入材料之外的知识。\n\n主题：{{topic}}\n输出语言：{{language}}\n材料（JSON）：{{material}}\n\n只返回 JSON，不要任何解释或代码块标记，结构如下：\n{\"facts\":[{\"paragraphId\":\"材料中的段落编号\",\"quote\":\"逐字摘自该段落的原文片段\",\"statement\":\"用输出语言概括这条事实\"}]}\n\n要求：\n1. paragraphId 必须取自材料 paragraphs 中真实存在的编号；\n2. quote 必须是该段落原文的连续片段，不要改写、不要拼接不同段落；\n3. statement 必须是可以由 quote 直接支持的陈述；\n4. 至少 1 条、最多 8 条；确实没有可提取事实时返回 {\"facts\":[]}。",
  "synthesize": "你是比较分析助手。依据给定证据集，围绕指定比较维度写一份结构化报告，只能使用证据集中出现的材料内容。\n\n主题：{{topic}}\n输出语言：{{language}}\n比较维度：{{dimensions}}\n证据集（JSON）：{{evidence}}\n\n只返回 JSON，不要任何解释或代码块标记，结构如下：\n{\"title\":\"报告标题\",\"dimensions\":[{\"dimension\":\"维度名称\",\"findings\":[{\"kind\":\"fact\",\"text\":\"该维度下的事实性结论\",\"evidenceIds\":[\"m1:1\"]}]}],\"conclusions\":[{\"kind\":\"fact\",\"text\":\"总体结论\",\"evidenceIds\":[\"m1:1\"]}]}\n\n要求：\n1. dimensions 必须与给定维度一一对应、顺序一致，每个维度至少一条 finding；\n2. 每条 fact 必须引用至少一个真实存在的 evidenceId，不要编造编号；\n3. 只是建议、推断或主观评价的内容必须标为 recommendation；\n4. conclusions 至少一条；\n5. 证据不足时如实说明，不要补充证据集之外的信息。"
};
const __S = {
  "EvidenceExtract": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "facts"
    ],
    "properties": {
      "facts": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "paragraphId",
            "quote",
            "statement"
          ],
          "properties": {
            "paragraphId": {
              "type": "string"
            },
            "quote": {
              "type": "string"
            },
            "statement": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "Brief": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "title",
      "dimensions",
      "conclusions"
    ],
    "properties": {
      "title": {
        "type": "string"
      },
      "dimensions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "dimension",
            "findings"
          ],
          "properties": {
            "dimension": {
              "type": "string"
            },
            "findings": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "kind",
                  "text",
                  "evidenceIds"
                ],
                "properties": {
                  "kind": {
                    "type": "string",
                    "enum": [
                      "fact",
                      "recommendation"
                    ]
                  },
                  "text": {
                    "type": "string"
                  },
                  "evidenceIds": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          }
        }
      },
      "conclusions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "kind",
            "text",
            "evidenceIds"
          ],
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "fact",
                "recommendation"
              ]
            },
            "text": {
              "type": "string"
            },
            "evidenceIds": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  }
};
function __wfError(code, details) {
  var payload = Object.assign({ code: code }, details || {});
  var error = new Error("__WF_ERROR__" + JSON.stringify(payload));
  error.wfCode = code;
  error.wfDetails = payload;
  return error;
}

function collapse(text) {
  return String(text === null || text === undefined ? "" : text).replace(/\s+/g, " ").trim();
}

function squash(text) {
  return String(text === null || text === undefined ? "" : text).replace(/\s+/g, "");
}

function byteLength(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch (_error) {
    return text.length;
  }
}

function renderPrompt(template, values) {
  var table = values || {};
  return String(template).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, function (match, key) {
    if (!Object.prototype.hasOwnProperty.call(table, key)) {
      throw __wfError("MISSING_PROMPT_BINDING", { key: key });
    }
    var value = table[key];
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function itemId(item, index) {
  if (item !== null && typeof item === "object" && typeof item.id === "string" && item.id.length > 0) return item.id;
  return "item" + index;
}

function failedMaterial(materialId, index, code, detail) {
  var failure = { materialId: materialId, index: index, code: code };
  if (detail !== undefined) failure.detail = detail;
  return { materialId: materialId, index: index, ok: false, error: { code: code, detail: detail } };
}

function checkedMaterial(material, index, raw) {
  if (material === null || typeof material !== "object" || !Array.isArray(material.paragraphs)) {
    return failedMaterial(itemId(material, index), index, "INVALID_MATERIAL", "material has no paragraphs array");
  }
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.facts)) {
    return failedMaterial(material.id, index, "INVALID_EXTRACT_SCHEMA", "agent output is not {facts: []}");
  }
  var facts = raw.facts;
  if (facts.length === 0) {
    return failedMaterial(material.id, index, "EMPTY_FACTS", "material returned no facts");
  }
  var paragraphs = Object.create(null);
  for (var p = 0; p < material.paragraphs.length; p++) {
    paragraphs[material.paragraphs[p].paragraphId] = material.paragraphs[p].text;
  }
  for (var i = 0; i < facts.length; i++) {
    var fact = facts[i];
    if (fact === null || typeof fact !== "object") {
      return failedMaterial(material.id, index, "INVALID_EXTRACT_SCHEMA", "facts[" + i + "] is not an object");
    }
    var paragraph = paragraphs[fact.paragraphId];
    if (typeof paragraph !== "string") {
      return failedMaterial(material.id, index, "UNKNOWN_PARAGRAPH_ID", "facts[" + i + "]: " + String(fact.paragraphId));
    }
    if (collapse(fact.statement).length === 0) {
      return failedMaterial(material.id, index, "EMPTY_STATEMENT", "facts[" + i + "]");
    }
    var quote = squash(fact.quote);
    if (quote.length === 0) {
      return failedMaterial(material.id, index, "QUOTE_NOT_FOUND", "facts[" + i + "]: empty quote");
    }
    if (squash(paragraph).indexOf(quote) === -1) {
      return failedMaterial(material.id, index, "QUOTE_NOT_FOUND", "facts[" + i + "]: " + fact.paragraphId);
    }
  }
  return { materialId: material.id, index: index, ok: true, value: { facts: facts } };
}

function collectEvidence(materials, results) {
  var evidence = [];
  var failedMaterials = [];
  var successCount = 0;
  for (var i = 0; i < materials.length; i++) {
    var material = materials[i];
    var result = results[i];
    if (!result || result.materialId !== material.id) {
      failedMaterials.push({ materialId: material.id, index: i, code: "RESULT_MISALIGNED", detail: result ? String(result.materialId) : "missing" });
      continue;
    }
    if (!result.ok) {
      var failure = { materialId: material.id, index: i, code: result.error.code };
      if (result.error.detail !== undefined) failure.detail = result.error.detail;
      failedMaterials.push(failure);
      continue;
    }
    successCount += 1;
    for (var f = 0; f < result.value.facts.length; f++) {
      var fact = result.value.facts[f];
      evidence.push({
        evidenceId: material.id + ":" + (f + 1),
        materialId: material.id,
        paragraphId: fact.paragraphId,
        quote: fact.quote,
        statement: fact.statement
      });
    }
  }
  return { evidence: evidence, successCount: successCount, failedMaterials: failedMaterials };
}

function selectFields(source, fields) {
  var out = {};
  for (var i = 0; i < fields.length; i++) {
    var key = fields[i];
    if (source === null || typeof source !== "object") continue;
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  return out;
}

function stableSort(items, fields) {
  var decorated = [];
  for (var i = 0; i < items.length; i++) decorated.push({ item: items[i], index: i });
  decorated.sort(function (left, right) {
    for (var f = 0; f < fields.length; f++) {
      var key = fields[f];
      var a = left.item === null || left.item === undefined ? "" : left.item[key];
      var b = right.item === null || right.item === undefined ? "" : right.item[key];
      var sa = String(a === undefined || a === null ? "" : a);
      var sb = String(b === undefined || b === null ? "" : b);
      if (sa < sb) return -1;
      if (sa > sb) return 1;
    }
    return left.index - right.index;
  });
  return decorated.map(function (entry) { return entry.item; });
}

function lt(left, right) {
  return Number(left) < Number(right);
}

function eq(left, right) {
  return left === right;
}

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim().length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function __findings(brief) {
  var out = [];
  var d;
  var f;
  var dimension;
  for (d = 0; d < brief.dimensions.length; d++) {
    dimension = brief.dimensions[d];
    for (f = 0; f < dimension.findings.length; f++) {
      out.push({ where: "dimensions/" + d + "/findings/" + f, finding: dimension.findings[f] });
    }
  }
  for (f = 0; f < brief.conclusions.length; f++) {
    out.push({ where: "conclusions/" + f, finding: brief.conclusions[f] });
  }
  return out;
}

function __assertFail(rule, detail) {
  throw __wfError("ASSERTION_FAILED", { rule: rule, detail: detail });
}

function runAssertRules(input) {
  var rules = input.rules || [];
  var checks = [];
  var brief = input.brief;
  var evidenceSet = input.evidence;
  var evidenceItems = Array.isArray(evidenceSet)
    ? evidenceSet
    : (evidenceSet && Array.isArray(evidenceSet.evidence) ? evidenceSet.evidence : []);
  var dimensions = input.dimensions || [];

  var idSet = Object.create(null);
  var idx;
  for (idx = 0; idx < evidenceItems.length; idx++) idSet[evidenceItems[idx].evidenceId] = true;

  for (var r = 0; r < rules.length; r++) {
    var rule = rules[r];

    if (rule === "input_limits") {
      var materials = input.input && Array.isArray(input.input.materials) ? input.input.materials : [];
      if (materials.length < 1 || materials.length > 4) __assertFail(rule, "materials count " + materials.length);
      if (dimensions.length > 6) __assertFail(rule, "dimensions count " + dimensions.length);
      var minSuccessful = input.input ? Number(input.input.minSuccessful) : 0;
      if (!(minSuccessful >= 1 && minSuccessful <= materials.length)) __assertFail(rule, "minSuccessful " + minSuccessful);
      checks.push({ rule: rule, ok: true });
      continue;
    }

    if (brief === null || typeof brief !== "object") __assertFail(rule, "brief is not an object");

    if (rule === "evidence_ids_exist") {
      var all = __findings(brief);
      for (idx = 0; idx < all.length; idx++) {
        var finding = all[idx].finding;
        if (!finding || !Array.isArray(finding.evidenceIds)) __assertFail(rule, all[idx].where + ": evidenceIds is not an array");
        if (finding.kind === "fact" && finding.evidenceIds.length === 0) __assertFail(rule, all[idx].where + ": fact without evidence");
        for (var e = 0; e < finding.evidenceIds.length; e++) {
          var evidenceId = finding.evidenceIds[e];
          if (typeof evidenceId !== "string" || evidenceId.length === 0) __assertFail(rule, all[idx].where + ": empty evidence id");
          if (!idSet[evidenceId]) __assertFail(rule, all[idx].where + ": unknown evidence id " + evidenceId);
        }
      }
      checks.push({ rule: rule, ok: true });
      continue;
    }

    if (rule === "required_dimensions") {
      if (!Array.isArray(brief.dimensions)) __assertFail(rule, "dimensions is not an array");
      var counts = Object.create(null);
      for (idx = 0; idx < brief.dimensions.length; idx++) {
        var dimension = brief.dimensions[idx];
        var name = collapse(dimension.dimension);
        counts[name] = (counts[name] || 0) + 1;
        if (!Array.isArray(dimension.findings) || dimension.findings.length === 0) {
          __assertFail(rule, "dimension " + name + " has no findings");
        }
      }
      for (idx = 0; idx < dimensions.length; idx++) {
        var required = collapse(dimensions[idx]);
        if (!counts[required]) __assertFail(rule, "missing dimension " + required);
        if (counts[required] > 1) __assertFail(rule, "duplicated dimension " + required);
      }
      for (var key in counts) {
        var known = false;
        for (idx = 0; idx < dimensions.length; idx++) {
          if (collapse(dimensions[idx]) === key) known = true;
        }
        if (!known) __assertFail(rule, "unexpected dimension " + key);
      }
      checks.push({ rule: rule, ok: true });
      continue;
    }

    if (rule === "non_empty_brief") {
      if (collapse(brief.title).length === 0) __assertFail(rule, "empty title");
      if (!Array.isArray(brief.conclusions) || brief.conclusions.length === 0) __assertFail(rule, "no conclusions");
      var supported = 0;
      var entries = __findings(brief);
      for (idx = 0; idx < entries.length; idx++) {
        var item = entries[idx].finding;
        if (collapse(item.text).length === 0) __assertFail(rule, entries[idx].where + ": empty text");
        if (item.kind === "fact") {
          for (var s = 0; s < item.evidenceIds.length; s++) {
            if (idSet[item.evidenceIds[s]]) supported += 1;
          }
        }
      }
      if (supported === 0) __assertFail(rule, "no fact with valid evidence");
      checks.push({ rule: rule, ok: true });
      continue;
    }

    if (rule === "result_size") {
      var bytes = byteLength(JSON.stringify(brief));
      if (bytes > 524288) __assertFail(rule, bytes + " bytes");
      checks.push({ rule: rule, ok: true });
      continue;
    }

    __assertFail(rule, "unknown rule");
  }

  return { ok: true, checks: checks };
}

function finalize(status, value) {
  var source = value || {};
  return {
    status: status,
    brief: source.brief === undefined ? null : source.brief,
    evidence: source.evidence === undefined
      ? { evidence: [], successCount: 0, failedMaterials: [] }
      : source.evidence,
    failedMaterials: source.failedMaterials === undefined ? [] : source.failedMaterials,
    checks: source.checks === undefined ? [] : source.checks
  };
}

const v0 = [];
for (let __i = 0; __i < args["materials"].length; __i += 2) {
  const __b = args["materials"].slice(__i, __i + 2);
  const __r = await parallel(__b.map((__item) => () => agent(renderPrompt(__P["extract"], { "topic": args["topic"], "language": args["language"], "material": __item }), { schema: __S["EvidenceExtract"], label: __item["id"] })));
  for (let __j = 0; __j < __b.length; __j++) {
    const __x = __r[__j];
    v0.push(__x === null || __x === undefined
      ? failedMaterial(itemId(__b[__j], __i + __j), __i + __j, "NO_STRUCTURED_RESULT")
      : checkedMaterial(__b[__j], __i + __j, __x));
  }
}
const v1 = collectEvidence(args["materials"], v0);
if (lt(v1["successCount"], args["minSuccessful"])) {
  return finalize("insufficient_input", {
    "evidence": v1,
    "failedMaterials": v1["failedMaterials"],
    "checks": [{"rule":"input_limits","ok":true}],
  });
} else {
  const v4 = await agent(renderPrompt(__P["synthesize"], { "topic": args["topic"], "language": args["language"], "dimensions": args["dimensions"], "evidence": v1["evidence"] }), { schema: __S["Brief"], label: "synthesize" });
  if (v4 === null || v4 === undefined) throw __wfError("AGENT_RESULT_MISSING", { node: "synthesize" });
  const v5 = runAssertRules({
    rules: ["evidence_ids_exist","required_dimensions","non_empty_brief","result_size"],
    "brief": v4,
    "evidence": v1["evidence"],
    "dimensions": args["dimensions"],
    input: args,
  });
  return finalize("completed", {
    "brief": v4,
    "evidence": v1,
    "failedMaterials": v1["failedMaterials"],
    "checks": v5["checks"],
  });
}
