/**
 * Progress observation.
 *
 * Workflow events are snapshots for display only: they can never advance the
 * business state, and `workflow/end` does not carry the final value. Events that
 * arrive before the engine run id is known are buffered briefly and then matched,
 * because `workflow/start` fires synchronously inside `engine.start`.
 */
import type { JsonValue } from "@workflow-forge/spec";
import { PROGRESS_EVENTS, type ProgressEvent, type WorkflowEngine } from "./engine.js";

export type ProgressSink = (event: ProgressEvent) => void;

export type ProgressBridge = {
  bind(engineRunId: string): void;
  detach(): void;
  buffered: number;
  events: ProgressEvent[];
};

const MAX_BUFFER = 32;

export function attachProgress(engine: WorkflowEngine, sink: ProgressSink, now: () => Date = () => new Date()): ProgressBridge {
  const bufferedAll: ProgressEvent[] = [];
  const recorded: ProgressEvent[] = [];
  let engineRunId: string | null = null;
  let detached = false;
  const detachers: Array<() => void> = [];

  const deliver = (event: ProgressEvent): void => {
    recorded.push(event);
    try {
      sink(event);
    } catch {
      // A display sink must never break the run.
    }
  };

  const handle = (type: string): ((payload: unknown) => void) => (payload: unknown) => {
    if (detached) return;
    const event: ProgressEvent = {
      type: type as ProgressEvent["type"],
      payload: (payload ?? null) as JsonValue,
      at: now().toISOString(),
    };
    if (engineRunId === null) {
      if (bufferedAll.length < MAX_BUFFER) bufferedAll.push(event);
      return;
    }
    const payloadRunId = extractRunId(event.payload);
    if (payloadRunId !== null && payloadRunId !== engineRunId) return;
    deliver({ ...event, engineRunId });
  };

  if (engine.on) {
    for (const type of PROGRESS_EVENTS) {
      try {
        const detach = engine.on(type, handle(type));
        if (typeof detach === "function") detachers.push(detach);
      } catch {
        // An engine without this event surface simply provides no progress.
      }
    }
  }

  return {
    bind(runId: string) {
      if (engineRunId !== null) return;
      engineRunId = runId;
      for (const event of bufferedAll.splice(0)) {
        const payloadRunId = extractRunId(event.payload);
        if (payloadRunId !== null && payloadRunId !== runId) continue;
        deliver({ ...event, engineRunId });
      }
    },
    detach() {
      if (detached) return;
      detached = true;
      bufferedAll.length = 0;
      for (const detach of detachers.splice(0)) {
        try {
          detach();
        } catch {
          // Removing a listener must not throw during cleanup.
        }
      }
    },
    get buffered() {
      return bufferedAll.length;
    },
    get events() {
      return recorded;
    },
  };
}

function extractRunId(payload: JsonValue): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, JsonValue>;
  for (const key of ["runId", "engineRunId", "id"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}
