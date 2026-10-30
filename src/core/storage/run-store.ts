import { StringDecoder } from "node:string_decoder";
import {
  ExecutionProjection,
  historyQuerySchema,
  isReportEvidenceEvent,
  type HistoryQuery,
  type HistoryPage,
  type ExecutionSnapshot,
  type ReportEvidence,
} from "../../contracts/execution-history.js";
import { appendFile, stat, open, mkdir, readFile, readdir, truncate } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../../infrastructure/atomic-file.js";
import { eventSchema, runSchema, type RunEvent, type WorkflowRun } from "../../contracts/domain.js";

interface ProjectionCache {
  stamp: string;
  bytes: bigint;
  total: number;
  projection: ExecutionProjection;
  reportEvents: RunEvent[];
}

export class RunStore {
  private readonly executionCache = new Map<string, ProjectionCache>();
  private readonly eventFilesReady = new Set<string>();
  private eventFailures: unknown[] = [];
  private eventWrites = Promise.resolve();
  private readonly saveWrites = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  async load() {
    await mkdir(this.directory, { recursive: true });
    const runs: WorkflowRun[] = [];
    for (const entry of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) {
        continue;
      }
      try {
        const run = runSchema.parse(
          JSON.parse(await readFile(path.join(this.directory, entry.name, "run.json"), "utf8")),
        );
        if (run.id !== entry.name) {
          throw new Error(`Run ID does not match its directory: ${entry.name}`);
        }
        runs.push(run);
      } catch (error) {
        // A crash during the initial atomic save may leave a directory without a published run.
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }

    return runs;
  }

  async save(run: WorkflowRun) {
    const contents = JSON.stringify(runSchema.parse(run), null, 2) + "\n";
    const operation = (this.saveWrites.get(run.id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const directory = path.join(this.directory, run.id);
        await mkdir(directory, { recursive: true });
        await atomicWrite(path.join(directory, "run.json"), contents);
      });
    this.saveWrites.set(run.id, operation);
    try {
      await operation;
    } finally {
      if (this.saveWrites.get(run.id) === operation) {
        this.saveWrites.delete(run.id);
      }
    }
  }

  record(event: RunEvent) {
    // Capture the submitted value before yielding to other writers or listeners.
    const runId = event.runId;
    const contents = JSON.stringify(eventSchema.parse(event)) + "\n";
    const operation = this.eventWrites.then(async () => {
      const directory = path.join(this.directory, runId);
      await mkdir(directory, { recursive: true });
      const filename = path.join(directory, "events.jsonl");
      let cached = this.executionCache.get(runId);
      if (cached && (await this.logStamp(filename))?.stamp !== cached.stamp) {
        this.executionCache.delete(runId);
        this.eventFilesReady.delete(runId);
        cached = undefined;
      }

      if (!this.eventFilesReady.has(runId)) {
        try {
          const content = await readFile(filename, "utf8");
          if (content && !content.endsWith("\n")) {
            const boundary = content.lastIndexOf("\n") + 1;
            let valid = true;
            try {
              JSON.parse(content.slice(boundary));
            } catch {
              valid = false;
            }
            if (valid) {
              await appendFile(filename, "\n");
            } else {
              await truncate(filename, Buffer.byteLength(content.slice(0, boundary)));
            }
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
        this.eventFilesReady.add(runId);
      }
      await appendFile(filename, contents, { mode: 0o600 });
      if (cached) {
        const next = await this.logStamp(filename);
        if (next && next.bytes === cached.bytes + BigInt(Buffer.byteLength(contents))) {
          // The serialized append committed before its cached projection changes.
          const recorded = eventSchema.parse(JSON.parse(contents));
          cached.projection.apply(recorded, cached.total);
          if (isReportEvidenceEvent(recorded)) cached.reportEvents.push(recorded);
          cached.total++;
          cached.stamp = next.stamp;
          cached.bytes = next.bytes;
        } else this.executionCache.delete(runId);
      }
    });
    // Callers may await this exact write before publishing its event. Keep the
    // queue usable and retain failures for callers that only await flush().
    this.eventWrites = operation.catch((error: unknown) => {
      this.eventFailures.push(error);
    });
    return operation;
  }

  async flush() {
    await this.eventWrites;
    if (this.eventFailures.length) {
      const failures = this.eventFailures;
      this.eventFailures = [];
      throw new AggregateError(failures, "Could not persist workflow events");
    }
  }

  /** Read one byte-bounded snapshot. Appends during the scan belong to a later snapshot. */
  private async *scan(runId: string): AsyncGenerator<{ cursor: number; event: RunEvent }> {
    const filename = path.join(this.directory, runId, "events.jsonl");
    const handle = await open(filename, "r").catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!handle) return;
    // Keep descriptor ownership entirely here. FileHandle-backed ReadStreams
    // have a second close lifecycle, which can race an early async-iterator
    // return (notably under Bun). Every read, including metadata, is covered.
    try {
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(64 * 1024);
      const decoder = new StringDecoder("utf8");
      let position = 0,
        cursor = 0,
        pending = "";
      while (position < size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, size - position),
          position,
        );
        if (!bytesRead) break;
        position += bytesRead;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        let boundary: number;
        while ((boundary = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, boundary);
          pending = pending.slice(boundary + 1);
          if (line.trim()) yield { cursor: cursor++, event: eventSchema.parse(JSON.parse(line)) };
        }
      }
      pending += decoder.end();
      if (pending.trim()) {
        let value: unknown;
        // A torn, unterminated last record is not a committed event. Complete
        // lines and schema-invalid JSON remain errors rather than disappearing.
        try {
          value = JSON.parse(pending);
        } catch {
          return;
        }
        yield { cursor, event: eventSchema.parse(value) };
      }
    } finally {
      await handle.close();
    }
  }

  async history(runId: string, input: HistoryQuery = {}): Promise<HistoryPage> {
    const query = historyQuerySchema.parse(input);
    const events: HistoryPage["events"] = [];
    let last = -1;
    for await (const item of this.scan(runId)) {
      if (query.asOf !== undefined && item.cursor > query.asOf) break;
      last = item.cursor;
      if (query.before === undefined || item.cursor < query.before) {
        events.push(item);
        if (events.length > query.limit) events.shift();
      }
    }
    const first = events[0]?.cursor;
    const hasMore = first !== undefined && first > 0;
    return {
      events,
      asOf: last,
      total: last + 1,
      hasMore,
      ...(hasMore ? { nextBefore: first } : {}),
    };
  }

  private async logStamp(filename: string) {
    try {
      const info = await stat(filename, { bigint: true });
      return {
        bytes: info.size,
        stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async projection(runId: string): Promise<ProjectionCache> {
    const filename = path.join(this.directory, runId, "events.jsonl");
    const before = await this.logStamp(filename);
    let cached = this.executionCache.get(runId);
    if (!before || cached?.stamp !== before.stamp) {
      this.executionCache.delete(runId);
      // A log changed outside this store; recheck its tail before a later append.
      this.eventFilesReady.delete(runId);
      const projection = new ExecutionProjection(true);
      const reportEvents: RunEvent[] = [];
      let total = 0;
      for await (const { cursor, event } of this.scan(runId)) {
        total = cursor + 1;
        projection.apply(event, cursor);
        if (isReportEvidenceEvent(event)) reportEvents.push(event);
      }
      const after = await this.logStamp(filename);
      cached = {
        stamp: after?.stamp ?? "missing",
        bytes: after?.bytes ?? 0n,
        total,
        projection,
        reportEvents,
      };
      // External replacement or truncation during the scan cannot seed a cache.
      if (before && after?.stamp === before.stamp) this.executionCache.set(runId, cached);
    }
    // Keep only the most recently inspected runs; projections are disposable.
    if (this.executionCache.has(runId)) {
      this.executionCache.delete(runId);
      this.executionCache.set(runId, cached!);
    }
    while (this.executionCache.size > 8)
      this.executionCache.delete(this.executionCache.keys().next().value!);
    return cached!;
  }

  execution(runId: string): Promise<ExecutionSnapshot> {
    // Serialize with writes so a published watermark always includes exactly
    // the events folded into the cache; a failed read is not a write failure.
    const read = this.eventWrites.then(async (): Promise<ExecutionSnapshot> => {
      const cached = await this.projection(runId);
      return structuredClone({
        version: 1,
        asOf: cached.total - 1,
        total: cached.total,
        operations: [...cached.projection.operations.values()],
      });
    });
    this.eventWrites = read.then(
      () => {},
      () => {},
    );
    return read;
  }

  reportEvidence(runId: string): Promise<ReportEvidence> {
    const read = this.eventWrites.then(async () => {
      const cached = await this.projection(runId);
      return structuredClone({
        events: cached.reportEvents,
        asOf: cached.total - 1,
        total: cached.total,
        available: cached.stamp !== "missing",
      });
    });
    this.eventWrites = read.then(
      () => {},
      () => {},
    );
    return read;
  }

  async operationEvents(runId: string, key: string) {
    const projection = new ExecutionProjection(true);
    const events: RunEvent[] = [];
    let asOf = -1;
    for await (const { cursor, event } of this.scan(runId)) {
      asOf = cursor;
      if (projection.apply(event, cursor) === key) events.push(event);
    }
    const summary = projection.operations.get(key);
    const detail = summary && {
      ...summary,
      operation: {
        ...events.reduce((value, event) => ({ ...value, ...event.operation }), {
          ...summary.operation,
        }),
        state: summary.state,
        visit: summary.visit,
        attempt: summary.attempt,
      },
    };
    return { events, asOf, ...(detail ? { operation: detail } : {}) };
  }

  async events(runId: string) {
    return (await this.history(runId, { limit: 500 })).events.map((item) => item.event);
  }
}
