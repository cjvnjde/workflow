import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "./atomic-file.js";
import { loadLibrary } from "./library.js";
import { loadOrchestration, saveOrchestration } from "./orchestration-settings.js";
import { executionSettings, updateExecutionSettings } from "./project-model.js";
import { LibraryProposals, libraryHash } from "./library-proposals.js";
import { availableModels } from "./available-models.js";
import { designSettings, validateDesign } from "./settings-designer.js";
import { designMessageSchema, designScopeSchema, designSessionSchema, designTurnSchema, type DesignSession, type DesignScope } from "./design-schema.js";

export class DesignChats {
  private readonly sessions = new Map<string, DesignSession>();
  private readonly jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly applying = new Set<string>();
  private closed = false;
  constructor(private readonly project: string, private readonly catalog = availableModels, private readonly designer = designSettings, private readonly proposals = new LibraryProposals(project)) {}
  private filename(id: string) { return path.join(this.project, ".workflow", "design-chats", `${z.string().uuid().parse(id)}.json`); }
  async initialize() {
    const directory = path.dirname(this.filename(randomUUID()));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(directory, ".gitignore"), "*\n");
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) { continue; }
      const session = designSessionSchema.parse(JSON.parse(await readFile(path.join(directory, name), "utf8")));
      if (name !== `${session.id}.json`) { throw new Error("Design chat identity does not match its storage path"); }
      this.sessions.set(session.id, session);
      if (session.status === "working") { session.status = "failed"; session.error = "The server stopped while designing. Send a message to continue."; await this.save(session); }
    }
  }
  private async save(session: DesignSession) {
    session.revision++; session.updatedAt = new Date().toISOString();
    await atomicWrite(this.filename(session.id), JSON.stringify(designSessionSchema.parse(session)));
  }
  get(id: string) { const value = this.sessions.get(id); if (!value) { throw new Error("Design conversation not found"); } return structuredClone(value); }
  latest(scope: DesignScope) { const latest = [...this.sessions.values()].filter((item) => item.scope === scope).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; return latest ? this.get(latest.id) : null; }
  async create(value: unknown) {
    if (this.closed) { throw new Error("Server is shutting down"); }
    const { scope } = z.object({ scope: designScopeSchema }).strict().parse(value);
    const now = new Date().toISOString();
    const session = designSessionSchema.parse({ id: randomUUID(), scope, createdAt: now, updatedAt: now, revision: 0, status: "idle", messages: [] });
    await this.save(session); this.sessions.set(session.id, session); return this.get(session.id);
  }
  private async snapshot(signal: AbortSignal) {
    const [library, orchestration, execution, catalog] = await Promise.all([loadLibrary(this.project), loadOrchestration(this.project), executionSettings(this.project), this.catalog(signal)]);
    return { library, orchestration, execution, models: catalog.models,
      base: { library: libraryHash(library), orchestration: orchestration.revision, config: execution.configRevision } };
  }
  async send(id: string, value: unknown) {
    const input = designTurnSchema.parse(value);
    const session = this.sessions.get(id);
    if (this.closed) { throw new Error("Server is shutting down"); }
    if (!session || session.revision !== input.revision || this.jobs.has(id) || this.applying.has(id)) { throw new Error("This conversation changed or is busy. Wait for the latest reply."); }
    if (session.messages.length >= 78 || session.messages.reduce((size, item) => size + item.content.length, input.message.length) > 160_000) { throw new Error("Start a new design conversation to keep the context focused."); }
    const previous = session.status === "applied" ? undefined : session.proposal;
    if (session.status === "applied") { session.proposal = undefined; session.base = undefined; session.libraryProposalId = undefined; }
    session.status = "working"; session.error = undefined; session.text = ""; session.activity = "Reading your request…";
    session.messages.push({ role: "user", content: input.message, time: new Date().toISOString() });
    const controller = new AbortController();
    // Claim the conversation synchronously, before any disk or model work.
    const completion = Promise.withResolvers<void>();
    const job = { controller, done: completion.promise };
    this.jobs.set(id, job);
    try { await this.save(session); } catch (error) { this.jobs.delete(id); session.status = "failed"; completion.resolve(); throw error; }
    void (async () => {
      let finished: DesignSession;
      try {
        controller.signal.throwIfAborted();
        const snapshot = await this.snapshot(controller.signal);
        controller.signal.throwIfAborted();
        const result = await this.designer({ project: this.project, scope: session.scope, library: snapshot.library, settings: snapshot.orchestration.settings,
          models: snapshot.models, messages: structuredClone(session.messages), previous, signal: controller.signal,
          emit: (kind, message) => {
            if (controller.signal.aborted) { return; }
            if (kind === "text_delta") { session.text = (session.text + message).slice(-8000); }
            else if (kind !== "usage") { session.activity = message.slice(0, 1000); }
          },
        });
        controller.signal.throwIfAborted();
        const proposal = result.proposal ? validateDesign(result.proposal, { scope: session.scope, library: snapshot.library, settings: snapshot.orchestration.settings, models: snapshot.models }) : previous;
        const message = designMessageSchema.parse({ role: "assistant", content: result.message, time: new Date().toISOString() });
        finished = { ...session, proposal, base: result.proposal ? snapshot.base : session.base, libraryProposalId: undefined,
          messages: [...session.messages, message], status: proposal ? "ready" : "idle", text: "", activity: "" };
      } catch (error) {
        finished = { ...session, status: "failed", activity: "", error: controller.signal.aborted ? "Design stopped. Send another message to continue." : error instanceof Error ? error.message : String(error) };
      }
      // Publish the finished state only after persistence. A ready reply must never
      // race a new turn or an apply while its previous disk write is still pending.
      await this.save(finished);
      if (controller.signal.aborted && finished.status !== "failed") {
        // Cancellation can arrive while the reply is still being written. Keep
        // the previous conversation/proposal and persist the stopped state before
        // making it available for another turn or an apply.
        finished = { ...session, revision: finished.revision, status: "failed", activity: "",
          error: "Design stopped. Send another message to continue." };
        await this.save(finished);
      }
      this.jobs.delete(id); this.sessions.set(id, finished);
    })().catch((error: unknown) => {
      session.status = "failed"; session.error = "Could not save this design reply. Check local storage and send your request again.";
      console.error("Could not persist design chat:", error instanceof Error ? error.message : "unknown error");
    }).finally(() => { if (this.jobs.get(id) === job) { this.jobs.delete(id); } completion.resolve(); });
    return this.get(id);
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) { throw new Error("This design conversation is not working"); }
    job.controller.abort(new Error("Cancelled by user"));
    await job.done; return this.get(id);
  }
  async discard(id: string, value: unknown) {
    const { revision } = z.object({ revision: z.number().int().nonnegative() }).strict().parse(value);
    const session = this.sessions.get(id);
    if (this.closed || !session || session.revision !== revision || !session.proposal ||
        session.status === "applied" || this.jobs.has(id) || this.applying.has(id)) {
      throw new Error("This proposal changed or is busy. Wait for the latest reply.");
    }
    this.applying.add(id);
    try {
      const next = { ...session, status: "idle" as const, proposal: undefined, base: undefined,
        libraryProposalId: undefined, error: undefined, text: "", activity: "" };
      await this.save(next);
      this.sessions.set(id, next);
      return this.get(id);
    } finally { this.applying.delete(id); }
  }
  async apply(id: string, value: unknown) {
    if (this.closed) { throw new Error("Server is shutting down"); }
    const { revision } = z.object({ revision: z.number().int().nonnegative() }).strict().parse(value);
    const session = this.sessions.get(id);
    if (!session || session.revision !== revision || session.status !== "ready" || !session.proposal || !session.base || this.jobs.has(id) || this.applying.has(id)) { throw new Error("This proposal changed or cannot be applied. Review the latest reply."); }
    this.applying.add(id);
    try {
      const snapshot = await this.snapshot(AbortSignal.timeout(30_000));
      if (Object.entries(session.base).some(([key, value]) => snapshot.base[key as keyof typeof snapshot.base] !== value)) { throw new Error("Project settings changed since this proposal. Send a message to refresh the proposal before applying it."); }
      const proposal = validateDesign(session.proposal, { scope: session.scope, library: snapshot.library, settings: snapshot.orchestration.settings, models: snapshot.models });
      if (proposal.scope === "blocks") {
        const change = await this.proposals.create(snapshot.library, "regenerate", proposal.changes, snapshot.models);
        session.libraryProposalId = change.id; await this.save(session);
        await this.proposals.apply(change.id, snapshot.models);
      } else if (proposal.scope === "execution") {
        await updateExecutionSettings(this.project, { ...proposal.settings, configRevision: snapshot.execution.configRevision });
      } else {
        const settings = { ...snapshot.orchestration.settings };
        if (proposal.scope === "profiles") { settings.profiles = proposal.profiles; settings.coordinatorProfile = proposal.coordinatorProfile; }
        if (proposal.scope === "cases") { settings.cases = proposal.cases; settings.instructions = proposal.instructions; settings.suggestBlocks = proposal.suggestBlocks; }
        if (proposal.scope === "capabilities") { settings.capabilities = proposal.capabilities; }
        await saveOrchestration(this.project, { ...snapshot.orchestration, settings }, snapshot.models);
      }
      const applied = { ...session, status: "applied" as const };
      await this.save(applied); this.sessions.set(id, applied); return this.get(id);
    } finally { this.applying.delete(id); }
  }
  async close() {
    this.closed = true;
    const jobs = [...this.jobs.values()]; jobs.forEach((job) => job.controller.abort(new Error("Server closing")));
    await Promise.allSettled(jobs.map((job) => job.done));
  }
}
