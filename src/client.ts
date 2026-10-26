import { z } from "zod";
import {
  eventSchema, projectSchema, runListSchema, runSchema, taskListSchema, taskSchema,
  type CreateProgram, type RunAction, type RunEvent, type WorkflowRun,
} from "./contracts.js";

export interface RequestOptions {
  method?: string;
  body?: unknown;
  revision?: number;
  signal?: AbortSignal;
}
export interface ClientOptions {
  /** Origin plus an optional reverse-proxy prefix; empty uses the current origin. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
}
export class WorkflowApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "WorkflowApiError"; }
}

/** Shared by browsers, terminal clients, and native shells with a Fetch implementation. */
export class WorkflowClient {
  private readonly base: string;
  constructor(private readonly options: ClientOptions = {}) {
    this.base = (options.baseUrl ?? "").replace(/\/+$/, "");
  }
  url(route: string) {
    if (!route.startsWith("/api/")) throw new Error("Expected a Workflow API route");
    return `${this.base}${route}`;
  }
  private headers(options: RequestOptions = {}) {
    const headers = new Headers(this.options.headers);
    headers.set("x-workflow-client", "1");
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.revision !== undefined) headers.set("if-match", `"${options.revision}"`);
    return headers;
  }
  async request<T>(route: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    const response = await (this.options.fetch ?? globalThis.fetch)(this.url(route), {
      method: options.method ?? "GET", signal: options.signal, headers: this.headers(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data: unknown = await response.json().catch(() => {
      throw new WorkflowApiError(response.ok ? "The server returned an invalid response. Refresh and try again."
        : `Request failed (${response.status}). Check that Workflow is running and try again.`, response.status);
    });
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(data);
      throw new WorkflowApiError(error.success ? error.data.error : `Request failed (${response.status})`, response.status);
    }
    return schema.parse(data);
  }
  project(signal?: AbortSignal) { return this.request("/api/project", projectSchema, { signal }); }
  runs(signal?: AbortSignal) { return this.request("/api/runs", runListSchema, { signal }); }
  run(id: string, signal?: AbortSignal) { return this.request(`/api/runs/${encodeURIComponent(id)}`, runSchema, { signal }); }
  events(id: string, signal?: AbortSignal) { return this.request(`/api/runs/${encodeURIComponent(id)}/events`, z.array(eventSchema), { signal }); }
  createProgram(body: CreateProgram, signal?: AbortSignal) { return this.request("/api/programs", runSchema, { method: "POST", body, signal }); }
  action(id: string, action: RunAction, revision?: number, signal?: AbortSignal) {
    return this.request(`/api/runs/${encodeURIComponent(id)}/${action}`, runSchema, { method: "POST", body: {}, revision, signal });
  }
  tasks(signal?: AbortSignal) { return this.request("/api/tasks", taskListSchema, { signal }); }
  task(id: string, signal?: AbortSignal) { return this.request(`/api/tasks/${encodeURIComponent(id)}`, taskSchema, { signal }); }
  createTask(prompt: string, signal?: AbortSignal) { return this.request("/api/tasks", taskSchema, { method: "POST", body: { prompt }, signal }); }
  answerTask(id: string, answer: string, revision: number, signal?: AbortSignal) {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/answer`, taskSchema, { method: "POST", body: { answer, revision }, signal });
  }

  /** One SSE connection. Events are hints; reload persisted state after reconnecting. */
  async *stream(signal?: AbortSignal, onOpen?: () => void): AsyncGenerator<RunEvent> {
    const response = await (this.options.fetch ?? globalThis.fetch)(this.url("/api/stream"), { headers: this.headers(), signal });
    if (!response.ok || !response.body) throw new WorkflowApiError(`Event stream failed (${response.status})`, response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      onOpen?.();
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (!data) continue;
          const parsed = eventSchema.safeParse(JSON.parse(data));
          if (parsed.success) yield parsed.data;
        }
        if (buffer.length > 2_000_000) throw new Error("Event stream frame is too large");
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  subscribe(onEvent: (event: RunEvent) => void, options: {
    signal?: AbortSignal; onOpen?: () => void; onError?: (error: unknown) => void;
  } = {}) {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const done = (async () => {
      while (!signal.aborted) {
        try {
          for await (const event of this.stream(signal, options.onOpen)) {
            if (signal.aborted) return;
            onEvent(event);
          }
          if (!signal.aborted) options.onError?.(new Error("Event stream disconnected"));
        } catch (error) { if (!signal.aborted) options.onError?.(error); }
        await wait(1000, signal).catch(() => {});
      }
    })();
    return { close: () => controller.abort(), done };
  }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Works with either app.getRun or client.run. Stops when execution needs human input. */
export async function waitForRun(getRun: () => WorkflowRun | Promise<WorkflowRun>, options: {
  signal?: AbortSignal; onUpdate?: (run: WorkflowRun) => void; intervalMs?: number;
} = {}): Promise<WorkflowRun> {
  let revision = -1;
  while (true) {
    options.signal?.throwIfAborted();
    const run = await getRun();
    if (run.revision !== revision) { revision = run.revision; options.onUpdate?.(run); }
    if (!["running", "pausing"].includes(run.status)) return run;
    await wait(options.intervalMs ?? 300, options.signal);
  }
}
