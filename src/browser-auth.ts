import { randomUUID } from "node:crypto";
import type { AuthPrompt, Provider } from "@earendil-works/pi-ai";
import { getModelRuntime } from "./model-runtime.js";
import { loadUserSettings, saveUserSettings } from "./user-settings.js";
import { loginMethods } from "./auth-policy.js";
import { authEventSchema, authResponseSchema, authStartSchema, type AuthSession } from "./auth-schema.js";

type Runtime = Pick<Awaited<ReturnType<typeof getModelRuntime>>, "login" | "logout"> & {
  getProviders(): readonly Pick<Provider, "id" | "name" | "auth">[];
};
type PendingPrompt = { id: string; resolve: (value: string) => void };

/** Browser transport for provider interactions; credentials stay in the SDK's private store. */
export class BrowserAuth {
  private session?: AuthSession;
  private controller?: AbortController;
  private pending?: PendingPrompt;
  private operation?: Promise<void>;
  private starting = false;
  private closed = false;

  constructor(private readonly runtime: () => Promise<Runtime> = getModelRuntime) {}

  async options() {
    return (await this.runtime()).getProviders().flatMap((provider) => {
      const methods = loginMethods(provider);
      return methods.length ? [{ id: provider.id, name: provider.name, methods }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  current() { return this.session ? structuredClone(this.session) : null; }

  private require(id: string) {
    if (!this.session || this.session.id !== id) { throw new Error("Sign-in session not found. Start again."); }
    return this.session;
  }

  async start(value: unknown) {
    const input = authStartSchema.parse(value);
    if (this.closed) { throw new Error("Server is closing"); }
    if (this.starting || this.operation) { throw new Error("A provider operation is already in progress"); }
    this.starting = true;
    try {
      const runtime = await this.runtime();
      const provider = runtime.getProviders().find((item) => item.id === input.provider);
      if (!provider || !loginMethods(provider).includes(input.method)) {
        throw new Error("Use ChatGPT sign-in or an available API-key provider");
      }
      const settings = await loadUserSettings();
      await saveUserSettings(settings);
      if (this.closed) { throw new Error("Server is closing"); }
      const session: AuthSession = { id: randomUUID(), provider: input.provider, method: input.method, status: "pending", events: [] };
      this.session = session;
      this.controller = new AbortController();
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(10 * 60_000)]);
      const operation = (async () => {
        try {
          await runtime.login(input.provider, input.method, {
            signal,
            notify: (event) => {
              if (signal.aborted || session.status !== "pending") { return; }
              // Preserve the authorization link while replacing repetitive progress messages.
              if (event.type === "progress") { session.events = session.events.filter((item) => item.type !== "progress"); }
              session.events = [...session.events, authEventSchema.parse(event)].slice(-20);
            },
            prompt: (prompt) => this.prompt(session, prompt, signal),
          }, { agentName: "workflow", getDeviceId: () => settings.deviceId });
          // A provider may have saved credentials just as cancellation arrived.
          session.status = "succeeded";
          session.message = "Connected. Choose a model for this project.";
        } catch {
          session.status = signal.aborted ? "cancelled" : "failed";
          // Provider errors may contain callback URLs or tokens: never send raw errors to the browser.
          session.message = signal.aborted ? "Sign-in cancelled or expired. Any credentials already saved are kept." : "Sign-in failed. Check the provider details and try again. If another login is open, cancel it first.";
        } finally {
          delete session.prompt;
          session.events = [];
          this.pending = undefined;
        }
      })();
      this.operation = operation;
      void operation.finally(() => { if (this.operation === operation) { this.operation = undefined; } });
      return this.current()!;
    } finally { this.starting = false; }
  }

  private async prompt(session: AuthSession, prompt: AuthPrompt, loginSignal: AbortSignal) {
    const signal = prompt.signal ? AbortSignal.any([prompt.signal, loginSignal]) : loginSignal;
    signal.throwIfAborted();
    if (this.pending) { throw new Error("A provider prompt is already pending"); }
    const id = randomUUID();
    session.prompt = {
      id, type: prompt.type, message: prompt.message,
      ...(prompt.type === "select" ? { options: [...prompt.options] } : { placeholder: prompt.placeholder }),
    };
    let abort: (() => void) | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        this.pending = { id, resolve };
        abort = () => reject(new Error("Sign-in cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); }
      });
    } finally {
      if (abort) { signal.removeEventListener("abort", abort); }
      this.clearPrompt(session, id);
    }
  }

  private clearPrompt(session: AuthSession, id: string) {
    if (this.pending?.id === id) { this.pending = undefined; delete session.prompt; }
  }

  respond(id: string, value: unknown) {
    const input = authResponseSchema.parse(value);
    const session = this.require(id);
    const pending = this.pending;
    if (session.status !== "pending" || !pending || pending.id !== input.promptId || session.prompt?.id !== input.promptId) {
      throw new Error("This sign-in prompt has expired. Follow the current prompt.");
    }
    if (session.prompt.type === "select" && !session.prompt.options?.some((option) => option.id === input.value)) {
      throw new Error("Choose one of the offered sign-in options");
    }
    // Clear before resolving so duplicate submissions can never answer the next prompt.
    this.pending = undefined;
    delete session.prompt;
    pending.resolve(input.value);
    return this.current()!;
  }

  cancel(id: string) {
    this.require(id);
    this.controller?.abort();
    return this.current()!;
  }

  async logout(provider: string) {
    if (this.closed || this.starting || this.operation) { throw new Error("A provider operation is already in progress"); }
    this.starting = true;
    try {
      await (await this.runtime()).logout(provider, { signal: AbortSignal.timeout(15_000) });
      if (this.session?.provider === provider) { this.session = undefined; }
    } catch { throw new Error("Could not remove saved credentials. Refresh connections and try again."); }
    finally { this.starting = false; }
  }

  close() { this.closed = true; this.controller?.abort(); }
}
