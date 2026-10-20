import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  truncate,
} from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./atomic-file.js";
import {
  eventSchema,
  runSchema,
  type RunEvent,
  type WorkflowRun,
} from "./domain.js";

export class RunStore {
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
        const run = runSchema.parse(JSON.parse(await readFile(path.join(this.directory, entry.name, "run.json"), "utf8")));
        if (run.id !== entry.name) { throw new Error(`Run ID does not match its directory: ${entry.name}`); }
        runs.push(run);
      } catch (error) {
        // A crash during the initial atomic save may leave a directory without a published run.
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { throw error; }
      }
    }

    return runs;
  }

  async save(run: WorkflowRun) {
    const contents = JSON.stringify(runSchema.parse(run), null, 2) + "\n";
    const operation = (this.saveWrites.get(run.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const directory = path.join(this.directory, run.id);
      await mkdir(directory, { recursive: true });
      await atomicWrite(path.join(directory, "run.json"), contents);
    });
    this.saveWrites.set(run.id, operation);
    try { await operation; }
    finally { if (this.saveWrites.get(run.id) === operation) { this.saveWrites.delete(run.id); } }
  }

  record(event: RunEvent) {
    this.eventWrites = this.eventWrites.then(async () => {
      const directory = path.join(this.directory, event.runId);
      await mkdir(directory, { recursive: true });
      const filename = path.join(directory, "events.jsonl");
      if (!this.eventFilesReady.has(event.runId)) {
        try {
          const content = await readFile(filename, "utf8");
          if (content && !content.endsWith("\n")) {
            const boundary = content.lastIndexOf("\n") + 1;
            let valid = true;
            try { JSON.parse(content.slice(boundary)); } catch { valid = false; }
            if (valid) { await appendFile(filename, "\n"); }
            else { await truncate(filename, Buffer.byteLength(content.slice(0, boundary))); }
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { throw error; }
        }
        this.eventFilesReady.add(event.runId);
      }
      await appendFile(
        filename,
        JSON.stringify(event) + "\n",
        { mode: 0o600 },
      );
    }).catch((error: unknown) => { this.eventFailures.push(error); });
  }

  async flush() {
    await this.eventWrites;
    if (this.eventFailures.length) {
      const failures = this.eventFailures;
      this.eventFailures = [];
      throw new AggregateError(failures, "Could not persist workflow events");
    }
  }

  async events(runId: string) {
    try {
      const content = await readFile(
        path.join(this.directory, runId, "events.jsonl"),
        "utf8",
      );

      const lines = content.split("\n");
      if (!content.endsWith("\n") && lines.at(-1)) {
        try { JSON.parse(lines.at(-1)!); } catch { lines.pop(); }
      }
      return lines.filter(Boolean).slice(-500).map((line) => eventSchema.parse(JSON.parse(line)));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
  }
}
