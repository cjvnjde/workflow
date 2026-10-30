import { z } from "zod";
import { addUsage, emptyUsage } from "../execution/budget.js";
import {
  resolveAgentSettings,
  type UsageTotals,
  type WorkflowRun,
} from "../../contracts/domain.js";
import type { UsageSession } from "../../contracts/usage-schema.js";
import type { FlowStructure } from "../../sdk/composition-sdk.js";
import type { MemoryStore, MemoryTaskContext } from "../memory/memory-store.js";
import {
  memoryTextSchema,
  strategyMetadataSchema,
  strategyModelHintSchema,
  strategyPreviewSchema,
  type StrategyMetadata,
  type StrategyModelHint,
  type StrategyPreview,
  type StrategyRole,
} from "../../contracts/memory-schema.js";

const clip = (text: string, length: number) =>
  text.length <= length ? text : text.slice(0, length - 1) + "…";
const modelKey = (model: StrategyModelHint) =>
  JSON.stringify([model.provider, model.model, model.thinking]);
const unique = (models: StrategyModelHint[]) => [
  ...new Map(models.map((model) => [modelKey(model), model])).values(),
];
const residual = (a: UsageTotals, b: UsageTotals): UsageTotals =>
  Object.fromEntries(
    Object.keys(a).map((key) => [
      key,
      Math.max(0, a[key as keyof UsageTotals] - b[key as keyof UsageTotals]),
    ]),
  ) as UsageTotals;
const hasUsage = (usage: UsageTotals) => Object.values(usage).some((value) => value > 1e-10);

export function assertStrategyRun(run: WorkflowRun, revision?: number) {
  z.string().uuid().parse(run.id);
  if (run.deletedAt || run.status !== "completed")
    throw Object.assign(new Error("Remember an approach from a completed, available workflow."), {
      statusCode: 409,
    });
  if (revision !== undefined && run.revision !== revision)
    throw Object.assign(
      new Error("Source workflow changed. Review a fresh strategy preview before saving."),
      { statusCode: 409 },
    );
}

function reference(run: WorkflowRun, nodeId: string): string | null {
  const node = run.plan.nodes.find((node) => node.id === nodeId);
  if (!run.program) return node?.block ?? null;
  const find = (shape?: FlowStructure): FlowStructure | undefined =>
    !shape ? undefined : shape.id === nodeId ? shape : shape.children.map(find).find(Boolean);
  const value = find(run.program.structure)?.step?.reference;
  if (typeof value === "string") return value;
  return run.program.composition === "graph" &&
    node &&
    Object.hasOwn(run.program.catalog, node.block)
    ? node.block
    : null;
}

/** Bounded factual hints, never an executable graph or model-quality rating. */
export function strategyMetadata(
  run: WorkflowRun,
  ledger: UsageSession[],
  task?: MemoryTaskContext,
): StrategyMetadata {
  assertStrategyRun(run);
  const sessions = [
    ...new Map(
      ledger
        .filter((session) => session.runId === run.id && session.phase === "execution")
        .map((session) => [session.id, session]),
    ).values(),
  ];
  const attempts = [
    ...new Map(
      run.attempts.map((attempt) => [attempt.nodeId + "/" + attempt.visit, attempt]),
    ).values(),
  ];
  const attemptedIds = new Set(attempts.map((attempt) => attempt.nodeId));
  const nodes = run.plan.nodes.filter((node) => attemptedIds.has(node.id));
  const outcomes = { pass: 0, retry: 0, fail: 0, interrupted: 0 };
  const dispositions = { workCompleted: 0, accepted: 0, changesRequested: 0, blocked: 0 };
  const checks = { total: 0, matched: 0, unmatched: 0 };
  const ledgerUsage = sessions.reduce((sum, session) => addUsage(sum, session.usage), emptyUsage());
  let legacy = emptyUsage();
  let usageIncomplete =
    run.mode === "demo" ||
    run.executionProtocol !== 2 ||
    sessions.some(
      (session) =>
        !session.nodeId ||
        !session.visit ||
        session.pricing.source === "unknown" ||
        session.usage.unpricedRequests > 0 ||
        ["running", "interrupted"].includes(session.status),
    );
  for (const attempt of attempts) {
    outcomes[attempt.result?.outcome ?? "interrupted"]++;
    const disposition = attempt.result?.disposition;
    if (disposition)
      dispositions[
        (
          {
            "work-completed": "workCompleted",
            accepted: "accepted",
            "changes-requested": "changesRequested",
            blocked: "blocked",
          } as const
        )[disposition]
      ]++;
    checks.total += attempt.checks.length;
    checks.matched += attempt.checks.filter((check) => check.matched).length;
    checks.unmatched += attempt.checks.filter((check) => !check.matched).length;
    const known = sessions
      .filter((session) => session.nodeId === attempt.nodeId && session.visit === attempt.visit)
      .reduce((sum, session) => addUsage(sum, session.usage), emptyUsage());
    const extra = residual(attempt.usage ?? emptyUsage(), known);
    legacy = addUsage(legacy, extra);
    const node = run.plan.nodes.find((node) => node.id === attempt.nodeId);
    if (!known.requests && !run.blocks[node?.block ?? ""]?.definition.executor)
      usageIncomplete = true;
  }
  // Match UsageStore reconciliation: sessions without attempt identities can
  // already cover compatibility totals; retain only the remaining residual.
  const unattributed = sessions
    .filter((session) => !session.nodeId || !session.visit)
    .reduce((sum, session) => addUsage(sum, session.usage), emptyUsage());
  legacy = residual(legacy, unattributed);
  legacy = addUsage(legacy, residual(run.usage ?? emptyUsage(), addUsage(ledgerUsage, legacy)));
  const usage = addUsage(ledgerUsage, legacy);
  if (hasUsage(legacy)) usageIncomplete = true;
  const allModelKeys = new Set(
    sessions.map((session) => JSON.stringify([session.provider, session.model, session.thinking])),
  );
  const observed = unique(
    sessions.flatMap((session) => {
      const parsed = strategyModelHintSchema.safeParse({
        provider: session.provider,
        model: session.model,
        thinking: session.thinking,
        source: "observed",
      });
      return parsed.success ? [parsed.data] : [];
    }),
  );
  const configured: StrategyModelHint[] = [];
  const allRoles: StrategyRole[] = nodes.map((node) => {
    const bundle = run.blocks[node.block];
    const participating = sessions.filter((session) => session.nodeId === node.id);
    const roleModelKeys = new Set(
      participating.map((session) =>
        JSON.stringify([session.provider, session.model, session.thinking]),
      ),
    );
    const models = unique(
      participating.flatMap((session) => {
        const parsed = strategyModelHintSchema.safeParse({
          provider: session.provider,
          model: session.model,
          thinking: session.thinking,
          source: "observed",
        });
        return parsed.success ? [parsed.data] : [];
      }),
    );
    if (!participating.length && bundle && !bundle.definition.executor) {
      const settings = resolveAgentSettings(run.config.agent, bundle.definition.agent, node.agent);
      if (settings.provider && settings.model) {
        const key = JSON.stringify([settings.provider, settings.model, settings.thinking]);
        roleModelKeys.add(key);
        allModelKeys.add(key);
      }
      const parsed = strategyModelHintSchema.safeParse({
        provider: settings.provider,
        model: settings.model,
        thinking: settings.thinking,
        source: "configured",
      });
      if (parsed.success) {
        models.push(parsed.data);
        configured.push(parsed.data);
      }
    }
    return {
      nodeId: clip(node.id, 128),
      label: clip(node.label, 100),
      blockId: reference(run, node.id),
      executionKind: bundle?.definition.executor?.kind ?? "agent",
      visits: attempts.filter((attempt) => attempt.nodeId === node.id).length,
      modelHints: models.slice(0, 4),
      omittedModelHints: Math.max(0, roleModelKeys.size - Math.min(4, models.length)),
    };
  });
  // Prefer actual observed use when a static configured hint names the same model.
  const observedKeys = new Set(observed.map(modelKey));
  const models = [
    ...observed,
    ...unique(configured).filter((model) => !observedKeys.has(modelKey(model))),
  ];
  return strategyMetadataSchema.parse({
    version: 1,
    sourceRunId: run.id,
    sourceRunRevision: run.revision,
    sourceTaskId: task?.id,
    taskType: {
      id: clip(task?.caseId ?? "uncategorized", 128),
      name: clip(task?.caseName ?? "Uncategorized task", 200),
    },
    mode: run.mode,
    completedAt: run.updatedAt,
    roles: allRoles.slice(0, 12),
    omittedRoles: Math.max(0, attemptedIds.size - Math.min(allRoles.length, 12)),
    models: models.slice(0, 12),
    omittedModels: Math.max(0, allModelKeys.size - Math.min(12, models.length)),
    outcomes,
    dispositions,
    checks,
    usage,
    usageIncomplete,
  });
}

function suggestedText(metadata: StrategyMetadata) {
  const roleCount = metadata.roles.length + metadata.omittedRoles;
  return memoryTextSchema.parse({
    title: clip(
      (metadata.taskType.id === "uncategorized" ? "Reusable workflow" : metadata.taskType.name) +
        " approach",
      100,
    ),
    description: clip(
      "Consider this role separation for " +
        metadata.taskType.name.toLowerCase() +
        " work; adapt the " +
        roleCount +
        (roleCount === 1 ? " role" : " roles") +
        ", checks and model choices to the new request.",
      300,
    ),
    details: [
      "Compose a fresh workflow for the new request. Use this approach as guidance, not an executable template.",
      metadata.roles.length
        ? "Consider these previously used roles where relevant:\n" +
          metadata.roles
            .map(
              (role) =>
                "- " +
                role.label +
                (role.blockId ? " (previously used block: " + role.blockId + ")" : ""),
            )
            .join("\n")
        : "Choose explicit implementation, checking and review roles appropriate to the new request.",
      metadata.omittedRoles ? "Additional source roles were omitted from this compact note." : "",
      "Inspect current reusable block definitions before relying on their inputs and outputs. Keep handoffs focused and pass only what each role needs.",
      "Choose currently available models for each role and budget. Recorded model choices are optional historical hints, not mandatory selections or evidence of model quality.",
      "Apply the current project's checks and approval rules. Prior completion or an accepted disposition is a reported outcome, not proof that the approach is correct for another task.",
      metadata.mode === "demo"
        ? "The source workflow was a demo simulation. Its outcomes do not establish real project validation."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 4000),
    tags: ["workflow-strategy"],
  });
}

export async function previewStrategy(
  memory: MemoryStore,
  run: WorkflowRun,
  sessions: UsageSession[],
  task?: MemoryTaskContext,
  signal?: AbortSignal,
): Promise<StrategyPreview> {
  signal?.throwIfAborted();
  assertStrategyRun(run);
  const snapshot = await memory.strategyForRun(run.id);
  signal?.throwIfAborted();
  const metadata = snapshot.entry?.strategy ?? strategyMetadata(run, sessions, task);
  const entry = snapshot.entry
    ? memoryTextSchema.parse({
        title: snapshot.entry.title,
        description: snapshot.entry.description,
        details: snapshot.entry.details,
        tags: snapshot.entry.tags,
      })
    : suggestedText(metadata);
  return strategyPreviewSchema.parse({
    sourceRunId: run.id,
    sourceRunRevision: run.revision,
    memoryRevision: snapshot.state.revision,
    memoryEnabled: snapshot.state.enabled,
    entry,
    metadata,
    existingEntry: snapshot.entry,
  });
}
