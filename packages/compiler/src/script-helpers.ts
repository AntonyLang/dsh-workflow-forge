/**
 * The fixed helper prelude embedded into every emitted script.
 *
 * This is plain JavaScript source, not TypeScript: the native workflow script
 * has no imports, no filesystem, no network and no Node API, so the helpers must
 * be inlined at compile time. Behaviour is intentionally mirrored by the host
 * checks in packages/checks; tests assert the two agree on the shared cases.
 */
export const SCRIPT_HELPERS_SOURCE = String.raw`
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
`;

/** Hash input for the runtime artifact: the embedded helpers plus the wrapper marker. */
export const SCRIPT_RUNTIME_MARKER = "workflow-forge/script-runtime/0.1.0";
