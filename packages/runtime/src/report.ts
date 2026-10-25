/**
 * Fixed Markdown report template.
 *
 * The template belongs to the project; user material only enters as collapsed,
 * single-line data. That keeps a material title or a quote from forging a
 * heading, a list item or a code fence in the rendered report.
 */
import { collapseWhitespace, type Material, type ScenarioResult } from "@workflow-forge/checks";

export type ReportContext = {
  runId: string;
  workflowId: string;
  workflowVersion: string;
  topic: string;
  language: string;
  dimensions: string[];
  materials: Material[];
  generatedAt: string;
};

/**
 * Collapse to one line and neutralize backticks, so user text can neither break
 * the layout nor open a code fence. This applies to every interpolated value,
 * including body text and quotes.
 */
function line(value: unknown): string {
  return collapseWhitespace(String(value ?? "")).replace(/`/g, "'");
}

function code(value: unknown): string {
  return `\`${line(value)}\``;
}

function findingLine(kind: string, text: string, evidenceIds: readonly string[]): string {
  const label = kind === "recommendation" ? "建议" : "事实";
  const citations = evidenceIds.length > 0 ? `（证据：${evidenceIds.map((id) => line(id)).join("、")}）` : "";
  return `- **${label}**：${line(text)}${citations}`;
}

export function renderReport(result: ScenarioResult, ctx: ReportContext): string {
  const out: string[] = [];
  const titles = new Map(ctx.materials.map((material) => [material.id, material.title]));

  if (result.status === "completed" && result.brief) {
    const brief = result.brief;
    out.push(`# ${line(brief.title)}`);
    out.push("");
    out.push(
      `> 主题：${line(ctx.topic)} ｜ 场景：${line(ctx.workflowId)}@${line(ctx.workflowVersion)} ｜ 语言：${line(ctx.language)} ｜ 运行：${code(ctx.runId)}`,
    );
    out.push(`> 比较维度：${ctx.dimensions.map((dimension) => line(dimension)).join("、") || "（未指定）"}`);
    out.push("");
    out.push("## 结论");
    for (const conclusion of brief.conclusions) {
      out.push(findingLine(conclusion.kind, conclusion.text, conclusion.evidenceIds));
    }
    out.push("");
    out.push("## 逐维度比较");
    for (const [index, dimension] of brief.dimensions.entries()) {
      out.push("");
      out.push(`### ${index + 1}. ${line(dimension.dimension)}`);
      for (const finding of dimension.findings) {
        out.push(findingLine(finding.kind, finding.text, finding.evidenceIds));
      }
    }
    out.push("");
    out.push("## 来源片段");
    if (result.evidence.evidence.length === 0) {
      out.push("- （本次没有可用证据）");
    } else {
      for (const item of result.evidence.evidence) {
        out.push(
          `- ${code(item.evidenceId)} ${line(titles.get(item.materialId) ?? item.materialId)} · ${code(item.paragraphId)}：${code(item.quote)}`,
        );
      }
    }
    out.push("");
    out.push("## 未覆盖材料");
    if (result.failedMaterials.length === 0) {
      out.push("- 无：所有材料均通过了抽取与引用检查。");
    } else {
      for (const failure of result.failedMaterials) {
        const detail = failure.detail ? `：${line(failure.detail)}` : "";
        out.push(`- ${code(failure.materialId)} ${line(titles.get(failure.materialId) ?? "")} (${line(failure.code)})${detail}`);
      }
    }
    out.push("");
    out.push("## 检查记录");
    for (const check of result.checks) {
      out.push(`- ${line(check.rule)}：${check.ok ? "通过" : `未通过${check.detail ? `（${line(check.detail)}）` : ""}`}`);
    }
    out.push("");
    out.push(
      `> 结构与引用检查通过并不等于事实准确。本报告由固定模板渲染，生成时间 ${line(ctx.generatedAt)}。`,
    );
    return out.join("\n") + "\n";
  }

  out.push("# 未生成报告：可用材料不足");
  out.push("");
  out.push(`> 主题：${line(ctx.topic)} ｜ 场景：${line(ctx.workflowId)}@${line(ctx.workflowVersion)} ｜ 运行：${code(ctx.runId)}`);
  out.push("");
  out.push(
    `本次通过引用检查的材料为 ${result.evidence.successCount} 份，低于要求的数量，因此没有调用汇总步骤，也没有生成结构化报告。`,
  );
  out.push("");
  out.push("## 缺失与失败材料");
  if (result.failedMaterials.length === 0) {
    out.push("- （没有失败材料，但成功数量仍不足）");
  } else {
    for (const failure of result.failedMaterials) {
      const detail = failure.detail ? `：${line(failure.detail)}` : "";
      out.push(`- ${code(failure.materialId)} ${line(titles.get(failure.materialId) ?? "")} (${line(failure.code)})${detail}`);
    }
  }
  out.push("");
  out.push("## 下一步");
  out.push("- 补充材料或修正引用后重新发起一次运行；每次重新运行都会生成新的 runId，不会沿用旧结果。");
  out.push("");
  return out.join("\n") + "\n";
}
