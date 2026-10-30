import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { atomicWrite } from "../../infrastructure/atomic-file.js";
import { addUsage, emptyUsage } from "../execution/budget.js";
import type { UsageTotals, WorkflowRun } from "../../contracts/domain.js";
import type { UsageSession } from "../../contracts/usage-schema.js";
import type { FlowStructure } from "../../sdk/composition-sdk.js";
import {
  MEMORY_ENTRY_LIMIT,
  MEMORY_PAGE_BYTES,
  MEMORY_STATE_BYTES,
  createMemoryEntrySchema,
  updateMemoryEntrySchema,
  deleteMemoryEntrySchema,
  memorySettingsUpdateSchema,
  memoryEntrySchema,
  memoryDescriptionSchema,
  memoryObservationSchema,
  memoryQuerySchema,
  memoryTextSchema,
  rememberStrategySchema,
  strategyMetadataSchema,
  type MemoryEntry,
  type MemoryState,
  type MemoryCatalog,
  type MemoryMutation,
  type MemoryObservation,
  type MemoryQuery,
  type StrategyMetadata,
  type RememberStrategyResult,
} from "../../contracts/memory-schema.js";

const documentSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    activationId: z.string().uuid().nullable(),
    entries: z.array(memoryEntrySchema).max(MEMORY_ENTRY_LIMIT),
    lastCommit: z
      .object({ runId: z.string().uuid(), token: z.string().uuid() })
      .strict()
      .optional(),
    lastDeletion: z
      .object({ key: z.string().regex(/^[a-f0-9]{64}$/), cutoff: z.string() })
      .strict()
      .optional(),
  })
  .strict();
type Document = z.infer<typeof documentSchema>;
const ticketSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().uuid(),
    activationId: z.string().uuid(),
    token: z.string().uuid(),
    approvedAt: z.string(),
    state: z.enum(["enrolled", "prepared", "applied"]),
    contributions: z.array(memoryObservationSchema).max(MEMORY_ENTRY_LIMIT).optional(),
    omitted: z.number().int().nonnegative().default(0),
    skipped: z.number().int().nonnegative().default(0),
    evicted: z.number().int().nonnegative().default(0),
  })
  .strict();
type Ticket = z.infer<typeof ticketSchema>;
export type MemoryTaskContext = { id: string; caseId?: string; caseName?: string };
export type MemoryObservationResult = { changed: boolean; skipped: number; evicted: number };
export type MemoryServices = {
  checkpoint?: (point: "prepared" | "committed" | "receipt" | "deleted") => void | Promise<void>;
};
const deletionSchema = z
  .object({ key: z.string().regex(/^[a-f0-9]{64}$/), cutoff: z.string() })
  .strict();
const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const unchanged = (): MemoryObservationResult => ({ changed: false, skipped: 0, evicted: 0 });
const terminal = (run: WorkflowRun) =>
  run.mode === "live" && ["completed", "failed", "cancelled"].includes(run.status);
const queues = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, action: () => Promise<T>) {
  const promise = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
  queues.set(key, promise);
  try {
    return await promise;
  } finally {
    if (queues.get(key) === promise) queues.delete(key);
  }
}
const observationKey = (value: MemoryObservation) =>
  JSON.stringify([
    value.taskCaseId,
    value.blockId,
    value.model?.provider ?? null,
    value.model?.model ?? null,
    value.model?.thinking ?? null,
  ]);
const clip = (value: string, size: number) =>
  value.length <= size ? value : value.slice(0, size - 1) + "…";

/** Opt-in compact project data. No provider calls or execution/retry authority. */
export class MemoryStore {
  readonly directory: string;
  private readonly filename: string;
  constructor(
    readonly project: string,
    private readonly services: MemoryServices = {},
  ) {
    this.directory = path.join(project, ".workflow", "memory");
    this.filename = path.join(this.directory, "state.json");
  }
  private async contents() {
    try {
      return await readFile(this.filename, "utf8");
    } catch (error) {
      if (absent(error)) return "";
      throw error;
    }
  }
  private async read() {
    const text = await this.contents();
    if (Buffer.byteLength(text) > MEMORY_STATE_BYTES)
      throw new Error("Project memory exceeds its 1 MiB storage limit");
    const document = text
      ? documentSchema.parse(JSON.parse(text))
      : { version: 1 as const, enabled: false, activationId: null, entries: [] };
    return { document, revision: hash(text) };
  }
  private stateOf(document: Document, revision: string): MemoryState {
    return {
      enabled: document.enabled,
      revision,
      limit: MEMORY_ENTRY_LIMIT,
      entries: this.order(document.entries).map((entry) =>
        memoryDescriptionSchema.parse({
          id: entry.id,
          kind: entry.kind,
          title: entry.title,
          description: entry.description,
          tags: entry.tags,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        }),
      ),
    };
  }
  private order(entries: MemoryEntry[]) {
    const rank = { preference: 0, note: 1, strategy: 2, observation: 3 };
    return [...entries].sort(
      (a, b) =>
        rank[a.kind] - rank[b.kind] ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
  }
  async state(): Promise<MemoryState> {
    const current = await this.read();
    return this.stateOf(current.document, current.revision);
  }
  async get(id: string): Promise<MemoryEntry> {
    z.string().uuid().parse(id);
    const entry = (await this.read()).document.entries.find((entry) => entry.id === id);
    if (!entry) throw Object.assign(new Error("Memory entry not found"), { statusCode: 404 });
    return structuredClone(entry);
  }
  async descriptions(value: MemoryQuery = {}): Promise<MemoryCatalog> {
    const query = memoryQuerySchema.parse(value),
      current = await this.read();
    if (!current.document.enabled)
      return {
        enabled: false,
        revision: current.revision,
        entries: [],
        total: 0,
        nextOffset: null,
      };
    const needle = query.query?.trim().toLocaleLowerCase();
    const entries = this.stateOf(current.document, current.revision).entries.filter(
      (entry) =>
        !needle ||
        [entry.title, entry.description, ...entry.tags]
          .join("\n")
          .toLocaleLowerCase()
          .includes(needle),
    );
    const page: MemoryCatalog = {
      enabled: true,
      revision: current.revision,
      entries: [],
      total: entries.length,
      nextOffset: null,
    };
    for (const entry of entries.slice(query.offset, query.offset + query.limit)) {
      const candidate = {
        ...page,
        entries: [...page.entries, entry],
        nextOffset: query.offset + page.entries.length + 1,
      };
      if (Buffer.byteLength(JSON.stringify(candidate)) > MEMORY_PAGE_BYTES) break;
      page.entries.push(entry);
    }
    page.nextOffset =
      query.offset + page.entries.length < entries.length
        ? query.offset + page.entries.length
        : null;
    return page;
  }
  async detail(id: string): Promise<MemoryEntry | null> {
    z.string().uuid().parse(id);
    const current = await this.read();
    if (!current.document.enabled) return null;
    return structuredClone(current.document.entries.find((entry) => entry.id === id) ?? null);
  }
  private async writeLock<T>(action: () => Promise<T>): Promise<T> {
    return serial(this.filename, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await atomicWrite(path.join(this.directory, ".gitignore"), "*\n");
      const release = await lockfile.lock(path.join(this.directory, "owner"), {
        realpath: false,
        lockfilePath: path.join(this.directory, "write-lease"),
        stale: 10_000,
        update: 2000,
        retries: { retries: 100, minTimeout: 100, maxTimeout: 100, randomize: false },
      });
      try {
        return await action();
      } finally {
        await release();
      }
    });
  }
  private assertRevision(actual: string, expected: string) {
    if (actual !== expected)
      throw Object.assign(
        new Error(
          "Project memory changed in another session. Reload before saving; your edits have not been applied.",
        ),
        { statusCode: 409 },
      );
  }
  private async save(document: Document, revision: string, beforePublish?: () => void) {
    const text = JSON.stringify(documentSchema.parse(document), null, 2) + "\n";
    if (Buffer.byteLength(text) > MEMORY_STATE_BYTES)
      throw new Error(
        "Project memory is too large. Shorten or remove entries to stay below 1 MiB.",
      );
    await atomicWrite(this.filename, text, 0o600, async () => {
      this.assertRevision(hash(await this.contents()), revision);
      beforePublish?.();
    });
    return this.stateOf(document, hash(text));
  }
  private ticketFile(runId: string) {
    return path.join(
      this.project,
      ".workflow",
      "runs",
      z.string().uuid().parse(runId),
      "memory-ticket.json",
    );
  }
  private async ticket(runId: string): Promise<Ticket | null> {
    try {
      const ticket = ticketSchema.parse(JSON.parse(await readFile(this.ticketFile(runId), "utf8")));
      if (ticket.runId !== runId) throw new Error("Memory ticket identity mismatch");
      return ticket;
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  }
  private async saveTicket(ticket: Ticket) {
    const filename = this.ticketFile(ticket.runId);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await atomicWrite(filename, JSON.stringify(ticketSchema.parse(ticket)));
  }
  private async deletion(key: string) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(key);
    try {
      const value = deletionSchema.parse(
        JSON.parse(
          await readFile(path.join(this.directory, "deleted-groups", key + ".json"), "utf8"),
        ),
      );
      if (value.key !== key) throw new Error("Memory deletion receipt identity mismatch");
      return value;
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  }
  /** Preserve the receipt before any successor can replace the atomic commit marker. */
  private async finalize(document: Document) {
    if (document.lastCommit) {
      const ticket = await this.ticket(document.lastCommit.runId);
      if (!ticket || ticket.token !== document.lastCommit.token)
        throw new Error("The committed memory observation receipt is missing or changed");
      if (ticket.state !== "applied")
        await this.saveTicket({ ...ticket, state: "applied", contributions: undefined });
    }
    if (document.lastDeletion) {
      const previous = await this.deletion(document.lastDeletion.key);
      if (!previous || previous.cutoff < document.lastDeletion.cutoff) {
        const directory = path.join(this.directory, "deleted-groups");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await atomicWrite(
          path.join(directory, document.lastDeletion.key + ".json"),
          JSON.stringify(document.lastDeletion),
        );
      }
    }
  }
  async setEnabled(value: unknown): Promise<MemoryState> {
    const input = memorySettingsUpdateSchema.parse(value);
    return this.writeLock(async () => {
      const current = await this.read();
      this.assertRevision(current.revision, input.revision);
      await this.finalize(current.document);
      if (current.document.enabled === input.enabled)
        return this.stateOf(current.document, current.revision);
      current.document.enabled = input.enabled;
      current.document.activationId = input.enabled ? randomUUID() : null;
      return this.save(current.document, current.revision);
    });
  }
  async create(value: unknown): Promise<MemoryMutation> {
    const input = createMemoryEntrySchema.parse(value);
    return this.writeLock(async () => {
      const current = await this.read();
      this.assertRevision(current.revision, input.revision);
      await this.finalize(current.document);
      if (current.document.entries.length >= MEMORY_ENTRY_LIMIT)
        throw new Error(
          "Project memory is full (100 entries). Remove an entry before adding another.",
        );
      const now = new Date().toISOString();
      const { revision: _revision, ...fields } = input;
      const entry = memoryEntrySchema.parse({
        ...fields,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        edited: true,
      });
      current.document.entries.push(entry);
      return { state: await this.save(current.document, current.revision), entry };
    });
  }
  async update(id: string, value: unknown): Promise<MemoryMutation> {
    z.string().uuid().parse(id);
    const input = updateMemoryEntrySchema.parse(value);
    return this.writeLock(async () => {
      const current = await this.read();
      this.assertRevision(current.revision, input.revision);
      await this.finalize(current.document);
      const entry = current.document.entries.find((entry) => entry.id === id);
      if (!entry) throw Object.assign(new Error("Memory entry not found"), { statusCode: 404 });
      const { revision: _revision, ...fields } = input;
      Object.assign(entry, fields, { updatedAt: new Date().toISOString(), edited: true });
      return {
        state: await this.save(current.document, current.revision),
        entry: structuredClone(entry),
      };
    });
  }
  /** Management snapshot; strategy preview must not enable or write memory. */
  async strategyForRun(runId: string) {
    z.string().uuid().parse(runId);
    const current = await this.read();
    return {
      state: this.stateOf(current.document, current.revision),
      entry: structuredClone(
        current.document.entries.find(
          (entry) => entry.kind === "strategy" && entry.strategy?.sourceRunId === runId,
        ) ?? null,
      ),
    };
  }
  async rememberStrategy(
    value: unknown,
    rawMetadata: StrategyMetadata,
    assertSource: () => void,
    signal?: AbortSignal,
  ): Promise<RememberStrategyResult> {
    signal?.throwIfAborted();
    const input = rememberStrategySchema.parse(value),
      metadata = strategyMetadataSchema.parse(rawMetadata);
    if (input.sourceRunRevision !== metadata.sourceRunRevision)
      throw Object.assign(
        new Error("Source workflow changed. Review a fresh strategy preview before saving."),
        { statusCode: 409 },
      );
    const fields = memoryTextSchema.parse({
      title: input.title,
      description: input.description,
      details: input.details,
      tags: input.tags,
    });
    return this.writeLock(async () => {
      signal?.throwIfAborted();
      assertSource();
      const current = await this.read();
      const existing = current.document.entries.find(
        (entry) =>
          entry.kind === "strategy" && entry.strategy?.sourceRunId === metadata.sourceRunId,
      );
      if (existing) {
        const saved = memoryTextSchema.parse({
          title: existing.title,
          description: existing.description,
          details: existing.details,
          tags: existing.tags,
        });
        if (
          existing.strategy!.sourceRunRevision !== metadata.sourceRunRevision ||
          JSON.stringify(saved) !== JSON.stringify(fields)
        ) {
          throw Object.assign(
            new Error(
              "This workflow already has a saved strategy with different content. Review and edit the existing entry in Memory settings.",
            ),
            { statusCode: 409 },
          );
        }
        signal?.throwIfAborted();
        assertSource();
        return {
          state: this.stateOf(current.document, current.revision),
          entry: structuredClone(existing),
          reused: true,
        };
      }
      this.assertRevision(current.revision, input.memoryRevision);
      await this.finalize(current.document);
      if (current.document.entries.length >= MEMORY_ENTRY_LIMIT)
        throw new Error(
          "Project memory is full (100 entries). Remove an entry before remembering this approach.",
        );
      const now = new Date().toISOString();
      const entry = memoryEntrySchema.parse({
        ...fields,
        id: randomUUID(),
        kind: "strategy",
        createdAt: now,
        updatedAt: now,
        edited: true,
        strategy: metadata,
      });
      current.document.entries.push(entry);
      const state = await this.save(current.document, current.revision, () => {
        signal?.throwIfAborted();
        assertSource();
      });
      return { state, entry, reused: false };
    });
  }
  async remove(id: string, value: unknown): Promise<MemoryState> {
    z.string().uuid().parse(id);
    const input = deleteMemoryEntrySchema.parse(value);
    return this.writeLock(async () => {
      const current = await this.read();
      this.assertRevision(current.revision, input.revision);
      await this.finalize(current.document);
      const index = current.document.entries.findIndex((entry) => entry.id === id);
      if (index === -1)
        throw Object.assign(new Error("Memory entry not found"), { statusCode: 404 });
      const observation = current.document.entries[index]!.observation;
      // Publish removal and its cutoff atomically. The marker itself remains a
      // durable receipt until finalize copies it to its small per-group file.
      if (observation)
        current.document.lastDeletion = {
          key: hash(observationKey(observation)),
          cutoff: new Date().toISOString(),
        };
      current.document.entries.splice(index, 1);
      const state = await this.save(current.document, current.revision);
      if (observation) {
        await this.services.checkpoint?.("deleted");
        await this.finalize(current.document);
      }
      return state;
    });
  }
  async enroll(run: WorkflowRun): Promise<void> {
    if (run.mode !== "live" || !run.approvedAt || !(await this.read()).document.enabled) return;
    await this.writeLock(async () => {
      const { document } = await this.read();
      if (!document.enabled || !document.activationId) return;
      await this.finalize(document);
      const existing = await this.ticket(run.id);
      if (existing?.state === "applied" || existing?.approvedAt === run.approvedAt) return;
      await this.saveTicket({
        version: 1,
        runId: run.id,
        activationId: document.activationId,
        token: randomUUID(),
        approvedAt: run.approvedAt!,
        state: "enrolled",
        omitted: 0,
        skipped: 0,
        evicted: 0,
      });
    });
  }
  async needsObservation(run: WorkflowRun): Promise<boolean> {
    if (!terminal(run)) return false;
    const { document } = await this.read();
    if (!document.enabled || !document.activationId) return false;
    const ticket = await this.ticket(run.id);
    return !!ticket && ticket.activationId === document.activationId && ticket.state !== "applied";
  }
  async observe(
    run: WorkflowRun,
    sessions: UsageSession[],
    task?: MemoryTaskContext,
  ): Promise<MemoryObservationResult> {
    if (!(await this.needsObservation(run))) return unchanged();
    return this.writeLock(async () => {
      const current = await this.read();
      if (!current.document.enabled || !current.document.activationId) return unchanged();
      await this.finalize(current.document);
      let ticket = await this.ticket(run.id);
      if (
        !ticket ||
        ticket.state === "applied" ||
        ticket.activationId !== current.document.activationId
      )
        return unchanged();
      if (ticket.state === "enrolled") {
        const contributions = observeContributions(run, sessions, task);
        ticket = {
          ...ticket,
          state: "prepared",
          contributions: contributions.slice(0, MEMORY_ENTRY_LIMIT),
          omitted: Math.max(0, contributions.length - MEMORY_ENTRY_LIMIT),
        };
        await this.saveTicket(ticket);
        await this.services.checkpoint?.("prepared");
      }
      let recorded = 0,
        skipped = ticket.omitted,
        evicted = 0;
      for (const contribution of ticket.contributions ?? []) {
        const deletion = await this.deletion(hash(observationKey(contribution)));
        // A later restart cannot resurrect deleted facts from a run that was
        // already enrolled when the user removed this aggregate.
        if (deletion && ticket.approvedAt <= deletion.cutoff) continue;
        const before = structuredClone(current.document.entries);
        const evictedBefore = evicted;
        let entry = current.document.entries.find(
          (entry) =>
            entry.observation && observationKey(entry.observation) === observationKey(contribution),
        );
        if (!entry && current.document.entries.length >= MEMORY_ENTRY_LIMIT) {
          const oldest = current.document.entries
            .filter((entry) => entry.kind === "observation" && !entry.edited)
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))[0];
          if (!oldest) {
            skipped++;
            continue;
          }
          current.document.entries = current.document.entries.filter(
            (entry) => entry.id !== oldest.id,
          );
          evicted++;
        }
        if (!entry) {
          entry = {
            id: randomUUID(),
            kind: "observation",
            ...observationText(contribution),
            tags: [],
            details: "",
            edited: false,
            createdAt: contribution.firstObservedAt,
            updatedAt: contribution.lastObservedAt,
            observation: contribution,
          };
          current.document.entries.push(entry);
        } else entry.observation = mergeObservation(entry.observation!, contribution);
        entry.updatedAt =
          entry.updatedAt > entry.observation!.lastObservedAt
            ? entry.updatedAt
            : entry.observation!.lastObservedAt;
        if (!entry.edited) Object.assign(entry, observationText(entry.observation!));
        if (
          Buffer.byteLength(JSON.stringify(current.document, null, 2)) + 256 >
          MEMORY_STATE_BYTES
        ) {
          current.document.entries = before;
          evicted = evictedBefore;
          skipped++;
          continue;
        }
        recorded++;
      }
      ticket.skipped = skipped;
      ticket.evicted = evicted;
      await this.saveTicket(ticket);
      current.document.lastCommit = { runId: ticket.runId, token: ticket.token };
      await this.save(current.document, current.revision);
      await this.services.checkpoint?.("committed");
      await this.saveTicket({ ...ticket, state: "applied", contributions: undefined });
      await this.services.checkpoint?.("receipt");
      return { changed: recorded > 0, skipped, evicted };
    });
  }
}

function mergeObservation(a: MemoryObservation, b: MemoryObservation): MemoryObservation {
  const counts = <T extends Record<string, number>>(left: T, right: T): T =>
    Object.fromEntries(Object.entries(left).map(([key, value]) => [key, value + right[key]!])) as T;
  const sources = new Map(
    [...a.sources, ...b.sources].map((source) => [
      `${source.runId}/${source.nodeId}/${source.visit}`,
      source,
    ]),
  );
  return {
    ...a,
    runs: a.runs + b.runs,
    visits: a.visits + b.visits,
    sessions: a.sessions + b.sessions,
    runStatuses: counts(a.runStatuses, b.runStatuses),
    outcomes: counts(a.outcomes, b.outcomes),
    sessionStatuses: counts(a.sessionStatuses, b.sessionStatuses),
    checks: counts(a.checks, b.checks),
    dispositions: counts(a.dispositions, b.dispositions),
    usage: addUsage(a.usage, b.usage),
    usageIncomplete: a.usageIncomplete || b.usageIncomplete,
    sources: [...sources.values()]
      .sort((a, b) => b.at.localeCompare(a.at) || b.runId.localeCompare(a.runId))
      .slice(0, 5),
    firstObservedAt: a.firstObservedAt < b.firstObservedAt ? a.firstObservedAt : b.firstObservedAt,
    lastObservedAt: a.lastObservedAt > b.lastObservedAt ? a.lastObservedAt : b.lastObservedAt,
  };
}

function observationText(facts: MemoryObservation) {
  const model = facts.model
    ? `${facts.model.provider}/${facts.model.model} (${facts.model.thinking})`
    : "unattributed execution";
  const coverage = facts.usageIncomplete
    ? "Pricing or attribution is incomplete; zero reported cost does not establish zero cost."
    : "Reported provider usage only; this is not a billing guarantee.";
  return {
    title: clip(`${facts.taskCaseName} · ${facts.blockId} · ${model}`, 100),
    description: clip(
      facts.runs +
        (facts.runs === 1 ? " run, " : " runs, ") +
        facts.visits +
        (facts.visits === 1 ? " visit associated with " : " visits associated with ") +
        model +
        ". " +
        facts.checks.matched +
        "/" +
        facts.checks.total +
        " configured check conditions matched. $" +
        facts.usage.costUsd.toFixed(6) +
        " reported" +
        (facts.usageIncomplete ? "; coverage incomplete" : "") +
        ".",
      300,
    ),
    details: [
      `Task case: ${facts.taskCaseName} (${facts.taskCaseId}). Block: ${facts.blockId}. Model: ${model}.`,
      `Associated run states: ${facts.runStatuses.completed} completed, ${facts.runStatuses.failed} failed, ${facts.runStatuses.cancelled} cancelled.`,
      `Visit outcomes: ${facts.outcomes.pass} pass, ${facts.outcomes.retry} retry, ${facts.outcomes.fail} fail, ${facts.outcomes.interrupted} interrupted. These are execution reports, not verified quality or a model ranking.`,
      `Configured checks: ${facts.checks.matched} matched, ${facts.checks.unmatched} unmatched (${facts.checks.total} total). A configured condition may expect failure. Code or model claims are not additional verified checks.`,
      `Reported dispositions: ${facts.dispositions.workCompleted} work completed, ${facts.dispositions.accepted} accepted, ${facts.dispositions.changesRequested} changes requested, ${facts.dispositions.blocked} blocked.`,
      `Model sessions: ${facts.sessions}; requests: ${facts.usage.requests}; tokens: ${facts.usage.inputTokens} input, ${facts.usage.outputTokens} output, ${facts.usage.cacheReadTokens} cache read, ${facts.usage.cacheWriteTokens} cache write. Reported cost: $${facts.usage.costUsd.toFixed(6)}; unpriced requests: ${facts.usage.unpricedRequests}. ${coverage}`,
      `Observation window: ${facts.firstObservedAt} to ${facts.lastObservedAt}. Only five recent source references are retained; counts cover this aggregate's lifetime.`,
    ]
      .join("\n\n")
      .slice(0, 4000),
  };
}

function savedBlock(run: WorkflowRun, nodeId: string): string {
  const node = run.plan.nodes.find((node) => node.id === nodeId);
  if (!run.program) return node?.block ?? "inline";
  const find = (shape: FlowStructure | undefined): FlowStructure | undefined =>
    !shape ? undefined : shape.id === nodeId ? shape : shape.children.map(find).find(Boolean);
  const reference = find(run.program.structure)?.step?.reference;
  if (typeof reference === "string") return reference;
  if (run.program.composition === "graph" && node && Object.hasOwn(run.program.catalog, node.block))
    return node.block;
  return "inline";
}

/** Deterministic ordinary-run facts only; no copied prompts, results, or source. */
export function observeContributions(
  run: WorkflowRun,
  allSessions: UsageSession[],
  task?: MemoryTaskContext,
): MemoryObservation[] {
  if (!terminal(run)) return [];
  const sessions = [
    ...new Map(
      allSessions
        .filter((session) => session.runId === run.id && session.phase === "execution")
        .map((session) => [session.id, session]),
    ).values(),
  ];
  const attempts = [
    ...new Map(
      run.attempts.map((attempt) => [`${attempt.nodeId}/${attempt.visit}`, attempt]),
    ).values(),
  ];
  const groups = new Map<string, MemoryObservation>();
  for (const attempt of attempts) {
    const related = sessions.filter(
      (session) => session.nodeId === attempt.nodeId && session.visit === attempt.visit,
    );
    const models = new Map<
      string,
      { model: MemoryObservation["model"]; sessions: UsageSession[]; usage: UsageTotals }
    >();
    for (const session of related) {
      const model = {
          provider: session.provider,
          model: session.model,
          thinking: session.thinking,
        },
        key = JSON.stringify(model);
      const group = models.get(key) ?? { model, sessions: [], usage: emptyUsage() };
      group.sessions.push(session);
      group.usage = addUsage(group.usage, session.usage);
      models.set(key, group);
    }
    const ledger = related.reduce((total, session) => addUsage(total, session.usage), emptyUsage());
    const residual = Object.fromEntries(
      Object.keys(ledger).map((key) => [
        key,
        Math.max(
          0,
          (attempt.usage?.[key as keyof UsageTotals] ?? 0) - ledger[key as keyof UsageTotals],
        ),
      ]),
    ) as UsageTotals;
    if (!models.size || Object.values(residual).some((value) => value > 1e-10))
      models.set("unattributed", { model: null, sessions: [], usage: residual });
    for (const model of models.values()) {
      const at = attempt.finishedAt ?? run.updatedAt;
      const contribution: MemoryObservation = {
        taskCaseId: clip(task?.caseId ?? "uncategorized", 128),
        taskCaseName: clip(task?.caseName ?? "Uncategorized task", 200),
        blockId: clip(savedBlock(run, attempt.nodeId), 128),
        model: model.model,
        runs: 1,
        runStatuses: { completed: 0, failed: 0, cancelled: 0 },
        visits: 1,
        outcomes: { pass: 0, retry: 0, fail: 0, interrupted: 0 },
        sessions: model.sessions.length,
        sessionStatuses: { running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 },
        checks: {
          total: attempt.checks.length,
          matched: attempt.checks.filter((check) => check.matched).length,
          unmatched: attempt.checks.filter((check) => !check.matched).length,
        },
        dispositions: { workCompleted: 0, accepted: 0, changesRequested: 0, blocked: 0 },
        usage: model.usage,
        usageIncomplete:
          !model.model ||
          model.usage.unpricedRequests > 0 ||
          model.sessions.some(
            (session) =>
              session.pricing.source === "unknown" ||
              ["running", "interrupted"].includes(session.status),
          ),
        sources: [
          { runId: run.id, nodeId: attempt.nodeId, visit: attempt.visit, taskId: task?.id, at },
        ],
        firstObservedAt: at,
        lastObservedAt: at,
      };
      contribution.runStatuses[run.status as "completed" | "failed" | "cancelled"] = 1;
      contribution.outcomes[attempt.result?.outcome ?? "interrupted"] = 1;
      for (const session of model.sessions) contribution.sessionStatuses[session.status]++;
      const disposition = attempt.result?.disposition;
      if (disposition)
        contribution.dispositions[
          (
            {
              "work-completed": "workCompleted",
              accepted: "accepted",
              "changes-requested": "changesRequested",
              blocked: "blocked",
            } as const
          )[disposition]
        ]++;
      const key = observationKey(contribution),
        previous = groups.get(key);
      if (previous) {
        const merged = mergeObservation(previous, contribution);
        // Multiple visits in one run contribute one run to this aggregate.
        merged.runs = 1;
        merged.runStatuses = contribution.runStatuses;
        groups.set(key, merged);
      } else groups.set(key, contribution);
    }
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => memoryObservationSchema.parse(value));
}
