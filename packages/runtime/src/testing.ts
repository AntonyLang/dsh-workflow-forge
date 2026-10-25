/**
 * Offline mock engine.
 *
 * It executes the *emitted script* with mock `agent`/`parallel` helpers, so tests
 * and the demo exercise the real compiled control flow, the real helper prelude
 * and the real wrapper. It is explicitly not a model: records created through it
 * are marked `engineKind: "mock"` and can never claim `runtime_verified`.
 */
import type { AgentOptions, ProgressEventName, WorkflowEngine, WorkflowStartRequest, WorkflowRun } from "./engine.js";
import type { JsonValue } from "@workflow-forge/spec";

const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

export type MockCallContext = {
  prompt: string;
  options: AgentOptions;
  args: JsonValue;
  callIndex: number;
  label?: string;
};

export type MockResponder = (context: MockCallContext) => JsonValue | null;

export type MockEngineOptions = {
  /** A responder per agent label, or one responder for every call. */
  responder?: MockResponder | Record<string, MockResponder>;
  /** Delay before each agent settles; used to exercise cancellation races. */
  delayMs?: number | ((context: MockCallContext) => number);
  /** Emit workflow/* observation events (start fires synchronously in start()). */
  emitEvents?: boolean;
  /** Make dispose reject, to exercise cleanup failure handling. */
  failDispose?: boolean;
};

export type MockEngine = {
  engine: WorkflowEngine;
  calls: MockCallContext[];
  runIds: string[];
  emitted: Array<{ type: ProgressEventName; payload: JsonValue }>;
  disposed: string[];
  activeHandles: number;
};

class EngineCancelled extends Error {
  constructor() {
    super("__WF_ENGINE_CANCELLED__");
    this.name = "EngineCancelled";
  }
}

export function createMockEngine(options: MockEngineOptions = {}): MockEngine {
  const calls: MockCallContext[] = [];
  const runIds: string[] = [];
  const emitted: Array<{ type: ProgressEventName; payload: JsonValue }> = [];
  const disposed: string[] = [];
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  let sequence = 0;
  let activeHandles = 0;

  const emit = (type: ProgressEventName, payload: JsonValue): void => {
    if (!options.emitEvents) return;
    emitted.push({ type, payload });
    for (const handler of handlers.get(type) ?? []) {
      try {
        handler(payload);
      } catch {
        // Observers must not break the engine.
      }
    }
  };

  const engine: WorkflowEngine = {
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => {
        set.delete(handler);
      };
    },
    start(request: WorkflowStartRequest): WorkflowRun {
      sequence += 1;
      const runId = `mock-run-${sequence}`;
      runIds.push(runId);
      activeHandles += 1;
      emit("workflow/start", { runId });
      const started = executeScript(request, runId);
      return {
        id: runId,
        result: started,
        async dispose() {
          try {
            await started.catch(() => undefined);
            if (options.failDispose) throw new Error("mock dispose failure");
          } finally {
            activeHandles -= 1;
            disposed.push(runId);
            emit("workflow/end", { runId });
          }
        },
      };
    },
  };

  async function executeScript(request: WorkflowStartRequest, runId: string): Promise<{ stopReason: "completed" | "cancelled" | "error"; value?: JsonValue; error?: string }> {
    const signal = request.signal;
    let cancelled = signal.aborted;
    const onAbort = (): void => {
      cancelled = true;
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const pick = (context: MockCallContext): JsonValue | null => {
      const responder = options.responder;
      if (typeof responder === "function") return responder(context);
      if (responder && context.label && responder[context.label]) return responder[context.label]!(context);
      return defaultResponder(context);
    };

    const delayFor = (context: MockCallContext): number =>
      typeof options.delayMs === "function" ? options.delayMs(context) : (options.delayMs ?? 0);

    const agent = async (prompt: unknown, rawOptions?: unknown): Promise<JsonValue | null> => {
      if (cancelled) throw new EngineCancelled();
      const agentOptions = (rawOptions ?? {}) as AgentOptions;
      const context: MockCallContext = {
        prompt: String(prompt),
        options: agentOptions,
        args: request.args,
        callIndex: calls.length,
        ...(agentOptions.label !== undefined ? { label: agentOptions.label } : {}),
      };
      calls.push(context);
      emit("workflow/agent-start", { runId, label: agentOptions.label ?? null, index: context.callIndex });
      const delay = delayFor(context);
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
      if (cancelled) throw new EngineCancelled();
      const value = pick(context);
      emit("workflow/agent-end", { runId, label: agentOptions.label ?? null, index: context.callIndex });
      return value;
    };

    const parallel = async (thunks: unknown): Promise<unknown[]> => {
      const list = Array.isArray(thunks) ? (thunks as Array<() => Promise<unknown>>) : [];
      return Promise.all(
        list.map((thunk) =>
          Promise.resolve()
            .then(() => thunk())
            .catch((error) => {
              if (error instanceof EngineCancelled) throw error;
              return null;
            }),
        ),
      );
    };

    try {
      const fn = new AsyncFunctionCtor("agent", "parallel", "log", "phase", "args", request.script);
      const value = (await fn(
        agent,
        parallel,
        () => {},
        (title: unknown) => emit("workflow/phase", { runId, title: String(title) }),
        request.args,
      )) as JsonValue;
      signal.removeEventListener("abort", onAbort);
      return { stopReason: "completed", value };
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      if (error instanceof EngineCancelled || cancelled) return { stopReason: "cancelled" };
      return { stopReason: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    engine,
    calls,
    runIds,
    emitted,
    disposed,
    get activeHandles() {
      return activeHandles;
    },
  };
}

/**
 * Schema-driven default responder: facts from the first paragraph of the labelled
 * material, a brief from the requested dimensions and the deterministic evidence
 * ids. This is a fixture generator, not a model.
 */
export function defaultResponder(context: MockCallContext): JsonValue | null {
  return sampleFromSchemaForAgent(context.options.schema, context.args, context.label);
}

function sampleFromSchemaForAgent(schema: unknown, args: JsonValue, label?: string): JsonValue {
  if (!schema || typeof schema !== "object") return null;
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  const material = findMaterial(args, label);
  if ("facts" in properties && material) {
    const paragraphs = Array.isArray(material["paragraphs"]) ? (material["paragraphs"] as JsonValue[]) : [];
    const paragraph = paragraphs[0];
    if (paragraph && typeof paragraph === "object" && !Array.isArray(paragraph)) {
      const record = paragraph as Record<string, JsonValue>;
      const text = typeof record["text"] === "string" ? record["text"] : "";
      const paragraphId = typeof record["paragraphId"] === "string" ? record["paragraphId"] : "p1";
      if (text.length > 0) {
        return {
          facts: [
            {
              paragraphId,
              quote: text.slice(0, Math.min(40, text.length)),
              statement: `材料 ${String(material["id"] ?? label ?? "m")} 的第一条事实。`,
            },
          ],
        };
      }
    }
  }
  if ("dimensions" in properties && "conclusions" in properties) {
    const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, JsonValue>) : {};
    const materials = Array.isArray(record["materials"]) ? (record["materials"] as JsonValue[]) : [];
    const ids = materials.map((entry, index) =>
      entry && typeof entry === "object" ? String((entry as Record<string, JsonValue>)["id"] ?? `m${index}`) : `m${index}`,
    );
    const dimensions = Array.isArray(record["dimensions"]) ? (record["dimensions"] as JsonValue[]).map(String) : ["概述"];
    const cite = ids.length > 0 ? [`${ids[0]}:1`] : [];
    return {
      title: "资料对比简报",
      dimensions: dimensions.map((dimension) => ({
        dimension,
        findings: [
          {
            kind: "fact",
            text: `${dimension}：材料中的相关表述已归纳为该维度的事实结论。`,
            evidenceIds: cite,
          },
        ],
      })),
      conclusions: [
        {
          kind: "fact",
          text: "各材料在同一组维度下可以对齐比较。",
          evidenceIds: cite,
        },
        {
          kind: "recommendation",
          text: "建议补充更多一手材料后再做最终判断。",
          evidenceIds: cite,
        },
      ],
    };
  }
  return null;
}

function findMaterial(args: JsonValue, label?: string): Record<string, JsonValue> | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const materials = (args as Record<string, JsonValue>)["materials"];
  if (!Array.isArray(materials)) return undefined;
  const candidates = materials.filter(
    (entry): entry is Record<string, JsonValue> => entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  if (label) {
    const match = candidates.find((entry) => entry["id"] === label);
    if (match) return match;
  }
  return candidates[0];
}

export function fakeExec(overrides: Partial<{ agent: unknown; signal: AbortSignal }> = {}): { agent?: unknown; signal: AbortSignal } {
  return {
    agent: overrides.agent ?? { id: "test-parent" },
    signal: overrides.signal ?? new AbortController().signal,
  };
}
