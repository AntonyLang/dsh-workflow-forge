import { describe, expect, it } from "vitest";
import { normalizeInput, splitParagraphs } from "@workflow-forge/checks";
import type { JsonValue } from "@workflow-forge/spec";

function input(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    topic: "测试主题",
    materials: [
      { id: "m1", title: "材料一", text: "第一段。\n\n第二段。" },
      { id: "m2", title: "材料二", text: "另一段。" },
    ],
    dimensions: ["成本", "风险"],
    language: "zh",
    minSuccessful: 2,
    ...overrides,
  } as JsonValue;
}

function codesOf(raw: unknown): string[] {
  const result = normalizeInput(raw);
  return result.ok ? [] : result.diagnostics.map((d) => d.code);
}

describe("input normalization", () => {
  it("splits non-empty paragraphs and assigns stable ids", () => {
    expect(splitParagraphs("一\n\n二\n三")).toEqual([
      { paragraphId: "p1", text: "一" },
      { paragraphId: "p2", text: "二" },
      { paragraphId: "p3", text: "三" },
    ]);
    expect(splitParagraphs("\r\n甲\r\n\r\n乙\r\n")).toEqual([
      { paragraphId: "p1", text: "甲" },
      { paragraphId: "p2", text: "乙" },
    ]);
  });

  it("normalizes a valid input and hashes it", () => {
    const result = normalizeInput(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.materials[0]?.paragraphs).toHaveLength(2);
    expect(result.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("treats CRLF and LF as the same input", () => {
    const lf = normalizeInput(input({ materials: [{ id: "m1", title: "t", text: "一\n二" }], minSuccessful: 1 }));
    const crlf = normalizeInput(input({ materials: [{ id: "m1", title: "t", text: "一\r\n二" }], minSuccessful: 1 }));
    expect(lf.ok && crlf.ok).toBe(true);
    if (!lf.ok || !crlf.ok) return;
    expect(crlf.inputHash).toBe(lf.inputHash);
  });

  it("changes the input hash when the topic changes", () => {
    const first = normalizeInput(input());
    const second = normalizeInput(input({ topic: "另一个主题" }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.inputHash).not.toBe(first.inputHash);
  });

  it("defaults minSuccessful to the material count", () => {
    const result = normalizeInput({ topic: "t", materials: [{ id: "m1", title: "t", text: "x" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.minSuccessful).toBe(1);
    expect(result.input.language).toBe("zh");
  });

  it("rejects the fifth material before any agent could start", () => {
    const materials = [1, 2, 3, 4, 5].map((index) => ({ id: `m${index}`, title: `t${index}`, text: `正文 ${index}` }));
    expect(codesOf(input({ materials, minSuccessful: 1 }))).toContain("INPUT_LIMIT_EXCEEDED");
  });

  it("rejects minSuccessful above the material count", () => {
    expect(codesOf(input({ minSuccessful: 3 }))).toContain("INPUT_MIN_SUCCESSFUL_INVALID");
    expect(codesOf(input({ minSuccessful: 0 }))).toContain("INPUT_MIN_SUCCESSFUL_INVALID");
  });

  it("rejects a material id that looks like a path", () => {
    const materials = [{ id: "../secret", title: "t", text: "x" }];
    expect(codesOf(input({ materials, minSuccessful: 1 }))).toContain("INPUT_INVALID");
  });

  it("rejects duplicate material ids", () => {
    const materials = [
      { id: "m1", title: "a", text: "x" },
      { id: "m1", title: "b", text: "y" },
    ];
    expect(codesOf(input({ materials, minSuccessful: 1 }))).toContain("INPUT_DUPLICATE_MATERIAL_ID");
  });

  it("rejects a material above the code point limit without truncating it", () => {
    const materials = [{ id: "m1", title: "t", text: "字".repeat(8001) }];
    const result = normalizeInput(input({ materials, minSuccessful: 1 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain("INPUT_LIMIT_EXCEEDED");
    expect(result.diagnostics[0]?.message).toContain("8001");
  });

  it("rejects a total above the combined code point limit", () => {
    const materials = [1, 2, 3, 4].map((index) => ({ id: `m${index}`, title: `t${index}`, text: "字".repeat(7000) }));
    expect(codesOf(input({ materials, minSuccessful: 1 }))).toContain("INPUT_LIMIT_EXCEEDED");
  });

  it("rejects duplicate and empty dimensions", () => {
    expect(codesOf(input({ dimensions: ["成本", "成本"] }))).toContain("INPUT_DIMENSION_INVALID");
    expect(codesOf(input({ dimensions: ["成本", "  "] }))).toContain("INPUT_DIMENSION_INVALID");
  });

  it("rejects more than six dimensions", () => {
    expect(codesOf(input({ dimensions: ["a", "b", "c", "d", "e", "f", "g"] }))).toContain("INPUT_LIMIT_EXCEEDED");
  });

  it("rejects an unknown material field", () => {
    const materials = [{ id: "m1", title: "t", text: "x", html: "<b>x</b>" }];
    expect(codesOf(input({ materials, minSuccessful: 1 }))).toContain("INPUT_INVALID");
  });

  it("rejects an empty material text", () => {
    const materials = [{ id: "m1", title: "t", text: "\n\n  \n" }];
    expect(codesOf(input({ materials, minSuccessful: 1 }))).toContain("INPUT_INVALID");
  });
});
