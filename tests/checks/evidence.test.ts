import { describe, expect, it } from "vitest";
import {
  checkBrief,
  checkEvidenceSet,
  collectEvidence,
  validateEvidenceExtract,
  type Brief,
  type Material,
  type MaterialResult,
} from "@workflow-forge/checks";

const material: Material = {
  id: "m1",
  title: "材料一",
  paragraphs: [
    { paragraphId: "p1", text: "本地优先架构：编辑先写入本地数据库，再在后台同步。" },
    { paragraphId: "p2", text: "离线编辑完全可用，冲突采用分叉副本策略。" },
  ],
};

function facts(overrides: Partial<{ paragraphId: string; quote: string; statement: string }> = {}): unknown {
  return {
    facts: [
      {
        paragraphId: "p1",
        quote: "编辑先写入本地数据库",
        statement: "编辑先落本地库",
        ...overrides,
      },
    ],
  };
}

describe("evidence extraction checks", () => {
  it("accepts a locatable quote", () => {
    const result = validateEvidenceExtract(material, facts());
    expect(result.ok).toBe(true);
  });

  it("accepts a quote whose whitespace differs from the paragraph", () => {
    const result = validateEvidenceExtract(material, facts({ quote: "编辑先写入\n本地数据库" }));
    expect(result.ok).toBe(true);
  });

  it("rejects a quote that is not in the specified paragraph", () => {
    const result = validateEvidenceExtract(material, facts({ quote: "编辑先写入本地数据库", paragraphId: "p2" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("QUOTE_NOT_FOUND");
  });

  it("rejects an unknown paragraph id", () => {
    const result = validateEvidenceExtract(material, facts({ paragraphId: "p9" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNKNOWN_PARAGRAPH_ID");
  });

  it("rejects an empty fact list", () => {
    const result = validateEvidenceExtract(material, { facts: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EMPTY_FACTS");
  });

  it("rejects an empty statement", () => {
    const result = validateEvidenceExtract(material, facts({ statement: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EMPTY_STATEMENT");
  });

  it("rejects an empty quote", () => {
    const result = validateEvidenceExtract(material, facts({ quote: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("QUOTE_NOT_FOUND");
  });

  it("rejects a structurally invalid extract", () => {
    const result = validateEvidenceExtract(material, { facts: "nope" });
    expect(result.ok).toBe(false);
  });
});

describe("evidence collection", () => {
  const ok: MaterialResult = {
    materialId: "m1",
    index: 0,
    ok: true,
    value: { facts: [{ paragraphId: "p1", quote: "编辑先写入本地数据库", statement: "a" }] },
  };
  const second: Material = { id: "m2", title: "材料二", paragraphs: [{ paragraphId: "p1", text: "另一段原文。" }] };
  const okSecond: MaterialResult = {
    materialId: "m2",
    index: 1,
    ok: true,
    value: { facts: [{ paragraphId: "p1", quote: "另一段原文", statement: "b" }] },
  };
  const failed: MaterialResult = { materialId: "m2", index: 1, ok: false, error: { code: "EMPTY_FACTS" } };

  it("keeps failures and stays aligned with input positions", () => {
    const set = collectEvidence([material, second], [ok, failed]);
    expect(set.successCount).toBe(1);
    expect(set.failedMaterials).toEqual([{ materialId: "m2", index: 1, code: "EMPTY_FACTS" }]);
    expect(set.evidence.map((item) => item.evidenceId)).toEqual(["m1:1"]);
  });

  it("detects a result that belongs to another position", () => {
    const set = collectEvidence([material, second], [okSecond, ok]);
    expect(set.successCount).toBe(0);
    expect(set.failedMaterials[0]?.code).toBe("RESULT_MISALIGNED");
  });

  it("keeps the same statement from different materials as separate evidence", () => {
    const sameStatement: Material = { id: "m2", title: "材料二", paragraphs: [{ paragraphId: "p1", text: "一样的原文" }] };
    const a: MaterialResult = { materialId: "m1", index: 0, ok: true, value: { facts: [{ paragraphId: "p1", quote: "编辑先写入本地数据库", statement: "相同结论" }] } };
    const b: MaterialResult = { materialId: "m2", index: 1, ok: true, value: { facts: [{ paragraphId: "p1", quote: "一样的原文", statement: "相同结论" }] } };
    const set = collectEvidence([material, sameStatement], [a, b]);
    expect(set.evidence).toHaveLength(2);
    expect(new Set(set.evidence.map((item) => item.evidenceId)).size).toBe(2);
  });

  it("re-verifies the evidence set against the stored materials", () => {
    const set = collectEvidence([material], [ok]);
    expect(checkEvidenceSet(set, [material]).ok).toBe(true);

    const tampered = { ...set, successCount: 0 };
    const check = checkEvidenceSet(tampered, [material]);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("EVIDENCE_SUCCESS_COUNT_MISMATCH");
  });

  it("rejects an evidence quote that no longer matches its paragraph", () => {
    const set = collectEvidence([material], [ok]);
    const moved = { ...set, evidence: set.evidence.map((item) => ({ ...item, quote: "不存在的原文" })) };
    const check = checkEvidenceSet(moved, [material]);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("QUOTE_NOT_FOUND");
  });
});

describe("brief checks", () => {
  const evidenceIds = new Set(["m1:1", "m1:2"]);
  const dimensions = ["成本", "风险"];

  function brief(overrides: Partial<Brief> = {}): Brief {
    return {
      title: "对比简报",
      dimensions: dimensions.map((dimension) => ({
        dimension,
        findings: [{ kind: "fact", text: `${dimension} 的结论`, evidenceIds: ["m1:1"] }],
      })),
      conclusions: [{ kind: "fact", text: "总体结论", evidenceIds: ["m1:1"] }],
      ...overrides,
    };
  }

  function codes(value: Brief, ids = evidenceIds): string[] {
    const outcome = checkBrief({ brief: value, evidenceIds: ids, dimensions });
    return outcome.diagnostics.map((diagnostic) => diagnostic.code);
  }

  it("accepts a complete brief", () => {
    const outcome = checkBrief({ brief: brief(), evidenceIds, dimensions });
    expect(outcome.ok).toBe(true);
    expect(outcome.checks.map((check) => check.rule)).toEqual([
      "evidence_ids_exist",
      "required_dimensions",
      "non_empty_brief",
      "result_size",
    ]);
  });

  it("rejects a citation of an evidence id that does not exist", () => {
    const value = brief({
      conclusions: [{ kind: "fact", text: "总体结论", evidenceIds: ["m9:9"] }],
    });
    expect(codes(value)).toContain("EVIDENCE_ID_UNKNOWN");
  });

  it("rejects a fact without evidence", () => {
    const value = brief({
      conclusions: [{ kind: "fact", text: "没有证据的结论", evidenceIds: [] }],
    });
    expect(codes(value)).toContain("EVIDENCE_IDS_EMPTY");
  });

  it("allows a recommendation without evidence", () => {
    const value = brief({
      conclusions: [
        { kind: "fact", text: "事实", evidenceIds: ["m1:1"] },
        { kind: "recommendation", text: "建议再核对", evidenceIds: [] },
      ],
    });
    expect(codes(value)).not.toContain("EVIDENCE_IDS_EMPTY");
  });

  it("rejects a missing dimension", () => {
    const value = brief({ dimensions: [{ dimension: "成本", findings: [{ kind: "fact", text: "x", evidenceIds: ["m1:1"] }] }] });
    expect(codes(value)).toContain("DIMENSION_MISSING");
  });

  it("rejects a duplicated dimension", () => {
    const value = brief({
      dimensions: [
        { dimension: "成本", findings: [{ kind: "fact", text: "x", evidenceIds: ["m1:1"] }] },
        { dimension: "成本", findings: [{ kind: "fact", text: "y", evidenceIds: ["m1:1"] }] },
        { dimension: "风险", findings: [{ kind: "fact", text: "z", evidenceIds: ["m1:1"] }] },
      ],
    });
    expect(codes(value)).toContain("DIMENSION_DUPLICATED");
  });

  it("rejects an unrequested dimension", () => {
    const value = brief({
      dimensions: [
        { dimension: "成本", findings: [{ kind: "fact", text: "x", evidenceIds: ["m1:1"] }] },
        { dimension: "风险", findings: [{ kind: "fact", text: "y", evidenceIds: ["m1:1"] }] },
        { dimension: "其他", findings: [{ kind: "fact", text: "z", evidenceIds: ["m1:1"] }] },
      ],
    });
    expect(codes(value)).toContain("DIMENSION_UNEXPECTED");
  });

  it("rejects a dimension without findings", () => {
    const value = brief({
      dimensions: [
        { dimension: "成本", findings: [] },
        { dimension: "风险", findings: [{ kind: "fact", text: "y", evidenceIds: ["m1:1"] }] },
      ],
    });
    expect(codes(value)).toContain("DIMENSION_EMPTY_FINDINGS");
  });

  it("rejects an empty conclusion list", () => {
    expect(codes(brief({ conclusions: [] }))).toContain("EMPTY_BRIEF");
  });

  it("rejects an empty finding text", () => {
    const value = brief({
      conclusions: [{ kind: "fact", text: "  ", evidenceIds: ["m1:1"] }],
    });
    expect(codes(value)).toContain("EMPTY_BRIEF");
  });

  it("rejects an empty title", () => {
    expect(codes(brief({ title: "" }))).toContain("EMPTY_BRIEF");
  });

  it("requires at least one fact with valid evidence", () => {
    const value = brief({
      dimensions: dimensions.map((dimension) => ({
        dimension,
        findings: [{ kind: "recommendation", text: "只是建议", evidenceIds: [] }],
      })),
      conclusions: [{ kind: "recommendation", text: "建议", evidenceIds: [] }],
    });
    expect(codes(value)).toContain("EMPTY_BRIEF");
  });

  it("rejects a result above the byte limit", () => {
    const outcome = checkBrief({ brief: brief(), evidenceIds, dimensions, maxResultBytes: 10 });
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain("RESULT_TOO_LARGE");
  });
});
