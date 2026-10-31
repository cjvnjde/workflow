import { z } from "zod";
import {
  eventSchema,
  projectSchema,
  runListSchema,
  runSchema,
  taskListSchema,
  taskSchema,
  usageReportSchema,
  commandOutputPageSchema,
  historyPageSchema,
  executionSnapshotSchema,
  reportEvidenceSchema,
  operationEventsSchema,
  type HistoryQuery,
  setupJobSchema,
  setupJobsLatestSchema,
  type StartSetup,
  attemptEvidenceSchema,
  memoryStateSchema,
  memoryEntrySchema,
  memoryMutationSchema,
  type CreateMemoryEntry,
  type UpdateMemoryEntry,
  strategyPreviewSchema,
  rememberStrategyResultSchema,
  type RememberStrategy,
  triggerStateSchema,
  triggerSchema,
  triggerJobSchema,
  type TriggerConfig,
  type CreateProgram,
  type RunAction,
  type RunEvent,
  type WorkflowRun,
} from "../contracts/index.js";
import { setupSchema } from "../contracts/setup-schema.js";

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
export type SessionReference = { kind: "task" | "run"; id: string };
export class WorkflowApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WorkflowApiError";
  }
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
  /** A shareable browser URL for the same persisted task/run used by all clients. */
  sessionUrl(session?: SessionReference) {
    return `${this.base}/${session ? `?${session.kind}=${encodeURIComponent(session.id)}` : ""}`;
  }
  async resolveSession(reference: string, signal?: AbortSignal): Promise<SessionReference> {
    const match = /^(?:(task|run):)?([\da-f-]+)$/i.exec(reference.trim());
    if (!match || !z.string().uuid().safeParse(match[2]).success)
      throw new Error("Use a full task or run ID, optionally prefixed with task: or run:.");
    const id = match[2]!.toLowerCase();
    const kind = match[1]?.toLowerCase();
    const [tasks, runs] = await Promise.all([
      kind === "run" ? [] : this.tasks(signal),
      kind === "task" ? [] : this.runs(signal),
    ]);
    if (tasks.some((task) => task.id === id && !task.deletedAt)) return { kind: "task", id };
    if (runs.some((run) => run.id === id && !run.deletedAt)) return { kind: "run", id };
    throw new Error(
      `Session ${id} was not found in this project. Use /sessions to see available sessions.`,
    );
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
      method: options.method ?? "GET",
      signal: options.signal,
      headers: this.headers(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data: unknown = await response.json().catch(() => {
      throw new WorkflowApiError(
        response.ok
          ? "The server returned an invalid response. Refresh and try again."
          : `Request failed (${response.status}). Check that Workflow is running and try again.`,
        response.status,
      );
    });
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(data);
      throw new WorkflowApiError(
        error.success ? error.data.error : `Request failed (${response.status})`,
        response.status,
      );
    }
    return schema.parse(data);
  }
  project(signal?: AbortSignal) {
    return this.request("/api/project", projectSchema, { signal });
  }
  usage(signal?: AbortSignal) {
    return this.request("/api/usage", usageReportSchema, { signal });
  }
  memory(signal?: AbortSignal) {
    return this.request("/api/memory", memoryStateSchema, { signal });
  }
  strategyPreview(id: string, signal?: AbortSignal) {
    return this.request(
      "/api/runs/" + encodeURIComponent(id) + "/strategy-preview",
      strategyPreviewSchema,
      { signal },
    );
  }
  rememberStrategy(id: string, body: RememberStrategy, signal?: AbortSignal) {
    return this.request(
      "/api/runs/" + encodeURIComponent(id) + "/remember",
      rememberStrategyResultSchema,
      { method: "POST", body, signal },
    );
  }
  setMemoryEnabled(enabled: boolean, revision: string, signal?: AbortSignal) {
    return this.request("/api/memory", memoryStateSchema, {
      method: "PUT",
      body: { enabled, revision },
      signal,
    });
  }
  memoryEntry(id: string, signal?: AbortSignal) {
    return this.request(`/api/memory/entries/${encodeURIComponent(id)}`, memoryEntrySchema, {
      signal,
    });
  }
  createMemoryEntry(body: CreateMemoryEntry, signal?: AbortSignal) {
    return this.request("/api/memory/entries", memoryMutationSchema, {
      method: "POST",
      body,
      signal,
    });
  }
  updateMemoryEntry(id: string, body: UpdateMemoryEntry, signal?: AbortSignal) {
    return this.request(`/api/memory/entries/${encodeURIComponent(id)}`, memoryMutationSchema, {
      method: "PATCH",
      body,
      signal,
    });
  }
  deleteMemoryEntry(id: string, revision: string, signal?: AbortSignal) {
    return this.request(`/api/memory/entries/${encodeURIComponent(id)}`, memoryStateSchema, {
      method: "DELETE",
      body: { revision },
      signal,
    });
  }
  taskUsage(id: string, signal?: AbortSignal) {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/usage`, usageReportSchema, {
      signal,
    });
  }
  runUsage(id: string, signal?: AbortSignal) {
    return this.request(`/api/runs/${encodeURIComponent(id)}/usage`, usageReportSchema, { signal });
  }
  setupState(signal?: AbortSignal) {
    return this.request("/api/setup", setupSchema, { signal });
  }
  startSetup(body: StartSetup = {}, signal?: AbortSignal) {
    return this.request("/api/setup-jobs", setupJobSchema, { method: "POST", body, signal });
  }
  latestSetup(signal?: AbortSignal) {
    return this.request("/api/setup-jobs/latest", setupJobsLatestSchema, { signal });
  }
  setupJob(id: string, signal?: AbortSignal) {
    return this.request(`/api/setup-jobs/${encodeURIComponent(id)}`, setupJobSchema, { signal });
  }
  resumeSetup(id: string, revision: number, signal?: AbortSignal, maxSetupCostUsd?: number) {
    return this.request(`/api/setup-jobs/${encodeURIComponent(id)}/resume`, setupJobSchema, {
      method: "POST",
      body: { revision, maxSetupCostUsd },
      signal,
    });
  }
  cancelSetup(id: string, revision: number, signal?: AbortSignal) {
    return this.request(`/api/setup-jobs/${encodeURIComponent(id)}/cancel`, setupJobSchema, {
      method: "POST",
      body: { revision },
      signal,
    });
  }
  setupUsage(id: string, signal?: AbortSignal) {
    return this.request(`/api/setup-jobs/${encodeURIComponent(id)}/usage`, usageReportSchema, {
      signal,
    });
  }
  runs(signal?: AbortSignal) {
    return this.request("/api/runs", runListSchema, { signal });
  }
  run(id: string, signal?: AbortSignal) {
    return this.request(`/api/runs/${encodeURIComponent(id)}`, runSchema, { signal });
  }
  events(id: string, signal?: AbortSignal) {
    return this.request(`/api/runs/${encodeURIComponent(id)}/events`, z.array(eventSchema), {
      signal,
    });
  }
  history(id: string, query: HistoryQuery = {}, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    return this.request(
      `/api/runs/${encodeURIComponent(id)}/history?${params}`,
      historyPageSchema,
      { signal },
    );
  }
  execution(id: string, signal?: AbortSignal) {
    return this.request(`/api/runs/${encodeURIComponent(id)}/execution`, executionSnapshotSchema, {
      signal,
    });
  }
  reportEvidence(id: string, signal?: AbortSignal) {
    return this.request(
      `/api/runs/${encodeURIComponent(id)}/report-evidence`,
      reportEvidenceSchema,
      { signal },
    );
  }
  operationEvents(id: string, key: string, signal?: AbortSignal) {
    return this.request(
      `/api/runs/${encodeURIComponent(id)}/operation-events?key=${encodeURIComponent(key)}`,
      operationEventsSchema,
      { signal },
    );
  }
  commandOutputUrl(
    runId: string,
    nodeId: string,
    visit: number,
    captureId: string,
    stream: "stdout" | "stderr" | "output" = "output",
    download = false,
  ) {
    return this.url(
      `/api/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(nodeId)}/${visit}/outputs/${encodeURIComponent(captureId)}/${stream}${download ? "?download=1" : ""}`,
    );
  }
  commandOutput(
    runId: string,
    nodeId: string,
    visit: number,
    captureId: string,
    stream: "stdout" | "stderr" | "output" = "output",
    query: { offset?: number; limit?: number } = {},
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    return this.request(
      `/api/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(nodeId)}/${visit}/outputs/${encodeURIComponent(captureId)}/${stream}?${params}`,
      commandOutputPageSchema,
      { signal },
    );
  }
  attemptEvidence(runId: string, nodeId: string, visit: number, signal?: AbortSignal) {
    return this.request(
      `/api/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(nodeId)}/${visit}/evidence`,
      attemptEvidenceSchema,
      { signal },
    );
  }
  evidenceContentUrl(
    runId: string,
    nodeId: string,
    visit: number,
    contentId: string,
    download = false,
  ) {
    return this.url(
      `/api/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(nodeId)}/${visit}/content/${encodeURIComponent(contentId)}${download ? "?download=1" : ""}`,
    );
  }
  async evidenceContent(
    runId: string,
    nodeId: string,
    visit: number,
    contentId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await (this.options.fetch ?? globalThis.fetch)(
      this.evidenceContentUrl(runId, nodeId, visit, contentId),
      { signal, headers: this.headers() },
    );
    if (!response.ok) {
      const error = (await response.json().catch(() => undefined)) as
        { error?: string } | undefined;
      throw new WorkflowApiError(
        error?.error ?? `Evidence request failed (${response.status})`,
        response.status,
      );
    }
    return response.text();
  }
  createProgram(body: CreateProgram, signal?: AbortSignal) {
    return this.request("/api/programs", runSchema, { method: "POST", body, signal });
  }
  action(id: string, action: RunAction, revision?: number, signal?: AbortSignal) {
    return this.request(`/api/runs/${encodeURIComponent(id)}/${action}`, runSchema, {
      method: "POST",
      body: {},
      revision,
      signal,
    });
  }
  tasks(signal?: AbortSignal) {
    return this.request("/api/tasks", taskListSchema, { signal });
  }
  triggers(signal?: AbortSignal) {
    return this.request("/api/triggers", triggerStateSchema, { signal });
  }
  saveTrigger(config: TriggerConfig, id?: string, revision?: number) {
    return this.request("/api/triggers", triggerSchema, {
      method: "POST",
      body: { config, id, revision },
    });
  }
  testTrigger(id: string, number: number) {
    return this.request(`/api/triggers/${encodeURIComponent(id)}/test`, triggerJobSchema, {
      method: "POST",
      body: { number },
    });
  }
  pollTriggers() {
    return this.request("/api/triggers/poll", triggerStateSchema, { method: "POST", body: {} });
  }
  triggerEventAction(id: string, action: "retry" | "cancel") {
    return this.request(
      `/api/trigger-events/${encodeURIComponent(id)}/${action}`,
      triggerJobSchema,
      { method: "POST", body: {} },
    );
  }
  task(id: string, signal?: AbortSignal) {
    return this.request(`/api/tasks/${encodeURIComponent(id)}`, taskSchema, { signal });
  }
  createTask(prompt: string, signal?: AbortSignal, maxTaskCostUsd?: number) {
    return this.request("/api/tasks", taskSchema, {
      method: "POST",
      body: { prompt, maxTaskCostUsd },
      signal,
    });
  }
  answerTask(id: string, answer: string, revision: number, signal?: AbortSignal) {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/answer`, taskSchema, {
      method: "POST",
      body: { answer, revision },
      signal,
    });
  }

  /** One SSE connection. Events are hints; reload persisted state after reconnecting. */
  async *stream(signal?: AbortSignal, onOpen?: () => void): AsyncGenerator<RunEvent> {
    const response = await (this.options.fetch ?? globalThis.fetch)(this.url("/api/stream"), {
      headers: this.headers(),
      signal,
    });
    if (!response.ok || !response.body)
      throw new WorkflowApiError(`Event stream failed (${response.status})`, response.status);
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
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
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

  subscribe(
    onEvent: (event: RunEvent) => void,
    options: {
      signal?: AbortSignal;
      onOpen?: () => void;
      onError?: (error: unknown) => void;
    } = {},
  ) {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const done = (async () => {
      while (!signal.aborted) {
        try {
          for await (const event of this.stream(signal, options.onOpen)) {
            if (signal.aborted) return;
            onEvent(event);
          }
          if (!signal.aborted) options.onError?.(new Error("Event stream disconnected"));
        } catch (error) {
          if (!signal.aborted) options.onError?.(error);
        }
        await wait(1000, signal).catch(() => {});
      }
    })();
    return { close: () => controller.abort(), done };
  }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Works with either app.getRun or client.run. Stops when execution needs human input. */
export async function waitForRun(
  getRun: () => WorkflowRun | Promise<WorkflowRun>,
  options: {
    signal?: AbortSignal;
    onUpdate?: (run: WorkflowRun) => void;
    intervalMs?: number;
  } = {},
): Promise<WorkflowRun> {
  let revision = -1;
  while (true) {
    options.signal?.throwIfAborted();
    const run = await getRun();
    if (run.revision !== revision) {
      revision = run.revision;
      options.onUpdate?.(run);
    }
    if (!["running", "pausing"].includes(run.status)) return run;
    await wait(options.intervalMs ?? 300, options.signal);
  }
}
