import { Database } from "bun:sqlite";
import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "../../infrastructure/atomic-file.js";
import { runSchema, type WorkflowRun } from "../../contracts/domain.js";
import {
  automationSchema,
  automationConfigSchema,
  automationCaseSchema,
  automationJobSchema,
  automationObservationSchema,
  schedulerSettingsSchema,
  automationAuditSchema,
  type Automation,
  type AutomationConfig,
  type AutomationCase,
  type AutomationJob,
  type AutomationObservation,
  type AutomationAudit,
  type SchedulerSettings,
} from "../../contracts/automation-schema.js";

export const automationVersionSchema = z.object({
  config: automationConfigSchema,
  templates: z.record(z.string(), runSchema),
});
export type AutomationVersion = {
  config: AutomationConfig;
  templates: Record<string, WorkflowRun>;
};

/** The engine's project lease owns this WAL database; no external work occurs in a transaction. */
export class AutomationStore {
  private constructor(private readonly db: Database) {}
  static async open(project: string) {
    const directory = path.join(project, ".workflow", "automations");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await atomicWrite(path.join(directory, ".gitignore"), "*\n");
    const filename = path.join(directory, "state.sqlite");
    const db = new Database(filename, { create: true, strict: true });
    try {
      await chmod(filename, 0o600);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS definitions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS retired_revisions(case_id TEXT NOT NULL, revision TEXT NOT NULL,
          PRIMARY KEY(case_id,revision));
        CREATE TABLE IF NOT EXISTS observations(seq INTEGER PRIMARY KEY AUTOINCREMENT,
          automation_id TEXT NOT NULL, identity TEXT NOT NULL, data TEXT NOT NULL,
          UNIQUE(automation_id,identity));
        CREATE TABLE IF NOT EXISTS jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
          automation_id TEXT NOT NULL, identity TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
          UNIQUE(automation_id,identity));
        CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,seq);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        PRAGMA user_version=1;`);
      return new AutomationStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  transaction<T>(action: () => T): T {
    return this.db.transaction(action)();
  }
  definitions() {
    return this.db
      .query<{ data: string }, []>("SELECT data FROM definitions ORDER BY rowid")
      .all()
      .map((row) => automationSchema.parse(JSON.parse(row.data)));
  }
  definition(id: string) {
    const row = this.db
      .query<{ data: string }, [string]>("SELECT data FROM definitions WHERE id=?")
      .get(id);
    if (!row) throw new Error("Automation not found");
    return automationSchema.parse(JSON.parse(row.data));
  }
  save(value: Automation, version?: AutomationVersion) {
    this.transaction(() => {
      if (version)
        this.db
          .query("INSERT INTO versions VALUES (?,?)")
          .run(value.versionId, JSON.stringify(automationVersionSchema.parse(version)));
      this.db
        .query("INSERT OR REPLACE INTO definitions VALUES (?,?)")
        .run(value.id, JSON.stringify(automationSchema.parse(value)));
    });
  }
  version(id: string) {
    const row = this.db
      .query<{ data: string }, [string]>("SELECT data FROM versions WHERE id=?")
      .get(id);
    if (!row) throw new Error("Automation version not found");
    return automationVersionSchema.parse(JSON.parse(row.data));
  }
  cases(limit = 200) {
    return this.db
      .query<{ data: string }, [number]>("SELECT data FROM cases ORDER BY rowid DESC LIMIT ?")
      .all(limit)
      .map((row) => automationCaseSchema.parse(JSON.parse(row.data)));
  }
  case(id: string) {
    const row = this.db
      .query<{ data: string }, [string]>("SELECT data FROM cases WHERE id=?")
      .get(id);
    return row ? automationCaseSchema.parse(JSON.parse(row.data)) : undefined;
  }
  saveCase(value: AutomationCase) {
    this.db
      .query("INSERT OR REPLACE INTO cases VALUES (?,?)")
      .run(value.id, JSON.stringify(automationCaseSchema.parse(value)));
  }
  retire(caseId: string, revision: string) {
    this.db.query("INSERT OR IGNORE INTO retired_revisions VALUES (?,?)").run(caseId, revision);
  }
  retired(caseId: string, revision: string) {
    return !!this.db
      .query("SELECT 1 FROM retired_revisions WHERE case_id=? AND revision=?")
      .get(caseId, revision);
  }
  observed(automationId: string, identity: string) {
    return !!this.db
      .query("SELECT 1 FROM observations WHERE automation_id=? AND identity=?")
      .get(automationId, identity);
  }
  observe(value: AutomationObservation) {
    return (
      this.db
        .query("INSERT OR IGNORE INTO observations(automation_id,identity,data) VALUES (?,?,?)")
        .run(
          value.automationId,
          value.key,
          JSON.stringify(automationObservationSchema.parse(value)),
        ).changes > 0
    );
  }
  updateObservation(value: AutomationObservation) {
    this.db
      .query("UPDATE observations SET data=? WHERE automation_id=? AND identity=?")
      .run(JSON.stringify(automationObservationSchema.parse(value)), value.automationId, value.key);
  }
  deferred(caseId: string) {
    return this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM observations WHERE json_extract(data,'$.disposition')='awaiting-revision' AND json_extract(data,'$.caseId')=? ORDER BY seq",
      )
      .all(caseId)
      .map((row) => automationObservationSchema.parse(JSON.parse(row.data)));
  }
  observations() {
    return this.db
      .query<{ data: string }, []>("SELECT data FROM observations ORDER BY seq DESC LIMIT 200")
      .all()
      .map((row) => automationObservationSchema.parse(JSON.parse(row.data)));
  }
  insert(value: AutomationJob) {
    return (
      this.db
        .query(
          "INSERT OR IGNORE INTO jobs(id,automation_id,identity,status,data) VALUES (?,?,?,?,?)",
        )
        .run(
          value.id,
          value.automationId,
          value.key,
          value.status,
          JSON.stringify(automationJobSchema.parse(value)),
        ).changes > 0
    );
  }
  update(value: AutomationJob) {
    this.db
      .query("UPDATE jobs SET status=?,data=? WHERE id=?")
      .run(value.status, JSON.stringify(automationJobSchema.parse(value)), value.id);
  }
  job(id: string) {
    const row = this.db
      .query<{ data: string }, [string]>("SELECT data FROM jobs WHERE id=?")
      .get(id);
    if (!row) throw new Error("Automation job not found");
    return automationJobSchema.parse(JSON.parse(row.data));
  }
  jobs(scope: "history" | "pending" | "all" = "history") {
    const sql =
      scope === "pending"
        ? "SELECT data FROM jobs WHERE status IN ('queued','admitted','running','waiting','needs_attention') ORDER BY seq"
        : scope === "all"
          ? "SELECT data FROM jobs ORDER BY seq"
          : "SELECT data FROM jobs ORDER BY seq DESC LIMIT 200";
    return this.db
      .query<{ data: string }, []>(sql)
      .all()
      .map((row) => automationJobSchema.parse(JSON.parse(row.data)));
  }
  audit(value: Omit<AutomationAudit, "id">) {
    this.db.query("INSERT INTO audit(data) VALUES (?)").run(JSON.stringify(value));
    this.db.exec("DELETE FROM audit WHERE id <= (SELECT MAX(id)-5000 FROM audit)");
  }
  history() {
    return this.db
      .query<{ id: number; data: string }, []>(
        "SELECT id,data FROM audit ORDER BY id DESC LIMIT 200",
      )
      .all()
      .map((row) => automationAuditSchema.parse({ ...JSON.parse(row.data), id: row.id }));
  }
  settings(): SchedulerSettings {
    const row = this.db.query<{ data: string }, []>("SELECT data FROM settings WHERE id=1").get();
    return schedulerSettingsSchema.parse(row ? JSON.parse(row.data) : {});
  }
  saveSettings(value: SchedulerSettings) {
    this.db
      .query("INSERT OR REPLACE INTO settings VALUES(1,?)")
      .run(JSON.stringify(schedulerSettingsSchema.parse(value)));
  }
}
