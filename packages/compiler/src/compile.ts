/**
 * Compiler orchestration (the eight documented steps).
 *
 * 1 parse + meta-schema  2 materialize assets  3 defaults -> typed IR
 * 4 symbol tables        5 agent budget        6 emit fixed JS
 * 7 syntax + mock check  8 static report
 */
import {
  DIAGNOSTIC_CODES,
  diagnostic,
  draftIdentity,
  hasErrors,
  parseSpec,
  sha256Hex,
  specHash as computeSpecHash,
  type Diagnostic,
  type JsonSchema,
  type WorkflowSpec,
} from "@workflow-forge/spec";
import { analyzeWorkflow } from "./analyze.js";
import { agentNodes, emitScript } from "./emit.js";
import type { CompiledWorkflow } from "./ir.js";
import { checkScriptSyntax, selfCheckScript } from "./verify.js";

export const COMPILER_VERSION = "0.1.0";

export type MaterializedAsset = {
  kind: "prompt" | "schema";
  key: string;
  fileName: string;
  hash: string;
  content: string;
};

export type StaticReport = {
  reportVersion: "0.1";
  compilerVersion: string;
  workflowId: string;
  version: string;
  specVersion: string;
  specHash: string;
  scriptHash: string;
  worstCaseAgents: number;
  nodeCount: number;
  agents: Array<{ id: string; kind: string; schemaKey: string }>;
  prompts: Array<{ key: string; fileName: string; hash: string }>;
  schemas: Array<{ key: string; fileName: string; hash: string }>;
  selfCheck: "passed" | "failed" | "skipped";
  selfCheckNotes: string[];
  warnings: number;
  errors: number;
  /** Wall-clock generation time is metadata only; it never feeds a hash. */
  generatedAt: string;
};

export type CompileOptions = {
  /** Bind the draft identity to the exact implementation snapshot. */
  runtimeArtifactHash?: string;
  checksHash?: string;
  targetAdapterVersion?: string;
  /** Skip the mock self-check (syntax checking still runs). */
  skipSelfCheck?: boolean;
};

export type CompileSuccess = {
  ok: true;
  workflow: CompiledWorkflow;
  script: string;
  meta: { name: string; phases: string[] };
  assets: MaterializedAsset[];
  staticReport: StaticReport;
  specHash: string;
  scriptHash: string;
  draftHash?: string;
  draftRef?: string;
  diagnostics: Diagnostic[];
};

export type CompileFailure = { ok: false; diagnostics: Diagnostic[] };
export type CompileResult = CompileSuccess | CompileFailure;

export function materializeAssets(spec: WorkflowSpec): MaterializedAsset[] {
  const assets: MaterializedAsset[] = [];
  for (const [key, text] of Object.entries(spec.assets.prompts)) {
    assets.push({
      kind: "prompt",
      key,
      fileName: `${key}.md`,
      hash: sha256Hex(text),
      content: text,
    });
  }
  for (const [key, schema] of Object.entries(spec.assets.schemas)) {
    const content = JSON.stringify(schema, null, 2) + "\n";
    assets.push({
      kind: "schema",
      key,
      fileName: `${key}.json`,
      hash: sha256Hex(content),
      content,
    });
  }
  return assets;
}

/** Compile an already-validated spec. */
export async function compileSpec(spec: WorkflowSpec, options: CompileOptions = {}): Promise<CompileResult> {
  const materialized = materializeAssets(spec);
  const analysis = analyzeWorkflow(spec);
  if (!analysis.ok) return { ok: false, diagnostics: analysis.diagnostics };

  const { workflow } = analysis;
  const specHash = computeSpecHash(spec);
  const emitted = emitScript(workflow, { specHash, compilerVersion: COMPILER_VERSION });
  const scriptHash = sha256Hex(emitted.script);

  const syntax = checkScriptSyntax(emitted.script);
  if (!syntax.ok) {
    return {
      ok: false,
      diagnostics: [
        diagnostic({
          code: DIAGNOSTIC_CODES.SCRIPT_SYNTAX_ERROR,
          fieldPath: "script",
          message: `generated script does not parse: ${syntax.message}`,
          fix: "this is a compiler defect; report the spec with the generated script",
        }),
      ],
    };
  }

  let selfCheck: StaticReport["selfCheck"] = "skipped";
  let notes: string[] = [];
  const diagnostics: Diagnostic[] = [...analysis.diagnostics];

  if (!options.skipSelfCheck) {
    const report = await selfCheckScript(workflow, emitted.script);
    notes = report.notes;
    diagnostics.push(...report.diagnostics);
    selfCheck = report.ok ? "passed" : "failed";
  }

  const nodeCount = countNodes(workflow);
  const staticReport: StaticReport = {
    reportVersion: "0.1",
    compilerVersion: COMPILER_VERSION,
    workflowId: spec.workflowId,
    version: spec.version,
    specVersion: spec.specVersion,
    specHash,
    scriptHash,
    worstCaseAgents: workflow.worstCaseAgents,
    nodeCount,
    agents: agentNodes(workflow),
    prompts: materialized.filter((asset) => asset.kind === "prompt").map(({ key, fileName, hash }) => ({ key, fileName, hash })),
    schemas: materialized.filter((asset) => asset.kind === "schema").map(({ key, fileName, hash }) => ({ key, fileName, hash })),
    selfCheck,
    selfCheckNotes: notes,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    generatedAt: new Date().toISOString(),
  };

  if (hasErrors(diagnostics)) return { ok: false, diagnostics };

  const result: CompileSuccess = {
    ok: true,
    workflow,
    script: emitted.script,
    meta: emitted.meta,
    assets: materialized,
    staticReport,
    specHash,
    scriptHash,
    diagnostics,
  };

  if (options.runtimeArtifactHash && options.checksHash && options.targetAdapterVersion) {
    const draftHash = draftIdentity({
      specHash,
      compilerVersion: COMPILER_VERSION,
      runtimeArtifactHash: options.runtimeArtifactHash,
      checksHash: options.checksHash,
      targetAdapterVersion: options.targetAdapterVersion,
    });
    result.draftHash = draftHash;
    result.draftRef = draftHash;
  }

  return result;
}

/** Parse then compile raw JSON. */
export async function compile(rawSpec: unknown, options: CompileOptions = {}): Promise<CompileResult> {
  const parsed = parseSpec(rawSpec);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  return compileSpec(parsed.spec, options);
}

function countNodes(workflow: CompiledWorkflow): number {
  let count = 0;
  const visit = (steps: CompiledWorkflow["steps"]): void => {
    for (const step of steps) {
      count += 1;
      if (step.kind === "branch") {
        visit(step.then);
        visit(step.else);
      }
    }
  };
  visit(workflow.steps);
  return count;
}

export type PromptAsset = { key: string; text: string };
export type SchemaAsset = { key: string; schema: JsonSchema };
