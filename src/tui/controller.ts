import { EventEmitter } from "node:events";
import { z } from "zod";
import { WorkflowClient } from "../client.js";
import {
  authOptionsSchema, authSessionSchema, executionSettingsSchema, modelCatalogSchema, orchestrationStateSchema,
  projectSchema, runListSchema, runSchema, setupSchema, taskListSchema, taskSchema,
  type AuthSession, type AvailableModel, type OrchestrationState, type RunAction, type RunEvent, type Setup, type TaskRequest, type WorkflowRun,
} from "../contracts.js";
import { commands, short } from "./presentation.js";

export type Session = { id: string; kind: "task" | "run"; title: string; status: string; time: string; runId?: string };
export type Choice = { id: string; label: string; detail: string };
export type Screen = "chat" | "graph" | "source" | "step" | "picker" | "help" | "auth";
export interface TuiState {
  project?: z.infer<typeof projectSchema>;
  setup?: Setup;
  orchestration?: OrchestrationState;
  approval: "review" | "automatic";
  connected: boolean;
  busy: string;
  notice: string;
  error: string;
  sessions: Session[];
  task?: TaskRequest;
  run?: WorkflowRun;
  events: RunEvent[];
  live: Record<string, string>;
  screen: Screen;
  panelTitle: string;
  panelDescription: string;
  choices: Choice[];
  detail: string;
  auth?: AuthSession;
}

/** Presentation state only. All effects go through the same API as the browser. */
export class TerminalController extends EventEmitter {
  readonly state: TuiState = { approval: "review", connected: false, busy: "", notice: "", error: "", sessions: [],
    events: [], live: {}, screen: "chat", panelTitle: "", panelDescription: "", choices: [], detail: "" };
  private readonly cancellation = new AbortController();
  private subscription?: ReturnType<WorkflowClient["subscribe"]>;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private generation = 0;
  private selected?: { kind: "task" | "run"; id: string };
  private approvalChosen = false;
  private actions = new Map<string, () => Promise<void> | void>();
  private closed = false;
  private ownsAuth = false;
  private authGeneration = 0;
  private refiningRun?: string;
  private refinement?: AbortController;
  private readonly localNotes = new Map<string, RunEvent[]>();

  constructor(readonly client: WorkflowClient) { super(); }
  private signal(timeout = 15_000) { return AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(timeout)]); }
  changed() { if (!this.closed) this.emit("change", this.state); }
  private mergeEvents(events: RunEvent[]) {
    this.state.events = [...new Map([...this.state.events, ...events].map(event => [event.id, event])).values()]
      .sort((a, b) => a.time.localeCompare(b.time)).slice(-500);
  }
  async initialize() {
    this.state.project = await this.client.project(this.signal());
    await this.loadSettings();
    await this.refresh();
    this.subscription = this.client.subscribe(event => this.receive(event), {
      signal: this.cancellation.signal,
      onOpen: () => { this.state.connected = true; this.changed(); void this.refresh(); },
      onError: () => { this.state.connected = false; this.changed(); },
    });
    this.poll();
    this.changed();
  }
  private poll() {
    this.timer = setTimeout(async () => {
      await this.refresh();
      if (!this.closed) this.poll();
    }, 900);
  }
  private receive(event: RunEvent) {
    if (event.runId === "coordinator" && this.refiningRun && this.refiningRun === this.state.run?.id) event = { ...event, runId: this.refiningRun };
    if (event.runId !== this.state.run?.id && event.runId !== `task:${this.state.task?.id}`) return;
    const key = `${event.runId}/${event.nodeId ?? "assistant"}`;
    if (event.kind === "text_delta") this.state.live[key] = ((this.state.live[key] ?? "") + event.message).slice(-32_000);
    else {
      if (["agent_message", "node_end", "run_end", "planning_error"].includes(event.kind)) delete this.state.live[key];
      if (event.kind === "run_end") this.state.live = {};
      this.mergeEvents([event]);
    }
    this.changed();
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.readState().catch(error => {
      if (!this.closed) { this.state.error = error instanceof Error ? error.message : String(error); this.changed(); }
    }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async readState() {
    const generation = this.generation;
    const selected = this.selected;
    const [tasks, runs] = await Promise.all([
      this.client.request("/api/tasks", taskListSchema, { signal: this.signal() }),
      this.client.request("/api/runs", runListSchema, { signal: this.signal() }),
    ]);
    if (this.closed) return;
    const linked = new Set(tasks.map(task => task.runId));
    this.state.sessions = [
      ...tasks.filter(task => !task.deletedAt).map(task => ({ id: task.id, kind: "task" as const, title: task.prompt,
        status: runs.find(run => run.id === task.runId)?.status ?? task.status, time: task.createdAt, runId: task.runId })),
      ...runs.filter(run => !run.deletedAt && !linked.has(run.id)).map(run => ({ id: run.id, kind: "run" as const, title: run.title, status: run.status, time: run.createdAt })),
    ].sort((a, b) => b.time.localeCompare(a.time));
    if (selected) {
      const task = selected.kind === "task" ? await this.client.task(selected.id, this.signal()) : undefined;
      const runId = task?.runId ?? (selected.kind === "run" ? selected.id : undefined);
      const [run, events] = runId ? await Promise.all([this.client.run(runId, this.signal()), this.client.events(runId, this.signal())]) : [undefined, []];
      if (generation === this.generation && !this.closed) {
        if (task && (!this.state.task || task.revision >= this.state.task.revision)) this.state.task = task;
        if (run && (!this.state.run || run.revision >= this.state.run.revision)) this.state.run = run;
        this.mergeEvents([...(task?.events ?? []), ...events, ...(runId ? this.localNotes.get(runId) ?? [] : [])]);
        if (run && !["running", "pausing"].includes(run.status) && task?.status !== "planning" && this.refiningRun !== run.id) this.state.live = {};
      }
    }
    if (this.state.auth?.status === "pending") {
      const authGeneration = this.authGeneration;
      const auth = await this.client.request("/api/auth/session", authSessionSchema.nullable(), { signal: this.signal() });
      if (authGeneration === this.authGeneration && auth?.id === this.state.auth.id) {
        this.state.auth = auth;
        if (auth.status === "succeeded") {
          this.state.notice = "Connected. Choose a project model with /models.";
          await this.loadSettings();
        }
      }
    }
    this.changed();
  }
  private async loadSettings() {
    const [setup, orchestration] = await Promise.all([
      this.client.request("/api/setup", setupSchema, { signal: this.signal() }),
      this.client.request("/api/settings/orchestration", orchestrationStateSchema, { signal: this.signal() }),
    ]);
    this.state.setup = setup; this.state.orchestration = orchestration;
    if (!this.approvalChosen) this.state.approval = orchestration.settings.approval;
  }
  async perform(label: string, action: () => Promise<void> | void) {
    if (this.state.busy || this.closed) return;
    this.state.busy = label; this.state.error = ""; this.state.notice = ""; this.changed();
    try { await action(); }
    catch (error) { if (!this.closed) this.state.error = error instanceof Error ? error.message : String(error); }
    finally { this.state.busy = ""; this.changed(); }
  }
  newSession() {
    this.generation++; this.selected = undefined; this.state.task = undefined; this.state.run = undefined;
    this.state.events = []; this.state.live = {}; this.state.screen = "chat"; this.state.error = "";
    this.state.notice = "New session. Describe what you want to accomplish."; this.changed();
  }
  async openSession(session: Pick<Session, "id" | "kind">) {
    this.generation++; this.selected = { id: session.id, kind: session.kind };
    this.state.task = undefined; this.state.run = undefined; this.state.events = []; this.state.live = {}; this.state.screen = "chat";
    await this.refreshing;
    await this.refresh();
  }
  private picker(title: string, description: string, choices: (Choice & { action: () => Promise<void> | void })[]) {
    this.state.screen = "picker"; this.state.panelTitle = title; this.state.panelDescription = description;
    this.state.choices = choices.map(({ action: _action, ...choice }) => choice);
    this.actions = new Map(choices.map(choice => [choice.id, choice.action])); this.changed();
  }
  async choose(id: string) { await this.perform("Working", async () => { await this.actions.get(id)?.(); }); }
  back() { this.state.screen = "chat"; this.state.error = ""; this.changed(); }
  async submit(text: string) {
    if (!text.trim()) return;
    if (["/quit", "/exit"].includes(text.trim())) { this.emit("quit"); return; }
    if (text.trim() === "/cancel" && this.refinement) { this.refinement.abort(new Error("Workflow refinement cancelled")); return; }
    await this.perform("Working", async () => {
      if (this.state.screen === "auth" && this.state.auth?.status === "pending" && this.state.auth.prompt && !text.startsWith("/")) {
        await this.respondAuth(text); return;
      }
      if (text.startsWith("/")) { await this.command(text); return; }
      const generation = this.generation;
      const task = this.state.task;
      if (task?.status === "needs_input") {
        const choice = /^\d+$/.test(text.trim()) ? task.question?.options[Number(text.trim()) - 1] : undefined;
        const updated = await this.client.answerTask(task.id, choice ?? text, task.revision, this.signal());
        if (generation === this.generation) this.state.task = updated;
      } else if (task && ["queued", "planning"].includes(task.status)) throw new Error("Planning is in progress. Use /cancel to stop, or /new to start another session.");
      else if (this.state.run?.status === "draft") {
        const run = this.state.run;
        const note: RunEvent = { id: crypto.randomUUID(), runId: run.id, kind: "user_message", message: text, time: new Date().toISOString() };
        this.localNotes.set(run.id, [...(this.localNotes.get(run.id) ?? []), note].slice(-50));
        this.mergeEvents([note]); this.refiningRun = run.id; this.refinement = new AbortController();
        this.state.busy = "Refining the workflow · /cancel to stop"; this.changed();
        try {
          const updated = await this.client.request(`/api/runs/${run.id}/refine`, runSchema, {
            method: "POST", body: { instructions: text }, revision: run.revision, signal: AbortSignal.any([this.signal(120_000), this.refinement.signal]),
          });
          if (generation === this.generation) this.state.run = updated;
        } finally { this.refiningRun = undefined; this.refinement = undefined; if (generation === this.generation) this.state.live = {}; }
      } else if (this.state.run && ["running", "pausing", "paused", "interrupted"].includes(this.state.run.status)) {
        throw new Error("This workflow is active. Use /new for another request, or /pause, /resume, and /cancel to control it.");
      } else {
        const created = await this.client.request("/api/tasks", taskSchema, { method: "POST", body: { prompt: text, approval: this.state.approval }, signal: this.signal() });
        if (generation === this.generation) {
          this.generation++; this.selected = { kind: "task", id: created.id }; this.state.task = created;
          this.state.run = undefined; this.state.events = []; this.state.live = {}; this.state.screen = "chat";
        }
      }
      await this.refresh();
    });
  }
  async runAction(action: RunAction) {
    const run = this.state.run;
    if (!run) throw new Error("Open a workflow first with /sessions.");
    const generation = this.generation;
    const updated = await this.client.action(run.id, action, action === "approve" ? run.revision : undefined, this.signal(120_000));
    if (generation === this.generation) { this.state.run = updated; this.state.screen = "chat"; }
    await this.refresh();
  }
  private async command(input: string) {
    const [command = "", ...rest] = input.trim().split(/\s+/);
    const argument = rest.join(" ");
    if (command === "/quit" || command === "/exit") { this.emit("quit"); return; }
    if (command === "/new") { this.newSession(); return; }
    if (command === "/help") { this.state.screen = "help"; return; }
    if (command === "/sessions") {
      await this.refresh();
      this.picker("Sessions", "Choose a task to reopen its conversation, graph, and results.", this.state.sessions.map(session => ({
        id: session.id, label: short(session.title, 100), detail: `${session.status} · ${session.time.slice(0, 16).replace("T", " ")}`,
        action: () => this.openSession(session),
      }))); return;
    }
    if (command === "/auto") {
      if (argument && !["on", "off"].includes(argument)) throw new Error("Use /auto on or /auto off.");
      this.state.approval = argument ? argument === "on" ? "automatic" : "review" : this.state.approval === "review" ? "automatic" : "review";
      this.approvalChosen = true;
      this.state.notice = this.state.approval === "automatic" ? "New tasks will start automatically. Existing drafts still require /approve." : "New tasks will wait for your approval.";
      return;
    }
    if (["/approve", "/reject", "/pause", "/resume", "/recover"].includes(command)) { await this.runAction(command.slice(1) as RunAction); return; }
    if (command === "/cancel") {
      if (this.state.auth?.status === "pending" && this.state.screen === "auth") { await this.cancelAuth(); return; }
      const task = this.state.task;
      if (task && ["queued", "planning", "needs_input"].includes(task.status)) {
        const updated = await this.client.request(`/api/tasks/${task.id}/cancel`, taskSchema, { method: "POST", body: {}, signal: this.signal() });
        if (this.state.task?.id === task.id) this.state.task = updated;
      } else await this.runAction("cancel");
      return;
    }
    if (command === "/retry") {
      const task = this.state.task;
      if (!task) throw new Error("Open a failed planning task first.");
      const updated = await this.client.request(`/api/tasks/${task.id}/retry`, taskSchema, { method: "POST", body: {}, signal: this.signal() });
      if (this.state.task?.id === task.id) { this.state.task = updated; this.state.screen = "chat"; }
      return;
    }
    if (command === "/graph" || command === "/source") {
      if (!this.state.run) throw new Error("The graph will appear when planning finishes.");
      this.state.screen = command === "/graph" ? "graph" : "source"; return;
    }
    if (command === "/step") {
      const run = this.state.run;
      if (!run) throw new Error("Open a workflow first.");
      const show = (id: string) => {
        const node = run.plan.nodes.find(node => node.id === id);
        if (!node) throw new Error(`Unknown step: ${id}`);
        this.state.screen = "step"; this.state.panelTitle = node.label ?? node.id;
        this.state.detail = JSON.stringify({ step: node, block: run.blocks[node.block], attempts: run.attempts.filter(attempt => attempt.nodeId === id), artifacts: run.artifacts[id] }, null, 2);
      };
      if (argument) show(argument);
      else this.picker("Workflow steps", "Inspect instructions, tools, model settings, checks, and artifacts.", run.plan.nodes.map(node => ({ id: node.id, label: node.label ?? node.id, detail: short(node.goal), action: () => show(node.id) })));
      return;
    }
    if (command === "/settings") { await this.settings(); return; }
    if (command === "/models" || command === "/model") { await this.models(argument); return; }
    if (command === "/thinking") { await this.thinking(); return; }
    if (command === "/login") { await this.login(argument); return; }
    if (command === "/logout") {
      await this.loadSettings();
      this.picker("Disconnect provider", "Select a connection to remove its stored credentials.", (this.state.setup?.providers ?? []).map(provider => ({ id: provider.id, label: provider.name, detail: provider.method,
        action: async () => {
          await this.client.request(`/api/auth/providers/${encodeURIComponent(provider.id)}/logout`, z.object({ removed: z.boolean() }), { method: "POST", body: {}, signal: this.signal() });
          await this.settings(); this.state.notice = `Disconnected ${provider.name}.`;
        } }))); return;
    }
    throw new Error(`Unknown command ${command}. Use /help to see available commands.`);
  }
  private async settings() {
    await this.loadSettings();
    const setup = this.state.setup!;
    const agent = { ...setup.userAgent, ...setup.projectAgent };
    const orchestration = this.state.orchestration!;
    const execution = await this.client.request("/api/settings/execution", executionSettingsSchema, { signal: this.signal() });
    this.picker("Settings", `Project model: ${agent.provider ?? "not set"}/${agent.model ?? "not set"}\nThinking: ${agent.thinking ?? "default"} · ${execution.maxSteps} max steps\n${orchestration.settings.profiles.length} model profiles · ${orchestration.settings.cases.length} task instructions`, [
      { id: "model", label: "Project model", detail: "Choose from connected providers", action: () => this.models() },
      { id: "thinking", label: "Thinking level", detail: agent.thinking ?? "default", action: () => this.thinking() },
      { id: "approval", label: "Approval for new tasks", detail: this.state.approval === "automatic" ? "Automatic — tasks start immediately" : "Review graph before execution", action: async () => { await this.command("/auto"); await this.settings(); } },
      { id: "login", label: "Connect a provider", detail: "ChatGPT sign-in or an API key", action: () => this.login() },
      { id: "logout", label: "Disconnect a provider", detail: `${setup.providers.length} connections`, action: () => this.command("/logout") },
      { id: "details", label: "Inspect project configuration", detail: "Instructions, models, capabilities, execution limits", action: () => {
        this.state.screen = "step"; this.state.panelTitle = "Project configuration";
        this.state.detail = JSON.stringify({ orchestration: orchestration.settings, execution }, null, 2);
      } },
    ]);
  }
  private async models(search = "") {
    const catalog = await this.client.request("/api/models/refresh", modelCatalogSchema, { method: "POST", body: {}, signal: this.signal(60_000) });
    this.picker("Choose a model", catalog.warnings.join("\n") || "Type to filter. This updates the project default; existing model profiles keep their own assignments.", catalog.models
      .filter(model => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(search.toLowerCase()))
      .map(model => ({ id: `${model.provider}/${model.id}`, label: model.name, detail: `${model.provider}/${model.id}`, action: () => this.saveModel(model) })));
    if (!catalog.models.length) this.state.panelDescription = "No connected models yet. Press Esc, then /login to connect a provider.";
  }
  private async saveModel(model: AvailableModel, thinking?: string) {
    await this.loadSettings();
    const current = { ...this.state.setup!.userAgent, ...this.state.setup!.projectAgent };
    const level = thinking ?? (current.thinking && model.thinkingLevels.includes(current.thinking) ? current.thinking : model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0] ?? "off");
    this.state.setup = await this.client.request("/api/project/model", setupSchema, { method: "PUT", body: {
      configRevision: this.state.setup!.configRevision, agent: { provider: model.provider, model: model.id, thinking: level },
    }, signal: this.signal() });
    this.state.screen = "chat"; this.state.notice = `Project model: ${model.provider}/${model.id} · thinking ${level}`;
  }
  private async thinking() {
    await this.loadSettings();
    const agent = { ...this.state.setup!.userAgent, ...this.state.setup!.projectAgent };
    const catalog = await this.client.request("/api/models", modelCatalogSchema, { signal: this.signal() });
    const model = catalog.models.find(model => model.provider === agent.provider && model.id === agent.model);
    if (!model) throw new Error("Choose a connected project model with /models first.");
    this.picker("Thinking level", `${model.provider}/${model.id}`, (model.thinkingLevels.length ? model.thinkingLevels : ["off"]).map(level => ({ id: level, label: level, detail: level === agent.thinking ? "Current setting" : "", action: () => this.saveModel(model, level) })));
  }
  private async login(providerId = "") {
    const [options, existing] = await Promise.all([
      this.client.request("/api/auth/options", authOptionsSchema, { signal: this.signal() }),
      this.client.request("/api/auth/session", authSessionSchema.nullable(), { signal: this.signal() }),
    ]);
    if (existing?.status === "pending") { this.authGeneration++; this.state.auth = existing; this.ownsAuth = true; this.state.screen = "auth"; return; }
    this.picker("Connect a provider", "Credentials stay in the engine's private store. Secret input is hidden.", options.filter(provider => !providerId || provider.id === providerId).flatMap(provider => provider.methods.map(method => ({
      id: `${provider.id}/${method}`, label: provider.id === "openai" && method === "oauth" ? "ChatGPT · sign in" : `${provider.name} · API key`,
      detail: method === "oauth" ? "Follow the authorization link or device code" : "Paste a key into a masked field",
      action: async () => {
        this.authGeneration++;
        this.state.auth = await this.client.request("/api/auth/session", authSessionSchema, { method: "POST", body: { provider: provider.id, method }, signal: this.signal() });
        this.ownsAuth = true; this.state.screen = "auth";
      },
    }))));
  }
  async respondAuth(value: string) {
    const auth = this.state.auth;
    if (!auth?.prompt || auth.status !== "pending") throw new Error("This sign-in prompt has expired.");
    const selected = auth.prompt.type === "select" ? auth.prompt.options?.[Number(value) - 1]?.id ?? value : value;
    this.authGeneration++;
    this.state.auth = await this.client.request(`/api/auth/session/${auth.id}/respond`, authSessionSchema, {
      method: "POST", body: { promptId: auth.prompt.id, value: selected }, signal: this.signal(),
    });
  }
  async cancelAuth() {
    const auth = this.state.auth;
    this.authGeneration++;
    if (auth?.status === "pending") this.state.auth = await this.client.request(`/api/auth/session/${auth.id}/cancel`, authSessionSchema, { method: "POST", body: {}, signal: this.signal() });
    this.state.screen = "chat";
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.subscription?.close();
    if (this.ownsAuth && this.state.auth?.status === "pending") {
      await this.client.request(`/api/auth/session/${this.state.auth.id}/cancel`, authSessionSchema, { method: "POST", body: {}, signal: AbortSignal.timeout(3000) }).catch(() => {});
    }
    this.cancellation.abort();
    await this.subscription?.done;
    this.removeAllListeners();
  }
}
export const commandHelp = commands.map(([command, description]) => `${command.padEnd(13)} ${description}`).join("\n");
