import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { budgetSchema } from "./domain.js";
import type { WorkflowEngine } from "./engine.js";
import { loadLibrary } from "./library.js";
import { createTemplate } from "./templates.js";
import { createAiPlan } from "./planner.js";
import { availableModels } from "./available-models.js";
import { generateLibraryChanges } from "./library-generator.js";
import { DesignChats } from "./design-chats.js";
import { designSettings } from "./settings-designer.js";
import { designScopeSchema } from "./design-schema.js";
import { libraryHash, LibraryProposals } from "./library-proposals.js";
import { libraryChangesSchema, modelKey } from "./library-editor-schema.js";
import { providerStatus } from "./provider-status.js";
import { executionSettings, updateExecutionSettings, projectModelSettings, updateProjectModel } from "./project-model.js";
import { BrowserAuth } from "./browser-auth.js";
import { loadOrchestration, saveOrchestration } from "./orchestration-settings.js";
import { Attachments } from "./attachments.js";
import { Tasks } from "./tasks.js";
import { planTask } from "./task-planner.js";
import { mcpServerSchema } from "./capability-schema.js";
import { inspectMcp } from "./mcp-tools.js";
import { programSourceSchema } from "./program-schema.js";
import { refineProgram } from "./program-refiner.js";

const proposalSchema = z
  .object({
    task: z.string().trim().min(1).max(32_000),
    strategy: z.enum(["bug", "feature", "ai"]).default("feature"),
    instructions: z.string().max(8000).default(""),
    autoApprove: z.boolean().default(false),
    maxCostUsd: z.number().positive().optional(),
  })
  .strict();

// Optional for API compatibility; the browser always sends its reviewed revision.
const expectedRevision = (headers: { "if-match"?: string }) => {
  if (headers["if-match"] === undefined) { return undefined; }
  const value = z.string().regex(/^"\d+"$/, "If-Match must contain a quoted draft revision").parse(headers["if-match"]);
  return z.number().int().nonnegative().parse(Number(value.slice(1, -1)));
};

export async function createServer(engine: WorkflowEngine, port = 4310, services: {
  catalog?: typeof availableModels;
  generateLibrary?: typeof generateLibraryChanges;
  plan?: typeof createAiPlan;
  providers?: typeof providerStatus;
  auth?: BrowserAuth;
  taskPlanner?: typeof planTask;
  design?: typeof designSettings;
} = {}) {
  const server = Fastify({
    bodyLimit: 1_000_000,
    logger: false,
    forceCloseConnections: true,
  });
  const streams = new Set<import("node:http").ServerResponse>();
  const planning = new AbortController();
  let planningActive = false;
  const proposals = new LibraryProposals(engine.project);
  const catalog = services.catalog ?? availableModels;
  const planWithAi = services.plan ?? createAiPlan;
  const generateLibrary = services.generateLibrary ?? generateLibraryChanges;
  const providers = services.providers ?? providerStatus;
  const auth = services.auth ?? new BrowserAuth();
  const attachments = new Attachments(engine.project);
  const tasks = new Tasks(engine, catalog, services.taskPlanner);
  await tasks.initialize();
  const designChats = new DesignChats(engine.project, catalog, services.design, proposals);
  await designChats.initialize();
  const emit = (kind: string, message: string) => { engine.coordinatorActivity(kind, message); };
  const planningJob = async <T>(action: () => Promise<T>) => {
    if (planningActive) { throw new Error("A coordinator proposal is already in progress"); }
    planningActive = true;
    try { return await action(); } finally { planningActive = false; }
  };
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ]);
  server.addHook("onListen", async () => {
    const address = server.server.address();
    if (address && typeof address !== "string") {
      allowedOrigins.add(`http://127.0.0.1:${address.port}`);
      allowedOrigins.add(`http://localhost:${address.port}`);
    }
  });
  server.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/")) { reply.header("cache-control", "no-store"); }
    const host = request.headers.host?.split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") {
      return await reply
        .code(403)
        .send({ error: "Only loopback hosts are allowed" });
    }
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return await reply.code(403).send({ error: "Origin not allowed" });
    }
    if (
      ((request.method !== "GET" && request.method !== "HEAD") || request.url.startsWith("/api/auth")) &&
      request.headers["x-workflow-client"] !== "1"
    ) {
      return await reply
        .code(403)
        .send({ error: "Mutation requests require X-Workflow-Client: 1" });
    }
  });
  server.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof z.ZodError || error instanceof SyntaxError ? 400
        : error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode : 409;
    void reply.code(status).send({
      error: error instanceof Error ? error.message : "Request failed",
    });
  });
  server.get("/api/project", async () => ({
    project: engine.project,
    mode: engine.mode,
    ...(await loadLibrary(engine.project)),
  }));
  server.get("/api/models", async () => await catalog(planning.signal));
  server.get("/api/settings/orchestration", async () => await loadOrchestration(engine.project));
  server.get<{ Params: { scope: string } }>("/api/design/:scope/latest", async (request) => designChats.latest(designScopeSchema.parse(request.params.scope)));
  server.post("/api/design", async (request) => await designChats.create(request.body));
  server.get<{ Params: { id: string } }>("/api/design/:id", async (request) => designChats.get(request.params.id));
  server.post<{ Params: { id: string } }>("/api/design/:id/messages", async (request, reply) => reply.code(202).send(await designChats.send(request.params.id, request.body)));
  server.post<{ Params: { id: string } }>("/api/design/:id/cancel", async (request) => await designChats.cancel(request.params.id));
  server.post<{ Params: { id: string } }>("/api/design/:id/discard", async (request) => await designChats.discard(request.params.id, request.body));
  server.post<{ Params: { id: string } }>("/api/design/:id/apply", async (request) => await planningJob(async () => await designChats.apply(request.params.id, request.body)));
  server.put("/api/settings/orchestration", async (request) => await planningJob(async () => await saveOrchestration(engine.project, request.body, (await catalog(planning.signal)).models)));
  server.get("/api/settings/execution", async () => await executionSettings(engine.project));
  server.put("/api/settings/execution", async (request) => await planningJob(async () => await updateExecutionSettings(engine.project, request.body)));
  server.post("/api/settings/mcp/inspect", async (request, reply) => {
    const cancelled = new AbortController();
    const close = () => { if (!reply.raw.writableEnded) cancelled.abort(new Error("Discovery cancelled")); };
    reply.raw.once("close", close);
    try {
      return { tools: await inspectMcp(mcpServerSchema.parse(request.body), engine.project,
        AbortSignal.any([planning.signal, cancelled.signal, AbortSignal.timeout(20_000)])) };
    } finally { reply.raw.removeListener("close", close); }
  });
  server.post("/api/attachments", { bodyLimit: 8_100_000 }, async (request) => await attachments.add(request.body));
  server.get<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
    const entry = await attachments.get(request.params.id);
    reply.header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'");
    return reply.type(entry.mimeType).send(await attachments.read(entry));
  });
  server.get("/api/health", async () => ({ status: "ready", pid: process.pid }));
  server.get("/api/tasks", async () => tasks.list(true));
  server.delete<{ Params: { id: string } }>("/api/tasks/:id", async request => await tasks.remove(request.params.id));
  server.post("/api/tasks", async (request, reply) => reply.code(202).send(await tasks.create(request.body)));
  server.get<{ Params: { id: string } }>("/api/tasks/:id", async (request) => tasks.get(request.params.id));
  server.post<{ Params: { id: string } }>("/api/tasks/:id/answer", async (request) => await tasks.answer(request.params.id, request.body));
  server.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (request) => await tasks.retry(request.params.id));
  server.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request) => await tasks.cancel(request.params.id));
  server.get("/api/auth/options", async () => await auth.options());
  server.get("/api/auth/session", async () => auth.current());
  server.post("/api/auth/session", async (request) => await auth.start(request.body));
  server.post<{ Params: { id: string } }>("/api/auth/session/:id/respond", async (request) => auth.respond(request.params.id, request.body));
  server.post<{ Params: { id: string } }>("/api/auth/session/:id/cancel", async (request) => auth.cancel(request.params.id));
  server.post<{ Params: { id: string } }>("/api/auth/providers/:id/logout", async (request) => {
    await auth.logout(request.params.id);
    return { removed: true };
  });
  server.get("/api/setup", async () => ({
    ...(await projectModelSettings(engine.project)),
    providers: await providers(planning.signal),
  }));
  server.put("/api/project/model", async (request) => await planningJob(async () => ({
    ...(await updateProjectModel(engine.project, request.body, (await catalog(planning.signal)).models)),
    providers: await providers(planning.signal),
  })));
  server.post("/api/models/refresh", async () => await planningJob(async () => await catalog(planning.signal, true)));
  server.get("/api/library", async () => { const library = await loadLibrary(engine.project); return { revision: libraryHash(library), blocks: library.blocks }; });
  server.delete<{ Params: { id: string } }>("/api/library/blocks/:id", async (request) => await planningJob(async () => {
    const input = z.object({ revision: z.string() }).strict().parse(request.body);
    return await proposals.removeBlock(request.params.id, input.revision);
  }));
  server.post("/api/library/proposals", async (request) => {
    const input = z.object({
      kind: z.enum(["regenerate", "models", "manual"]), instructions: z.string().max(8000).default(""),
      allowedModels: z.array(z.string()).max(1000).default([]), changes: libraryChangesSchema.optional(),
      baseHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }).strict().parse(request.body);
    return await planningJob(async () => {
      const library = await loadLibrary(engine.project);
      if (input.baseHash && input.baseHash !== libraryHash(library)) { throw new Error("The block library changed in another session. Reload blocks before saving your edits."); }
      const current = await catalog(planning.signal);
      const models = input.allowedModels.length ? current.models.filter((model) => input.allowedModels.includes(modelKey(model))) : current.models;
      if (input.allowedModels.some((key) => !current.models.some((model) => modelKey(model) === key))) { throw new Error("The allowed model list contains an unavailable model. Refresh models and try again."); }
      if (input.kind !== "manual" && engine.mode !== "live") { throw new Error("AI block generation needs live mode"); }
      const changes = input.kind === "manual" ? input.changes : await generateLibrary({
        project: engine.project, library, kind: input.kind, models, instructions: input.instructions, signal: planning.signal, emit,
      });
      return await proposals.create(library, input.kind, changes, models);
    });
  });
  server.get<{ Params: { id: string } }>("/api/library/proposals/:id", async (request) => await proposals.get(request.params.id));
  server.post<{ Params: { id: string } }>("/api/library/proposals/:id/apply", async (request) => await planningJob(async () => {
    return await proposals.apply(request.params.id, (await catalog(planning.signal)).models);
  }));
  server.post<{ Params: { id: string } }>("/api/library/proposals/:id/reject", async (request) => await planningJob(async () => await proposals.reject(request.params.id)));
  server.get("/api/runs", async () => engine.list(true));
  server.post("/api/programs", async (request, reply) => {
    const { title, task, ...program } = programSourceSchema.extend({
      title: z.string().trim().min(1).max(200), task: z.string().trim().min(1).max(32_000),
    }).parse(request.body);
    const cancelled = new AbortController();
    const close = () => { if (!reply.raw.writableEnded) cancelled.abort(new Error("Workflow creation cancelled")); };
    reply.raw.once("close", close);
    try { return await engine.createProgram(title, task, program, await loadLibrary(engine.project),
      AbortSignal.any([planning.signal, cancelled.signal])); }
    finally { reply.raw.removeListener("close", close); }
  });
  server.put<{ Params: { id: string } }>("/api/runs/:id/program", async request =>
    await engine.updateProgram(request.params.id, request.body, expectedRevision(request.headers)));
  server.delete<{ Params: { id: string } }>("/api/runs/:id", async request => await tasks.removeRun(request.params.id));
  server.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = engine.get(request.params.id);
    reply.header("etag", `"${run.revision}"`);
    return run;
  });
  server.get<{ Params: { id: string } }>(
    "/api/runs/:id/events",
    async (request) => await engine.events(request.params.id),
  );
  server.post("/api/runs", async (request) => {
    const proposal = proposalSchema.parse(request.body);
    const library = await loadLibrary(engine.project);
    if (proposal.maxCostUsd !== undefined) {
      library.config.budget = budgetSchema.parse({ ...library.config.budget, maxCostUsd: proposal.maxCostUsd });
    }
    if (proposal.strategy === "ai" && engine.mode === "demo") {
      throw new Error(
        "AI coordination needs live mode. Demo supports bug and feature templates.",
      );
    }
    if (planningActive) {
      throw new Error("A coordinator proposal is already in progress");
    }
    planningActive = true;
    try {
      const plan =
        proposal.strategy === "ai"
          ? await planWithAi({
              project: engine.project,
              library,
              task: proposal.task,
              instructions: proposal.instructions,
              emit: (kind, message) => {
                engine.coordinatorActivity(kind, message);
              },
              signal: planning.signal,
              models: (await catalog(planning.signal)).models,
            })
          : createTemplate(proposal.task, proposal.strategy, library);
      const run = await engine.create(plan, library);

      return proposal.autoApprove ? await engine.approve(run.id) : run;
    } finally {
      planningActive = false;
    }
  });
  server.put<{ Params: { id: string } }>(
    "/api/runs/:id/plan",
    async (request) => await engine.update(request.params.id, request.body, expectedRevision(request.headers)),
  );
  server.post<{ Params: { id: string } }>("/api/runs/:id/refine", async (request, reply) => {
    const input = z.object({ instructions: z.string().min(1).max(8000) }).strict().parse(request.body);
    if (engine.mode !== "live") { throw new Error("AI workflow refinement needs live mode"); }
    const cancelled = new AbortController();
    const close = () => { if (!reply.raw.writableEnded) cancelled.abort(new Error("Refinement cancelled")); };
    const signal = AbortSignal.any([planning.signal, cancelled.signal]);
    reply.raw.once("close", close);
    try { return await planningJob(async () => {
      const run = engine.get(request.params.id);
      if (run.status !== "draft") { throw new Error("Only draft workflows can be refined"); }
      const revision = expectedRevision(request.headers);
      if (revision !== undefined && run.revision !== revision) { throw new Error("Draft changed since you loaded it. Review the latest draft and try again."); }
      if (run.program) {
        const program = await refineProgram({ project: engine.project, run, instructions: input.instructions,
          models: (await catalog(signal)).models, signal, emit });
        signal.throwIfAborted();
        return await engine.updateProgram(run.id, program, run.revision, signal);
      }
      const plan = await planWithAi({
        project: engine.project, library: { config: run.config, blocks: run.blocks }, task: run.plan.task,
        previousPlan: run.plan, instructions: input.instructions, signal, emit,
        models: (await catalog(signal)).models,
      });
      signal.throwIfAborted();
      if (plan.task !== run.plan.task) { throw new Error("AI refinement must preserve the task"); }
      return await engine.update(run.id, plan, run.revision);
    }); } finally { reply.raw.removeListener("close", close); }
  });
  server.post<{ Params: { id: string } }>(
    "/api/runs/:id/approve",
    async (request) => await engine.approve(request.params.id, expectedRevision(request.headers)),
  );
  server.post<{ Params: { id: string } }>(
    "/api/runs/:id/reject",
    async (request) => await engine.reject(request.params.id),
  );
  server.post<{ Params: { id: string } }>(
    "/api/runs/:id/cancel",
    async (request) => await engine.cancel(request.params.id),
  );
  server.post<{ Params: { id: string } }>(
    "/api/runs/:id/pause",
    async (request) => await engine.pause(request.params.id),
  );
  server.post<{ Params: { id: string } }>(
    "/api/runs/:id/resume",
    async (request) => await engine.resume(request.params.id),
  );
  server.post<{ Params: { id: string } }>("/api/runs/:id/recover", async (request) => (await engine.recover(request.params.id)).run);
  server.get("/api/stream", async (_request, reply) => {
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    const unsubscribe = engine.subscribe((event) => {
      if (!reply.raw.destroyed) {
        const accepted = reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        if (!accepted) {
          // Slow clients reconnect and fetch persisted state instead of buffering indefinitely.
          reply.raw.end();
        }
      }
    });
    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(reply.raw);
    };
    reply.raw.once("close", cleanup);
  });
  server.addHook("preClose", async () => {
    auth.close();
    planning.abort(new Error("Server closing"));
    await Promise.all([tasks.close(), designChats.close()]);
    for (const stream of streams) {
      stream.end();
    }
  });
  server.addHook("onClose", async () => {
    planning.abort(new Error("Server closing"));
    await engine.shutdown();
  });
  const webDirectory = fileURLToPath(new URL("../dist/web/", import.meta.url));
  let hasWeb = false;
  try {
    await access(path.join(webDirectory, "index.html"));
    hasWeb = true;
  } catch {
    // Development uses Vite; a production UI is only available after bun run build.
  }
  if (hasWeb) {
    await server.register(fastifyStatic, { root: webDirectory });
  } else {
    server.get("/", async () => ({
      message:
        "Workflow API is ready. Use bun run dev for the UI, or bun run build and restart.",
      mode: engine.mode,
    }));
  }

  return server;
}
