import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "../../infrastructure/atomic-file.js";
import { addUsage, emptyUsage } from "../execution/budget.js";
import { loadUsage } from "./attempt-store.js";
import {
  runSchema,
  usageSchema,
  type UsageTotals,
  type WorkflowRun,
} from "../../contracts/domain.js";
import {
  usageReportSchema,
  usageScopeSchema,
  usageSessionSchema,
  type AccountingContext,
  type UsagePhase,
  type UsageReport,
  type UsageScope,
  type UsageSession,
} from "../../contracts/usage-schema.js";

const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const id = (value: string) => z.string().uuid().parse(value);
const queues = new Map<string, Promise<unknown>>();
const gates = new Map<string, Promise<void>>();
const maximum = (a: UsageTotals, b: UsageTotals): UsageTotals =>
  Object.fromEntries(
    Object.keys(a).map((key) => [
      key,
      Math.max(a[key as keyof UsageTotals], b[key as keyof UsageTotals]),
    ]),
  ) as UsageTotals;
const residual = (a: UsageTotals, b: UsageTotals): UsageTotals =>
  Object.fromEntries(
    Object.keys(a).map((key) => [
      key,
      Math.max(0, a[key as keyof UsageTotals] - b[key as keyof UsageTotals]),
    ]),
  ) as UsageTotals;
const hasUsage = (value: UsageTotals) => Object.values(value).some((number) => number > 1e-10);
async function entries(directory: string) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
}

async function serial<T>(key: string, action: () => Promise<T>) {
  const result = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
  queues.set(key, result);
  try {
    return await result;
  } finally {
    if (queues.get(key) === result) queues.delete(key);
  }
}

/** Serialize only constrained model sessions, never an enclosing planning job. */
async function acquireGate(key: string, signal: AbortSignal) {
  const previous = gates.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const holding = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const queued = previous.then(() => holding);
  gates.set(key, queued);
  const release = () => {
    void previous.then(unlock, unlock);
    if (gates.get(key) === queued)
      void queued.then(() => {
        if (gates.get(key) === queued) gates.delete(key);
      });
  };
  let abort!: () => void;
  try {
    signal.throwIfAborted();
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
    signal.throwIfAborted();
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Durable usage is independent of task deletion, activity truncation, and AI cwd. */
export class UsageStore {
  readonly directory: string;
  constructor(readonly project: string) {
    this.directory = path.join(project, ".workflow", "usage");
  }
  private scopeFile(scopeId: string) {
    return path.join(this.directory, "scopes", `${id(scopeId)}.json`);
  }
  private sessionFile(sessionId: string) {
    return path.join(this.directory, "sessions", `${id(sessionId)}.json`);
  }
  private async prepare() {
    await Promise.all([
      mkdir(path.join(this.directory, "scopes"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(this.directory, "sessions"), { recursive: true, mode: 0o700 }),
    ]);
    await atomicWrite(path.join(this.directory, ".gitignore"), "*\n");
  }
  async scopes(): Promise<UsageScope[]> {
    return Promise.all(
      (await entries(path.join(this.directory, "scopes")))
        .filter((name) => /^[\da-f-]{36}\.json$/.test(name))
        .map(async (name) =>
          usageScopeSchema.parse(
            JSON.parse(await readFile(path.join(this.directory, "scopes", name), "utf8")),
          ),
        ),
    );
  }
  async getScope(scopeId: string) {
    return usageScopeSchema.parse(JSON.parse(await readFile(this.scopeFile(scopeId), "utf8")));
  }
  async raiseScopeLimit(scopeId: string, maximum: number) {
    z.number().positive().parse(maximum);
    return serial(this.scopeFile(scopeId), async () => {
      const scope = await this.getScope(scopeId);
      if (scope.maxCostUsd !== undefined && maximum < scope.maxCostUsd)
        throw new Error("A resumed spending limit cannot be lower than the captured limit.");
      scope.maxCostUsd = maximum;
      await atomicWrite(this.scopeFile(scopeId), JSON.stringify(scope));
      return scope;
    });
  }
  async ensureScope(input: {
    id?: string;
    owner: UsageScope["owner"];
    maxCostUsd?: number;
    taskId?: string;
    runId?: string;
  }) {
    const scopeId = input.id ?? input.owner.id;
    return serial(this.scopeFile(scopeId), async () => {
      await this.prepare();
      let scope: UsageScope;
      try {
        scope = await this.getScope(scopeId);
      } catch (error) {
        if (!absent(error)) throw error;
        scope = usageScopeSchema.parse({
          id: scopeId,
          owner: input.owner,
          maxCostUsd: input.maxCostUsd,
          createdAt: new Date().toISOString(),
        });
      }
      if (input.taskId && !scope.taskIds.includes(input.taskId))
        scope.taskIds.push(id(input.taskId));
      if (input.runId && !scope.runIds.includes(input.runId)) scope.runIds.push(id(input.runId));
      if (input.runId && input.taskId) scope.runTasks[input.runId] = input.taskId;
      await atomicWrite(this.scopeFile(scope.id), JSON.stringify(scope));
      return scope;
    });
  }
  async scopeForRun(runId: string) {
    return (await this.scopes()).find(
      (scope) =>
        scope.runIds.includes(runId) || (scope.owner.kind === "run" && scope.owner.id === runId),
    );
  }
  async scopeForTask(taskId: string) {
    return (await this.scopes()).find(
      (scope) =>
        scope.taskIds.includes(taskId) ||
        (scope.owner.kind === "task" && scope.owner.id === taskId),
    );
  }
  async ensureRun(run: WorkflowRun, scopeId?: string, taskId?: string) {
    const existing = scopeId ? await this.getScope(scopeId) : await this.scopeForRun(run.id);
    return this.ensureScope({
      id: existing?.id,
      owner: existing?.owner ?? { kind: "run", id: run.id },
      maxCostUsd: existing?.maxCostUsd ?? run.config.budget?.maxTaskCostUsd,
      runId: run.id,
      taskId,
    });
  }
  async sessions() {
    return Promise.all(
      (await entries(path.join(this.directory, "sessions")))
        .filter((name) => /^[\da-f-]{36}\.json$/.test(name))
        .map(async (name) => {
          const session = usageSessionSchema.parse(
            JSON.parse(await readFile(path.join(this.directory, "sessions", name), "utf8")),
          );
          if (session.status === "running" && session.pid) {
            try {
              process.kill(session.pid, 0);
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ESRCH")
                session.status = "interrupted";
            }
          }
          return session;
        }),
    );
  }
  private async runs(selectedIds?: string[]) {
    const runs: WorkflowRun[] = [];
    for (const runId of selectedIds ??
      (await entries(path.join(this.project, ".workflow", "runs")))) {
      if (!z.string().uuid().safeParse(runId).success) continue;
      try {
        runs.push(
          runSchema.parse(
            JSON.parse(
              await readFile(
                path.join(this.project, ".workflow", "runs", runId, "run.json"),
                "utf8",
              ),
            ),
          ),
        );
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }
    return runs;
  }
  private async legacyExecution(run: WorkflowRun, sessions: UsageSession[]) {
    const attempts = new Map(
      run.attempts.map((attempt) => [
        `${attempt.nodeId}-${attempt.visit}`,
        attempt.usage ?? emptyUsage(),
      ]),
    );
    const root = path.join(this.project, ".workflow", "runs", run.id, "attempts");
    for (const name of await entries(root))
      if (/^[a-z][a-z0-9-]*-\d+$/.test(name)) {
        attempts.set(
          name,
          maximum(attempts.get(name) ?? emptyUsage(), await loadUsage(path.join(root, name))),
        );
      }
    let legacy = emptyUsage();
    for (const [key, reported] of attempts) {
      const matched = sessions
        .filter(
          (session) =>
            session.nodeId && session.visit && `${session.nodeId}-${session.visit}` === key,
        )
        .reduce((sum, session) => addUsage(sum, session.usage), emptyUsage());
      legacy = addUsage(legacy, residual(reported, matched));
    }
    // Older integrations may supply a run without an attempt identity. Their
    // usage can only be reconciled against the aggregate compatibility total.
    const unattributed = sessions
      .filter((session) => !session.nodeId || !session.visit)
      .reduce((sum, session) => addUsage(sum, session.usage), emptyUsage());
    legacy = residual(legacy, unattributed);
    const ledger = sessions.reduce((sum, session) => addUsage(sum, session.usage), emptyUsage());
    // Some old snapshots have only run-level totals; retain that residual too.
    return addUsage(legacy, residual(run.usage ?? emptyUsage(), addUsage(ledger, legacy)));
  }
  async report(
    filter: { scopeId?: string; taskId?: string; runId?: string; limit?: number } = {},
  ): Promise<UsageReport> {
    const [allScopes, allSessions] = await Promise.all([this.scopes(), this.sessions()]);
    const scope = allScopes.find((scope) =>
      filter.scopeId
        ? scope.id === filter.scopeId
        : filter.taskId
          ? scope.taskIds.includes(filter.taskId) ||
            (scope.owner.kind === "task" && scope.owner.id === filter.taskId)
          : filter.runId
            ? scope.runIds.includes(filter.runId) ||
              (scope.owner.kind === "run" && scope.owner.id === filter.runId)
            : false,
    );
    if (filter.scopeId && !scope) throw new Error("Usage scope not found");
    const filtered = !!(filter.scopeId || filter.taskId || filter.runId);
    let historicalRunId: string | undefined;
    if (filter.taskId && !scope) {
      try {
        historicalRunId = z
          .object({ runId: z.string().uuid().optional() })
          .parse(
            JSON.parse(
              await readFile(
                path.join(this.project, ".workflow", "tasks", `${id(filter.taskId)}.json`),
                "utf8",
              ),
            ),
          ).runId;
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }
    const sessions = allSessions.filter(
      (session) =>
        !filtered ||
        (scope
          ? session.scopeId === scope.id
          : (!!(filter.runId ?? historicalRunId) &&
              session.runId === (filter.runId ?? historicalRunId)) ||
            (!!filter.taskId && session.taskId === filter.taskId)),
    );
    // A budgeted model call must not parse unrelated approved source snapshots.
    const selectedRunIds = scope
      ? scope.runIds
      : [filter.runId ?? historicalRunId].filter((value): value is string => !!value);
    const runs = await this.runs(filtered ? selectedRunIds : undefined);
    let total = sessions.reduce((sum, session) => addUsage(sum, session.usage), emptyUsage());
    let legacyExecution = emptyUsage();
    for (const run of runs) {
      legacyExecution = addUsage(
        legacyExecution,
        await this.legacyExecution(
          run,
          sessions.filter((session) => session.phase === "execution" && session.runId === run.id),
        ),
      );
    }
    total = addUsage(total, legacyExecution);
    const phases = new Map<
      UsagePhase,
      { phase: UsagePhase; usage: UsageTotals; sessionCount: number }
    >();
    const models = new Map<
      string,
      { provider: string; model: string; usage: UsageTotals; sessionCount: number }
    >();
    for (const session of sessions) {
      const phase = phases.get(session.phase) ?? {
        phase: session.phase,
        usage: emptyUsage(),
        sessionCount: 0,
      };
      phase.usage = addUsage(phase.usage, session.usage);
      phase.sessionCount++;
      phases.set(session.phase, phase);
      const key = `${session.provider}/${session.model}`;
      const model = models.get(key) ?? {
        provider: session.provider,
        model: session.model,
        usage: emptyUsage(),
        sessionCount: 0,
      };
      model.usage = addUsage(model.usage, session.usage);
      model.sessionCount++;
      models.set(key, model);
    }
    if (hasUsage(legacyExecution)) {
      const phase = phases.get("execution") ?? {
        phase: "execution" as const,
        usage: emptyUsage(),
        sessionCount: 0,
      };
      phase.usage = addUsage(phase.usage, legacyExecution);
      phases.set("execution", phase);
    }
    const warnings: string[] = [];
    if (total.unpricedRequests)
      warnings.push(
        `${total.unpricedRequests} reported requests have unknown pricing; their cost is not included in the known dollar total.`,
      );
    if (sessions.some((session) => session.status === "running"))
      warnings.push(
        "Model requests are still in flight; their final usage may not be reported yet.",
      );
    if (sessions.some((session) => session.status === "interrupted"))
      warnings.push(
        "Interrupted model sessions retain reported usage; unreported provider charges may be missing.",
      );
    const historical = runs.some(
      (run) => !allScopes.some((scope) => scope.runIds.includes(run.id)),
    );
    if (historical || hasUsage(legacyExecution))
      warnings.push(
        "Earlier execution or custom-runner usage is included without model-session attribution. Historical planning costs may be unavailable.",
      );
    const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
    const incomplete =
      total.unpricedRequests > 0 ||
      sessions.some((session) => ["running", "interrupted"].includes(session.status)) ||
      historical ||
      hasUsage(legacyExecution);
    return usageReportSchema.parse({
      scope: scope
        ? scope.owner
        : filter.taskId
          ? { kind: "task", id: filter.taskId }
          : filter.runId
            ? { kind: "run", id: filter.runId }
            : { kind: "project" },
      total,
      phases: [...phases.values()],
      models: [...models.values()],
      sessions: sessions.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit),
      sessionCount: sessions.length,
      sessionsTruncated: sessions.length > limit,
      legacyExecution,
      limits: {
        totalCostUsd: scope?.maxCostUsd,
        executionCostUsd: filter.runId
          ? runs.find((run) => run.id === filter.runId)?.config.budget?.maxCostUsd
          : undefined,
        remainingCostUsd:
          scope?.maxCostUsd === undefined || incomplete
            ? null
            : Math.max(0, scope.maxCostUsd - total.costUsd),
      },
      incomplete,
      warnings,
    });
  }
  async beginSession(
    context: AccountingContext,
    model: Pick<UsageSession, "provider" | "model" | "thinking" | "pricing">,
    signal: AbortSignal,
  ) {
    const scope = await this.getScope(context.scopeId);
    const release =
      scope.maxCostUsd === undefined
        ? () => {}
        : await acquireGate(this.scopeFile(scope.id), signal);
    try {
      signal.throwIfAborted();
      const report =
        scope.maxCostUsd === undefined ? undefined : await this.report({ scopeId: scope.id });
      if (report?.total.unpricedRequests)
        throw new Error(
          "Cannot enforce the total spending limit because earlier requests have unknown pricing.",
        );
      const remainingCostUsd =
        scope.maxCostUsd === undefined
          ? undefined
          : Math.max(0, scope.maxCostUsd - report!.total.costUsd);
      if (remainingCostUsd !== undefined && remainingCostUsd <= 0)
        throw new Error(
          "Total spending limit reached. Reported planning, execution and retries remain included.",
        );
      if (remainingCostUsd !== undefined && model.pricing.source === "unknown")
        throw new Error("Cannot enforce a total dollar budget without model pricing.");
      const now = new Date().toISOString();
      const { project: _project, ...metadata } = context;
      let record = usageSessionSchema.parse({
        ...metadata,
        ...model,
        id: randomUUID(),
        status: "running",
        startedAt: now,
        updatedAt: now,
        usage: emptyUsage(),
        pid: process.pid,
      });
      await this.prepare();
      await atomicWrite(this.sessionFile(record.id), JSON.stringify(record));
      const write = async () => {
        record.updatedAt = new Date().toISOString();
        await atomicWrite(
          this.sessionFile(record.id),
          JSON.stringify(usageSessionSchema.parse(record)),
        );
      };
      return {
        id: record.id,
        remainingCostUsd,
        update: async (usage: UsageTotals) => {
          const next = usageSchema.parse(usage);
          if (
            Object.keys(next).some(
              (key) =>
                next[key as keyof UsageTotals] + 1e-10 < record.usage[key as keyof UsageTotals],
            )
          )
            throw new Error("Cumulative model usage cannot decrease.");
          record.usage = next;
          await write();
        },
        finish: async (status: Exclude<UsageSession["status"], "running">, error?: string) => {
          record = {
            ...record,
            status,
            endedAt: new Date().toISOString(),
            error: error?.slice(0, 2000),
          };
          await write();
        },
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }
}

export async function createAccountingContext(
  project: string,
  phase: UsagePhase,
  options: Partial<Omit<AccountingContext, "project" | "phase">> & {
    owner?: UsageScope["owner"];
    maxCostUsd?: number;
  } = {},
): Promise<AccountingContext> {
  const store = new UsageStore(project);
  const owner = options.owner ?? { kind: "operation" as const, id: randomUUID() };
  const scope = options.scopeId
    ? await store.getScope(options.scopeId)
    : await store.ensureScope({
        owner,
        maxCostUsd: options.maxCostUsd,
        taskId: options.taskId,
        runId: options.runId,
      });
  const { owner: _owner, maxCostUsd: _max, ...metadata } = options;
  return {
    ...metadata,
    project,
    phase,
    scopeId: scope.id,
    operationId: options.operationId ?? `${phase}:${randomUUID()}`,
  };
}
