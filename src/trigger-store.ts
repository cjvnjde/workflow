import { Database } from "bun:sqlite";
import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runSchema, type WorkflowRun } from "./domain.js";
import { atomicWrite } from "./atomic-file.js";
import { triggerConfigSchema, triggerSchema, triggerJobSchema, type Trigger, type TriggerJob, type TriggerConfig } from "./trigger-schema.js";

const versionSchema = z.object({ config: triggerConfigSchema, template: runSchema });

/** One project lease owns this database. Admission and cursor advancement share a transaction. */
export class TriggerStore {
  private constructor(private readonly db: Database) {}
  static async open(project: string) {
    const directory = path.join(project, ".workflow", "triggers");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await atomicWrite(path.join(directory, ".gitignore"), "*\n");
    const filename = path.join(directory, "state.sqlite");
    const db = new Database(filename, { create: true, strict: true });
    try {
      await chmod(filename, 0o600);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS triggers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
          trigger_id TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
          UNIQUE(trigger_id, event_id));
        CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, seq);`);
      return new TriggerStore(db);
    } catch (error) { db.close(); throw error; }
  }
  close() { this.db.close(); }
  triggers() { return this.db.query<{ data: string }, []>("SELECT data FROM triggers ORDER BY rowid").all().map(row => triggerSchema.parse(JSON.parse(row.data))); }
  trigger(id: string) { return this.triggers().find(item => item.id === id); }
  version(id: string) {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM versions WHERE id = ?").get(id);
    if (!row) throw new Error("Trigger workflow snapshot is missing");
    return versionSchema.parse(JSON.parse(row.data));
  }
  save(trigger: Trigger, version?: { config: TriggerConfig; template: WorkflowRun }) {
    this.db.transaction(() => {
      if (version) this.db.query("INSERT INTO versions VALUES (?, ?)").run(trigger.versionId, JSON.stringify(versionSchema.parse(version)));
      this.db.query("INSERT OR REPLACE INTO triggers VALUES (?, ?)").run(trigger.id, JSON.stringify(triggerSchema.parse(trigger)));
    })();
  }
  admit(trigger: Trigger, jobs: TriggerJob[]) {
    this.db.transaction(() => {
      for (const job of jobs) this.insert(job);
      this.save(trigger);
    })();
  }
  insert(job: TriggerJob) {
    const checked = triggerJobSchema.parse(job);
    return this.db.query("INSERT OR IGNORE INTO jobs(id, trigger_id, event_id, status, data) VALUES (?, ?, ?, ?, ?)")
      .run(job.id, job.triggerId, job.test ? `test:${job.id}` : job.event.id, job.status, JSON.stringify(checked)).changes > 0;
  }
  job(id: string) {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM jobs WHERE id = ?").get(id);
    if (!row) throw new Error("Trigger event not found");
    return triggerJobSchema.parse(JSON.parse(row.data));
  }
  update(job: TriggerJob) {
    this.db.query("UPDATE jobs SET status = ?, data = ? WHERE id = ?").run(job.status, JSON.stringify(triggerJobSchema.parse(job)), job.id);
  }
  jobs(pending = false) {
    const sql = pending ? "SELECT data FROM jobs WHERE status IN ('queued','draft','running','publishing') ORDER BY seq"
      : "SELECT data FROM jobs ORDER BY seq DESC LIMIT 100";
    return this.db.query<{ data: string }, []>(sql).all().map(row => triggerJobSchema.parse(JSON.parse(row.data)));
  }
}
