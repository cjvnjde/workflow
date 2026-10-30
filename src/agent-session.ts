import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { usageSchema, type AgentSettings, type UsageTotals, type priceSchema } from "./domain.js";
import type { ImageContent, Usage } from "@earendil-works/pi-ai";
import type { z } from "zod";
import { addUsage, emptyUsage, priceUsage } from "./budget.js";
import { getModelRuntime } from "./model-runtime.js";
import { boundedEvidence, type OperationRecorder } from "./operation-schema.js";
import { createAccountingContext, UsageStore } from "./usage-store.js";
import type { AccountingContext } from "./usage-schema.js";

export type ActivitySink = (kind: string, message: string) => void;

export async function runAgentSession(options: {
  project: string;
  settings: AgentSettings;
  systemPrompt: string;
  prompt: string;
  images?: ImageContent[];
  requireVision?: boolean;
  tools: ToolDefinition[];
  signal: AbortSignal;
  emit: ActivitySink;
  onUsage?: (usage: UsageTotals) => Promise<void>;
  maxCostUsd?: number;
  price?: z.infer<typeof priceSchema>;
  accounting?: AccountingContext;
  operation?: { parentId: string; record: OperationRecorder };
  /** Continue a prematurely ended response in the same session and budgets. */
  completion?: { isComplete: () => boolean; prompt: () => string };
}) {
  const { project, settings, signal, emit } = options;
  signal.throwIfAborted();
  const modelRuntime = await getModelRuntime();
  const available = await modelRuntime.getAvailable(undefined, { signal });
  const model =
    settings.model && settings.provider
      ? modelRuntime.getModel(settings.provider, settings.model)
      : available.find(
          (candidate) =>
            !settings.provider || candidate.provider === settings.provider,
        );
  if (settings.model && !settings.provider) {
    throw new Error("A model override requires a provider");
  }
  if (!model) {
    throw new Error(
      "No matching model available. Open Settings → Providers & models to connect ChatGPT or add an API key, then choose a model.",
    );
  }
  if (options.images?.length && !model.input.includes("image") && options.requireVision !== false) { throw new Error("This model cannot read images. Select an image-capable coordinator/model profile in Settings."); }
  if (options.maxCostUsd !== undefined && options.maxCostUsd <= 0) { throw new Error("Workflow spending limit reached"); }
  if (options.maxCostUsd !== undefined && !options.price && ![model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some((rate) => rate > 0)) { throw new Error("Cannot enforce a dollar budget without model pricing"); }
  const accounting = options.accounting ?? await createAccountingContext(project, "execution");
  const catalogPriced = [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some(rate => rate > 0);
  const tracked = await new UsageStore(accounting.project).beginSession(accounting, {
    provider: model.provider, model: model.id, thinking: settings.thinking,
    pricing: { source: options.price ? "override" : catalogPriced ? "catalog" : "unknown",
      rates: options.price ?? (catalogPriced ? { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite, tiers: model.cost.tiers } : null) },
  }, signal);
  const limits = [options.maxCostUsd, tracked.remainingCostUsd].filter((value): value is number => value !== undefined);
  const maxCostUsd = limits.length ? Math.min(...limits) : undefined;
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const budget = new AbortController();
  const combinedSignal = AbortSignal.any([signal, budget.signal]);
  let calls = 0;
  let usage = emptyUsage();
  let modelFailure: Error | undefined;
  let usageWrites = Promise.resolve();
  let operationWrites = Promise.resolve();
  const recordedCalls = new Set<string>();
  const requestedInputs = new Map<string, unknown>();
  const tools = options.tools.map((tool) => ({
    ...tool,
    executionMode: "sequential" as const,
    execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
      await usageWrites;
      combinedSignal.throwIfAborted();
      calls += 1;
      if (calls > settings.maxToolCalls) {
        const error = new Error(
          `Tool-call budget exhausted (${settings.maxToolCalls})`,
        );
        budget.abort(error);
        throw error;
      }

      if (!options.operation) return await tool.execute(...args);
      const record = options.operation.record;
      const identity = { id: `${options.operation.parentId}/${args[0]}`, parentId: options.operation.parentId, name: tool.name, kind: "tool" as const };
      const evidence = boundedEvidence(args[1]);
      const started = Date.now();
      recordedCalls.add(args[0]);
      await record({ ...identity, state: "started", input: evidence.value, truncated: evidence.truncated });
      try {
        const result = await tool.execute(...args);
        combinedSignal.throwIfAborted();
        const output = boundedEvidence(result.content), details = boundedEvidence(result.details);
        await record({ ...identity, state: "completed", output: output.value, details: details.value, truncated: output.truncated || details.truncated, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        await record({ ...identity, state: combinedSignal.aborted ? "interrupted" : "failed", summary: String(error).slice(0, 16_000), durationMs: Date.now() - started });
        throw error;
      }
    },
  }));
  const { session } = await createAgentSession({
    cwd: project,
    modelRuntime,
    model,
    thinkingLevel: settings.thinking,
    tools: tools.map((tool) => tool.name),
    customTools: tools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(project),
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 2 },
      compaction: { enabled: maxCostUsd === undefined },
    }),
  }).catch(async error => { try { await tracked.finish(signal.aborted ? "cancelled" : "failed", String(error)); } finally { tracked.release(); } throw error; });
  let abortPromise: Promise<void> | undefined;
  const abort = () => {
    // Retry-start listeners run before Pi installs its backoff controller.
    // Let that transition finish so cancellation also interrupts the new wait.
    abortPromise ??= Promise.resolve().then(() => session.abort());
    // Retain the promise for cleanup while handling its rejection immediately.
    void abortPromise.catch(() => {});
  };
  const recordUsage = (reported: Usage) => {
    const price = options.price;
    const catalogHasPrice = [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some((rate) => rate > 0);
    const costUsd = price
      ? priceUsage(price, reported.input, reported.output, reported.cacheRead, reported.cacheWrite, reported.cacheWrite1h)
      : reported.cost.total;
    const next = usageSchema.parse({
      inputTokens: reported.input, outputTokens: reported.output,
      cacheReadTokens: reported.cacheRead, cacheWriteTokens: reported.cacheWrite,
      costUsd, requests: 1, unpricedRequests: price || catalogHasPrice ? 0 : 1,
    });
    usage = addUsage(usage, next);
    const snapshot = { ...usage };
    usageWrites = usageWrites.then(async () => { await tracked.update(snapshot); await options.onUsage?.(snapshot); });
    void usageWrites.catch((error: unknown) => { budget.abort(error); });
    emit("usage", JSON.stringify(snapshot));
    if (maxCostUsd !== undefined && (usage.unpricedRequests > 0 || usage.costUsd >= maxCostUsd)) {
      budget.abort(new Error(usage.unpricedRequests > 0 ? "Cannot enforce a dollar budget without model pricing" : "Workflow spending limit reached"));
    }
  };
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      emit("text_delta", event.assistantMessageEvent.delta);
    } else if (
      event.type === "message_end" &&
      event.message.role === "assistant"
    ) {
      const reported = event.message.usage;
      if (combinedSignal.aborted && reported.totalTokens === 0) { return; }
      recordUsage(reported);
      const text = event.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text) {
        emit("agent_message", text);
      }
      // Pi retries transient provider failures in the same conversation. Aborting
      // at message_end would cancel that retry before it can even be scheduled.
      modelFailure = event.message.stopReason === "error"
        ? new Error(event.message.errorMessage ?? "Model request failed")
        : undefined;
    } else if (event.type === "auto_retry_start") {
      emit("agent_retry", `Provider request interrupted. Retrying ${event.attempt}/${event.maxAttempts} in ${event.delayMs / 1000}s: ${event.errorMessage.slice(0, 2000)}`);
    } else if (event.type === "auto_retry_end") {
      emit("agent_retry", event.success ? "Provider connection recovered; continuing the same step." : `Provider retry stopped: ${event.finalError ?? "Request failed"}`);
    } else if (event.type === "compaction_end" && event.result?.usage) {
      recordUsage(event.result.usage);
    } else if (event.type === "tool_execution_start" && options.operation) {
      requestedInputs.set(event.toolCallId, event.args);
    } else if (event.type === "tool_execution_end" && options.operation) {
      // Pi can reject malformed arguments or unknown tools before execute() runs.
      // These attempts still need visible evidence, without inventing a host effect.
      if (!recordedCalls.has(event.toolCallId)) {
        const input = boundedEvidence(requestedInputs.get(event.toolCallId));
        const output = boundedEvidence(event.result?.content);
        const operation = options.operation;
        operationWrites = operationWrites.then(() => operation.record({
          id: `${operation.parentId}/${event.toolCallId}`, parentId: operation.parentId,
          name: event.toolName, kind: "tool", state: event.isError ? "failed" : "completed",
          input: input.value, output: output.value, truncated: input.truncated || output.truncated,
        })).catch(error => { budget.abort(error); });
      }
      requestedInputs.delete(event.toolCallId);
    } else if (event.type === "tool_execution_start" && !options.operation) {
      emit(
        "tool_start",
        `${event.toolName} ${JSON.stringify(event.args).slice(0, 2000)}`,
      );
    } else if (event.type === "tool_execution_end" && !options.operation) {
      const content: unknown = event.result?.content;
      const details = (event.isError || event.toolName === "bash") && Array.isArray(content)
        ? content.flatMap((part: unknown) => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n").slice(-8000)
        : undefined;
      emit(
        "tool_end",
        `${event.toolName}: ${event.isError ? "error" : "finished"}${details ? `\n${details}` : ""}`,
      );
    }
  });
  const sessionStartedAt = Date.now();
  let sessionError: unknown;
  combinedSignal.addEventListener("abort", abort, { once: true });
  try {
    combinedSignal.throwIfAborted();
    emit(
      "agent_start",
      `${model.provider}/${model.id} · thinking ${session.thinkingLevel}`,
    );
    emit("model_session", JSON.stringify({ sessionId: tracked.id, operationId: accounting.operationId, scopeId: accounting.scopeId, nodeId: accounting.nodeId, visit: accounting.visit, provider: model.provider, model: model.id, thinking: session.thinkingLevel, tools: options.tools.map(tool => tool.name) }));
    const prompt = async (message: string, images?: ImageContent[]) => {
      modelFailure = undefined;
      await session.prompt(message, { images });
      await usageWrites;
      await operationWrites;
      combinedSignal.throwIfAborted();
      // prompt resolves after Pi has exhausted retries or recovered. Surface a
      // final error before asking for a structured submission or another turn.
      if (modelFailure) { throw modelFailure; }
    };
    await prompt(options.prompt, model.input.includes("image") ? options.images : undefined);
    for (let continuation = 0; options.completion && !options.completion.isComplete() && continuation < 2; continuation++) {
      await usageWrites;
      combinedSignal.throwIfAborted();
      if (calls >= settings.maxToolCalls) { throw new Error(`Tool-call budget exhausted (${settings.maxToolCalls}) before a valid submission`); }
      emit("agent_continuation", `Requesting a completed submission (${continuation + 1}/2).`);
      await prompt(options.completion.prompt());
    }
    combinedSignal.throwIfAborted();
  } catch (error) { sessionError = error; throw error; }
  finally {
    combinedSignal.removeEventListener("abort", abort);
    unsubscribe();
    try {
      await abortPromise;
      await usageWrites;
      await operationWrites;
    } finally {
      try {
        await tracked.finish(signal.aborted ? "cancelled" : sessionError || combinedSignal.aborted ? "failed" : "completed", sessionError ? String(sessionError) : undefined);
        emit("model_session_end", JSON.stringify({ sessionId: tracked.id, operationId: accounting.operationId, scopeId: accounting.scopeId, durationMs: Date.now() - sessionStartedAt, usage }));
      } finally { tracked.release(); session.dispose(); }
    }
  }
}
