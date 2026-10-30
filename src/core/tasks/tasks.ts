import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { WorkflowEngine } from "../engine.js";
import { atomicWrite } from "../../infrastructure/atomic-file.js";
import { Attachments } from "./attachments.js";
import { loadOrchestration } from "../settings/orchestration-settings.js";
import { loadLibrary } from "../library/library.js";
import { planTask } from "../planning/task-planner.js";
import { availableModels } from "../models/available-models.js";
import { newTaskSchema, taskSchema, type TaskRequest } from "../../contracts/task-schema.js";
import { createTemplate } from "../library/templates.js";
import { createAccountingContext, UsageStore } from "../storage/usage-store.js";
import { withProjectSettingsSnapshot } from "../settings/settings-publication.js";

export class Tasks {
  private readonly records = new Map<string, TaskRequest>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly writes = new Map<string, Promise<void>>();
  private queue = Promise.resolve();
  private closed = false;
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly catalog = availableModels,
    private readonly planner = planTask,
  ) {}
  private filename(id: string) {
    return path.join(
      this.engine.project,
      ".workflow",
      "tasks",
      `${z.string().uuid().parse(id)}.json`,
    );
  }
  async initialize() {
    const directory = path.dirname(this.filename(randomUUID()));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(directory, ".gitignore"), "*\n");
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) {
        continue;
      }
      const task = taskSchema.parse(JSON.parse(await readFile(path.join(directory, name), "utf8")));
      if (`${task.id}.json` !== name) {
        throw new Error("Task identity does not match its storage path");
      }
      this.records.set(task.id, task);
      if (["queued", "planning"].includes(task.status)) {
        task.status = "failed";
        task.error = "Planning was interrupted when the server stopped. Retry to continue.";
        await this.save(task);
      }
    }
  }
  list(includeDeleted = false) {
    return [...this.records.values()]
      .filter((task) => includeDeleted || !task.deletedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ events: _events, answers: _answers, ...task }) => structuredClone(task));
  }
  get(id: string) {
    const task = this.records.get(id);
    if (!task) {
      throw new Error("Task not found");
    }
    return structuredClone(task);
  }
  private async save(task: TaskRequest) {
    task.updatedAt = new Date().toISOString();
    task.revision++;
    const snapshot = JSON.stringify(taskSchema.parse(task));
    const write = (this.writes.get(task.id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => atomicWrite(this.filename(task.id), snapshot));
    this.writes.set(task.id, write);
    try {
      await write;
    } finally {
      if (this.writes.get(task.id) === write) {
        this.writes.delete(task.id);
      }
    }
    this.engine.coordinatorActivity("task_state", task.status, `task:${task.id}`);
  }
  private emit(task: TaskRequest, kind: string, message: string) {
    this.engine.coordinatorActivity(kind, message, `task:${task.id}`);
    if (kind !== "text_delta") {
      task.events.push({
        id: randomUUID(),
        runId: `task:${task.id}`,
        time: new Date().toISOString(),
        kind,
        message: message.slice(0, 8000),
      });
      task.events = task.events.slice(-200);
    }
  }
  async create(value: unknown) {
    return withProjectSettingsSnapshot(this.engine.project, () => this.createFromSnapshot(value));
  }
  private async createFromSnapshot(value: unknown) {
    if (this.closed) {
      throw new Error("Server is shutting down");
    }
    const input = newTaskSchema.parse(value);
    const sourceRun = input.sourceRunId ? this.engine.get(input.sourceRunId) : undefined;
    const sourceTask = sourceRun
      ? [...this.records.values()].find((task) => task.runId === sourceRun.id)
      : undefined;
    if (sourceRun && !["failed", "cancelled"].includes(sourceRun.status))
      throw new Error(
        "Recovery planning requires a failed or cancelled run; pause/resume active work instead",
      );
    if (sourceRun?.attempts.some((attempt) => attempt.recovery?.status === "conflict"))
      throw new Error("Resolve file recovery or keep current files before planning a continuation");
    const attachments = await Promise.all(
      [
        ...new Set([
          ...input.attachments,
          ...(sourceRun?.config.attachments ?? []).map((attachment) => attachment.id),
        ]),
      ].map((id) => new Attachments(this.engine.project).get(id)),
    );
    if (attachments.reduce((sum, item) => sum + item.size, 0) > 20_000_000) {
      throw new Error("Attachments must total less than 20 MB");
    }
    const { settings } = await loadOrchestration(this.engine.project);
    const now = new Date().toISOString();
    const task = taskSchema.parse({
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      revision: 0,
      status: "queued",
      prompt: sourceRun?.plan.task ?? input.prompt,
      sourceRunId: sourceRun?.id,
      attachments,
      answers: structuredClone(sourceTask?.answers ?? []),
      approval: sourceRun ? "review" : (input.approval ?? settings.approval),
    });
    const usage = new UsageStore(this.engine.project);
    const inheritedScope = sourceRun ? await usage.ensureRun(sourceRun) : undefined;
    await usage.ensureScope({
      id: inheritedScope?.id,
      owner: inheritedScope?.owner ?? { kind: "task", id: task.id },
      taskId: task.id,
      maxCostUsd:
        inheritedScope?.maxCostUsd ??
        input.maxTaskCostUsd ??
        (await loadLibrary(this.engine.project)).config.budget?.maxTaskCostUsd,
    });
    this.records.set(task.id, task);
    await this.save(task);
    this.enqueue(task.id);
    return this.get(task.id);
  }
  private enqueue(id: string) {
    this.queue = this.queue
      .then(() =>
        withProjectSettingsSnapshot(this.engine.project, async () => {
          const task = this.records.get(id)!;
          if (this.closed || task.status !== "queued") {
            return;
          }
          const controller = new AbortController();
          this.controllers.set(id, controller);
          let unpublishedRunId: string | undefined;
          try {
            task.status = "planning";
            task.error = undefined;
            task.question = undefined;
            await this.save(task);
            controller.signal.throwIfAborted();
            this.emit(
              task,
              "planning",
              "Composing a graph from your request, blocks and task instructions…",
            );
            const library = await loadLibrary(this.engine.project);
            const usage = new UsageStore(this.engine.project);
            const scope =
              (await usage.scopeForTask(task.id)) ??
              (await usage.ensureScope({
                owner: { kind: "task", id: task.id },
                taskId: task.id,
                maxCostUsd: library.config.budget?.maxTaskCostUsd,
              }));
            const accounting = await createAccountingContext(this.engine.project, "planning", {
              scopeId: scope.id,
              taskId: task.id,
            });
            const { settings } = await loadOrchestration(this.engine.project);
            const result =
              this.engine.mode === "demo"
                ? await (async () => {
                    await delay(200, undefined, { signal: controller.signal });
                    this.emit(
                      task,
                      "classification",
                      "Demo: showing a simulated workflow. Live mode composes a graph with AI from your instructions.",
                    );
                    const plan = createTemplate(
                      task.prompt,
                      /bug|fix|error|broken|fail/i.test(task.prompt) ? "bug" : "feature",
                      library,
                    );
                    plan.title = task.prompt.replace(/\s+/g, " ").slice(0, 100);
                    library.config.attachments = task.attachments;
                    return {
                      kind: "plan" as const,
                      plan,
                      library,
                      rationale:
                        "Demo simulation. No model requests, commands, or task-file changes.",
                      suggestedBlocks: [],
                      caseName: "Demo task",
                    };
                  })()
                : await this.planner({
                    project: this.engine.project,
                    library,
                    settings,
                    accounting,
                    task: structuredClone(task),
                    recovery: task.sourceRunId ? this.engine.get(task.sourceRunId) : undefined,
                    models: (await this.catalog(controller.signal)).models,
                    signal: controller.signal,
                    emit: (kind, message) => this.emit(task, kind, message),
                  });
            controller.signal.throwIfAborted();
            if (result.kind === "question") {
              task.status = "needs_input";
              task.question = result.question;
            } else {
              const run =
                result.kind === "program"
                  ? await this.engine.createProgram(
                      result.title,
                      task.prompt,
                      result.program,
                      result.library,
                      undefined,
                      undefined,
                      { scopeId: scope.id, taskId: task.id },
                    )
                  : await this.engine.create(result.plan, result.library, {
                      scopeId: scope.id,
                      taskId: task.id,
                    });
              unpublishedRunId = run.id;
              controller.signal.throwIfAborted();
              task.runId = run.id;
              task.status = "ready";
              task.rationale = result.rationale;
              task.caseId = "caseId" in result ? result.caseId : undefined;
              task.caseName = result.caseName;
              task.suggestedBlocks = result.suggestedBlocks;
              await this.save(task);
              controller.signal.throwIfAborted();
              unpublishedRunId = undefined;
              if (task.approval === "automatic" && !controller.signal.aborted) {
                try {
                  await this.engine.approve(run.id, run.revision);
                } catch (error) {
                  task.error = `The workflow is ready, but could not start automatically: ${error instanceof Error ? error.message : String(error)}`;
                }
              }
            }
            await this.save(task);
            if (result.kind === "question") {
              controller.signal.throwIfAborted();
            }
          } catch (error) {
            task.status = controller.signal.aborted ? "cancelled" : "failed";
            task.error = controller.signal.aborted
              ? "Planning stopped."
              : error instanceof Error
                ? error.message
                : String(error);
            task.question = undefined;
            if (unpublishedRunId) {
              try {
                await this.engine.remove(unpublishedRunId);
                task.runId = undefined;
              } catch (cleanupError) {
                // Keep the draft reachable if storage failed; never approve it.
                task.runId = unpublishedRunId;
                task.error += ` Draft cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
              }
            }
            this.emit(task, "planning_error", task.error);
            await this.save(task);
          } finally {
            this.controllers.delete(id);
          }
        }),
      )
      .catch((error: unknown) => {
        console.error(
          "Task persistence failed:",
          error instanceof Error ? error.message : "unknown error",
        );
      });
  }
  async answer(id: string, value: unknown) {
    if (this.closed) {
      throw new Error("Server is shutting down");
    }
    const input = z
      .object({ answer: z.string().trim().min(1).max(8000), revision: z.number().int() })
      .strict()
      .parse(value);
    const task = this.records.get(id);
    if (
      !task ||
      task.deletedAt ||
      task.status !== "needs_input" ||
      !task.question ||
      task.revision !== input.revision
    ) {
      throw new Error("This question has already changed or been answered. Refresh the task.");
    }
    task.answers.push({ question: task.question.question, answer: input.answer });
    task.question = undefined;
    task.status = "queued";
    await this.save(task);
    this.enqueue(id);
    return this.get(id);
  }
  async retry(id: string) {
    if (this.closed) {
      throw new Error("Server is shutting down");
    }
    const task = this.records.get(id);
    if (!task || task.deletedAt || !["failed", "cancelled"].includes(task.status) || task.runId) {
      throw new Error("Only failed planning requests can be retried");
    }
    if (this.controllers.has(id)) {
      throw new Error("Planning is still stopping. Retry once cancellation has finished.");
    }
    task.status = "queued";
    task.error = undefined;
    await this.save(task);
    this.enqueue(id);
    return this.get(id);
  }
  async cancel(id: string) {
    const task = this.records.get(id);
    if (!task || task.deletedAt || !["queued", "planning", "needs_input"].includes(task.status)) {
      throw new Error("This task is no longer planning");
    }
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort(new Error("Cancelled by user"));
    }
    task.status = "cancelled";
    task.question = undefined;
    task.error = "Planning stopped.";
    await this.save(task);
    return this.get(id);
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers.values()) {
      controller.abort(new Error("Server closing"));
    }
    await this.queue;
    await Promise.allSettled(this.writes.values());
  }
  async remove(id: string) {
    const task = this.records.get(id);
    if (!task) {
      throw new Error("Task not found");
    }
    if (task.deletedAt) {
      return this.get(id);
    }
    this.assertRemovable(task);
    if (task.runId) {
      await this.removeRun(task.runId);
    } else {
      task.deletedAt = new Date().toISOString();
      await this.save(task);
    }
    return this.get(id);
  }
  private assertRemovable(task: TaskRequest) {
    if (
      this.controllers.has(task.id) ||
      ["queued", "planning", "needs_input"].includes(task.status)
    ) {
      throw new Error("Stop planning before deleting this task");
    }
  }
  async removeRun(id: string) {
    const linked = [...this.records.values()].filter((task) => task.runId === id);
    linked.forEach((task) => this.assertRemovable(task));
    const removed = await this.engine.remove(id);
    for (const task of linked) {
      if (!task.deletedAt) {
        task.deletedAt = removed.deletedAt;
        await this.save(task);
      }
    }
    return removed;
  }
}
