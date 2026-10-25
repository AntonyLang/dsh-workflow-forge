import { describe, expect, it } from "vitest";
import { renderReport } from "@workflow-forge/runtime";
import type { Material, ScenarioResult } from "@workflow-forge/checks";

const materials: Material[] = [
  {
    id: "m1",
    title: "正常标题\n# 伪造标题\n- 伪造条目",
    paragraphs: [{ paragraphId: "p1", text: "原文包含 ``` 与 # 号，用来测试模板逃逸。" }],
  },
];

const context = {
  runId: "20260101T000000Z-abcdef",
  workflowId: "source-brief",
  workflowVersion: "0.1.0",
  topic: "测试主题\n# 注入",
  language: "zh",
  dimensions: ["成本"],
  materials,
  generatedAt: "2026-01-01T00:00:00.000Z",
};

function completedResult(): ScenarioResult {
  return {
    status: "completed",
    brief: {
      title: "对比简报\n# 伪造标题",
      dimensions: [
        {
          dimension: "成本",
          findings: [
            { kind: "fact", text: "事实文本 ```\n# 伪造标题", evidenceIds: ["m1:1"] },
            { kind: "recommendation", text: "建议文本", evidenceIds: [] },
          ],
        },
      ],
      conclusions: [{ kind: "fact", text: "结论", evidenceIds: ["m1:1"] }],
    },
    evidence: {
      evidence: [
        {
          evidenceId: "m1:1",
          materialId: "m1",
          paragraphId: "p1",
          quote: "原文包含 ``` 与 # 号",
          statement: "事实",
        },
      ],
      successCount: 1,
      failedMaterials: [],
    },
    failedMaterials: [],
    checks: [{ rule: "evidence_ids_exist", ok: true }],
  };
}

describe("report rendering", () => {
  it("renders the fixed template and labels recommendations separately", () => {
    const report = renderReport(completedResult(), context);
    expect(report).toContain("## 结论");
    expect(report).toContain("**事实**");
    expect(report).toContain("**建议**");
    expect(report).toContain("## 来源片段");
    expect(report).toContain("`m1:1`");
    expect(report).toContain("## 未覆盖材料");
    expect(report).toContain("结构与引用检查通过并不等于事实准确");
  });

  it("collapses material text so it cannot forge headings, list items or code fences", () => {
    const report = renderReport(completedResult(), context);
    const lines = report.split("\n");
    expect(lines.some((line) => line.startsWith("# 伪造标题"))).toBe(false);
    expect(lines.some((line) => line.startsWith("- 伪造条目"))).toBe(false);
    expect(report).not.toContain("```");
  });

  it("explains an insufficient run instead of producing a report", () => {
    const result: ScenarioResult = {
      status: "insufficient_input",
      brief: null,
      evidence: {
        evidence: [],
        successCount: 0,
        failedMaterials: [{ materialId: "m1", index: 0, code: "EMPTY_FACTS", detail: "no facts" }],
      },
      failedMaterials: [{ materialId: "m1", index: 0, code: "EMPTY_FACTS", detail: "no facts" }],
      checks: [],
    };
    const report = renderReport(result, context);
    expect(report).toContain("未生成报告");
    expect(report).toContain("EMPTY_FACTS");
    expect(report).toContain("新的 runId");
    expect(report).not.toContain("## 逐维度比较");
  });

  it("lists uncovered materials in a completed report", () => {
    const result = completedResult();
    result.failedMaterials = [{ materialId: "m2", index: 1, code: "QUOTE_NOT_FOUND", detail: "p2" }];
    result.evidence.failedMaterials = result.failedMaterials;
    const report = renderReport(result, context);
    expect(report).toContain("`m2`");
    expect(report).toContain("QUOTE_NOT_FOUND");
  });
});
