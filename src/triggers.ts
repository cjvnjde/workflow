import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkflowEngine } from "./engine.js";
import { budgetSchema, type WorkflowRun } from "./domain.js";
import { GithubPollingSource, GithubRequestError, type GithubTriggerSource } from "./github-trigger-source.js";
import { saveTriggerSchema, triggerConfigSchema, type Trigger, type TriggerJob, type GithubEvent } from "./trigger-schema.js";
import { TriggerStore } from "./trigger-store.js";

type TriggerEngine = Pick<WorkflowEngine, "project" | "mode" | "list" | "get" | "snapshotForTrigger" | "createTriggeredRun" | "approve">;
const active = new Set(["running", "pausing", "paused", "interrupted"]);
const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 2000) : "Trigger processing failed";
export function matchesTrigger(trigger: Trigger, event: GithubEvent) {
  return event.repository === trigger.repository && event.kind === trigger.event && event.createdAt >= trigger.createdAt
    && trigger.labels.every(label => event.labels.includes(label))
    && (!trigger.authors.length || trigger.authors.some(author => author.toLowerCase() === event.author.toLowerCase()))
    && (trigger.includeDrafts || !event.draft);
}

/** Durable admission/outbox around the existing executor. No AI planning or effects occur in polling. */
export class Triggers {
  private queue = Promise.resolve();
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private readonly abort = new AbortController();
  private error?: string;
  private constructor(private readonly engine: TriggerEngine, private readonly store: TriggerStore,
    private readonly source: GithubTriggerSource, private readonly now: () => number) {}
  static async open(engine: TriggerEngine, source: GithubTriggerSource = new GithubPollingSource(engine.project, fetch, engine.mode === "live"), now = Date.now) {
    return new Triggers(engine, await TriggerStore.open(engine.project), source, now);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Triggers are closing"));
    const pending = this.queue.then(() => { this.abort.signal.throwIfAborted(); return action(); });
    this.queue = pending.then(() => {}, () => {});
    return pending;
  }
  start() {
    const work = () => { void this.tick().catch(error => { if (!this.closed) this.error = message(error); }); };
    this.timer = setInterval(work, 1000); this.timer.unref(); work();
  }
  state() { return { triggers: this.store.triggers(), jobs: this.store.jobs(), error: this.error }; }
  save(value: unknown) {
    const input = saveTriggerSchema.parse(value);
    return this.serial(async () => {
      const current = input.id ? this.store.trigger(input.id) : undefined;
      if (input.id && (!current || current.revision !== input.revision)) throw new Error("Trigger changed. Reload before saving.");
      if (!current && this.store.triggers().length >= 30) throw new Error("A project supports at most 30 triggers");
      // Preserve the captured version when toggling or changing filters. Selecting
      // another run is the explicit way to promote a different executable.
      const template = current?.workflowRunId === input.config.workflowRunId
        ? this.store.version(current.versionId).template : await this.engine.snapshotForTrigger(input.config.workflowRunId);
      if (template.mode !== this.engine.mode) throw new Error("Trigger execution mode does not match this application");
      const time = new Date(this.now()).toISOString();
      const sameSource = current?.repository === input.config.repository && current.event === input.config.event;
      const trigger: Trigger = { ...input.config, id: current?.id ?? randomUUID(), revision: (current?.revision ?? -1) + 1,
        versionId: randomUUID(), createdAt: sameSource ? current.createdAt : time, cursor: sameSource ? current.cursor : time,
        nextPollAt: 0, workflowTitle: template.plan.title, executionVersion: template.executionVersion! };
      this.store.save(trigger, { config: input.config, template });
      return trigger;
    });
  }
  private job(trigger: Trigger, event: GithubEvent, test = false): TriggerJob {
    return { id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name, versionId: trigger.versionId,
      event, runId: randomUUID(), createdAt: new Date(this.now()).toISOString(), status: "queued", test, delivery: "pending", nextDeliveryAt: 0 };
  }
  test(id: string, value: unknown) {
    const { number } = z.object({ number: z.number().int().positive() }).strict().parse(value);
    return this.serial(async () => {
      const trigger = this.store.trigger(id);
      if (!trigger) throw new Error("Trigger not found");
      const event = await this.source.item(triggerConfigSchema.strip().parse(trigger), number, this.abort.signal);
      const job = this.job(trigger, event, true);
      // Save the reservation before creating a draft. A crash between the two is recoverable.
      this.store.insert(job);
      await this.dispatch(job);
      return this.store.job(job.id);
    });
  }
  action(id: string, action: "retry" | "cancel") {
    return this.serial(async () => {
      const job = this.store.job(id);
      if (action === "cancel") {
        if (!["queued", "failed"].includes(job.status)) throw new Error("Cancel active runs from the workflow. Only queued events can be cancelled here.");
        job.status = "cancelled"; job.error = undefined;
      } else {
        if (job.status === "publishing") job.nextDeliveryAt = 0;
        else if (job.status === "failed") { job.status = "queued"; job.error = undefined; }
        else throw new Error("Only failed dispatch or pending result delivery can be retried");
      }
      this.store.update(job);
      return job;
    });
  }
  tick(force = false) {
    if (this.ticking) return this.ticking;
    this.ticking = this.serial(async () => {
      this.error = undefined;
      // Drain completed work before polling. Newly admitted work is handled below.
      for (const job of this.store.jobs(true)) await this.dispatch(job);
      for (const trigger of this.store.triggers()) {
        if (!trigger.enabled || (!force && trigger.nextPollAt > this.now())) continue;
        const started = this.now();
        try {
          const events = await this.source.poll(triggerConfigSchema.strip().parse(trigger), trigger.cursor, this.abort.signal);
          this.abort.signal.throwIfAborted();
          const jobs = events.filter(event => matchesTrigger(trigger, event)).map(event => this.job(trigger, event));
          const cursor = new Date(started).toISOString();
          this.store.admit({ ...trigger, cursor, lastPollAt: cursor,
            nextPollAt: this.now() + trigger.pollSeconds * 1000, error: undefined }, jobs);
        } catch (error) {
          this.abort.signal.throwIfAborted();
          trigger.error = message(error); trigger.nextPollAt = this.now() + Math.max(60, trigger.pollSeconds) * 1000;
          this.store.save(trigger); // Never advance the checkpoint on failed/partial polling.
        }
      }
      for (const job of this.store.jobs(true)) await this.dispatch(job);
    }).finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private async dispatch(job: TriggerJob) {
    this.abort.signal.throwIfAborted();
    try {
      const version = this.store.version(job.versionId);
      if (version.config.maxCostUsd !== undefined) version.template.config.budget = budgetSchema.parse({ ...version.template.config.budget, maxCostUsd: version.config.maxCostUsd });
      if (job.status === "queued") {
        if (!job.test && !this.store.trigger(job.triggerId)?.enabled) return;
        if (!job.test && this.engine.list().some(run => run.id !== job.runId && active.has(run.status))) return;
        const run = await this.engine.createTriggeredRun(version.template, job.runId, job.event);
        this.abort.signal.throwIfAborted();
        if (run.deletedAt) { job.status = "cancelled"; this.store.update(job); return; }
        if (run.status === "draft" && !job.test) {
          if (this.engine.list().some(run => active.has(run.status))) return;
          try { await this.engine.approve(run.id, run.revision); }
          catch (error) {
            // A manual approval can win between checking occupancy and the
            // engine's serialized approval. Keep this reservation queued.
            if (this.engine.get(run.id).status === "draft"
              && this.engine.list().some(candidate => candidate.id !== run.id && active.has(candidate.status))) return;
            throw error;
          }
        }
        job.status = run.status === "draft" && job.test ? "draft" : "running";
        job.error = undefined; this.store.update(job);
      }
      if (job.status === "draft" || job.status === "running") {
        const run = this.engine.get(job.runId);
        const previousStatus = job.runStatus;
        job.runStatus = run.status;
        if (run.status === "draft") { if (previousStatus !== run.status) this.store.update(job); return; }
        if (active.has(run.status)) { job.status = "running"; if (previousStatus !== run.status) this.store.update(job); return; }
        job.status = !job.test && version.config.result === "github-comment" && run.status !== "rejected" ? "publishing" : "completed";
        this.store.update(job);
      }
      if (job.status === "publishing" && job.nextDeliveryAt <= this.now()) await this.deliver(job, this.engine.get(job.runId));
    } catch (error) {
      if (this.abort.signal.aborted) return; // The persisted reservation is recovered on reopen.
      job.error = message(error);
      if (job.status !== "publishing") job.status = "failed";
      else job.nextDeliveryAt = this.now() + 60_000;
      this.store.update(job);
    }
  }
  private async deliver(job: TriggerJob, run: WorkflowRun) {
    const marker = `<!-- workflow-trigger:${job.id} -->`;
    const existing = await this.source.findComment(job.event, marker, this.abort.signal);
    if (existing) {
      job.resultUrl = existing; job.delivery = "published"; job.status = "completed"; job.error = undefined; this.store.update(job); return;
    }
    if (job.delivery === "posting" || job.delivery === "uncertain") {
      job.delivery = "uncertain"; job.error = "GitHub may have accepted the result before the connection stopped. No duplicate will be posted. Retry checks for the original comment; inspect GitHub if it remains missing.";
      job.nextDeliveryAt = this.now() + 300_000; this.store.update(job); return;
    }
    const summary = run.output || run.attempts.map(attempt => attempt.result?.summary).filter(Boolean).join("\n\n") || run.error || "No result summary was produced.";
    const body = `${marker}\n## ${job.triggerName}\n\nWorkflow **${run.status}** · run \`${run.id}\`${job.event.headSha ? ` · commit \`${job.event.headSha}\`` : ""}\n\n${summary.slice(0, 50_000)}${run.error ? `\n\n${run.error.slice(0, 2000)}` : ""}`;
    job.delivery = "posting"; this.store.update(job);
    try {
      job.resultUrl = await this.source.comment(job.event, body, this.abort.signal);
      job.delivery = "published"; job.status = "completed"; job.error = undefined;
    } catch (error) {
      // Definitive client rejection can be retried. Timeouts/5xx/process loss are
      // ambiguous: reconcile the marker, never blindly repeat a POST.
      job.delivery = error instanceof GithubRequestError && error.status >= 400 && error.status < 500 && error.status !== 408 ? "pending" : "uncertain";
      job.error = message(error); job.nextDeliveryAt = this.now() + 60_000;
    }
    this.store.update(job);
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.abort.abort(new Error("Triggers closing"));
    await this.queue;
    this.store.close();
  }
}
