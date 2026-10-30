import type { OperationRecord } from "../../contracts/operation-schema.js";

/** Client-observed provider invocations. No content or hidden reasoning is retained here. */
export class SessionTiming {
  private sequence = 0;
  private active?: { id: string; name: string; start: number; first?: number; last?: number };
  private waits = new Map<string, { id: string; start: number }>();
  constructor(
    private readonly parentId: string,
    private readonly sessionId: string,
    private readonly record: (record: OperationRecord) => void,
    private readonly clock = () => performance.now(),
  ) {}
  start(provider: string, model: string) {
    this.finish("interrupted");
    const id = `${this.parentId}/request-${this.sessionId}-${++this.sequence}`;
    this.active = { id, name: `${provider}/${model}`, start: this.clock() };
    this.record({
      id,
      parentId: this.parentId,
      sessionId: this.sessionId,
      name: `${provider}/${model}`,
      kind: "request",
      state: "started",
      details: { timingSource: "client-observed provider invocation" },
    });
  }
  token() {
    if (!this.active) return;
    const now = this.clock();
    this.active.first ??= now;
    this.active.last = now;
  }
  /** Observe both streamed turns and result-only compaction without consuming twice. */
  observe<
    T extends {
      result(): Promise<{ stopReason: string; usage: { output: number } }>;
      [Symbol.asyncIterator](): AsyncIterator<{ type: string }>;
    },
  >(stream: T): T {
    const id = this.active?.id;
    const current = () => id !== undefined && this.active?.id === id;
    const result = async () => {
      try {
        const message = await stream.result();
        if (current())
          this.finish(
            message.stopReason === "aborted"
              ? "interrupted"
              : message.stopReason === "error"
                ? "failed"
                : "completed",
            message.usage.output,
          );
        return message;
      } catch (error) {
        if (current()) this.finish("failed");
        throw error;
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- The async iterator needs the timing owner while its own receiver is the stream.
    const timing = this;
    return new Proxy(stream, {
      get(target, key) {
        if (key === "result") return result;
        if (key === Symbol.asyncIterator)
          return async function* () {
            try {
              for await (const event of stream) {
                if (
                  current() &&
                  ["text_delta", "thinking_delta", "toolcall_delta"].includes(event.type)
                )
                  timing.token();
                if (event.type === "done" || event.type === "error") await result();
                yield event;
              }
            } catch (error) {
              if (current()) timing.finish("failed");
              throw error;
            }
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  finish(state: "completed" | "failed" | "interrupted", outputTokens?: number) {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    const durationMs = Math.max(0, this.clock() - active.start);
    const firstTokenMs =
      active.first === undefined ? undefined : Math.max(0, active.first - active.start);
    const generationMs =
      active.first === undefined || active.last === undefined
        ? undefined
        : Math.max(0, active.last - active.first);
    this.record({
      id: active.id,
      parentId: this.parentId,
      sessionId: this.sessionId,
      name: active.name,
      kind: "request",
      state,
      durationMs,
      details: {
        timingSource: "client-observed provider invocation",
        ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
        ...(generationMs === undefined ? {} : { generationMs }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
      },
    });
  }
  wait(name: string, details?: Record<string, string | number | boolean>) {
    this.endWait(name, "interrupted");
    const entry = {
      id: `${this.parentId}/wait-${this.sessionId}-${++this.sequence}`,
      start: this.clock(),
    };
    this.waits.set(name, entry);
    this.record({
      id: entry.id,
      parentId: this.parentId,
      sessionId: this.sessionId,
      name,
      kind: "wait",
      state: "started",
      details,
    });
  }
  endWait(
    name: string,
    state: "completed" | "failed" | "interrupted" = "completed",
    details?: Record<string, string | number | boolean>,
  ) {
    const entry = this.waits.get(name);
    if (!entry) return;
    this.waits.delete(name);
    this.record({
      id: entry.id,
      parentId: this.parentId,
      sessionId: this.sessionId,
      name,
      kind: "wait",
      state,
      durationMs: Math.max(0, this.clock() - entry.start),
      ...(details ? { details } : {}),
    });
  }
  close() {
    this.finish("interrupted");
    for (const name of this.waits.keys()) this.endWait(name, "interrupted");
  }
}
