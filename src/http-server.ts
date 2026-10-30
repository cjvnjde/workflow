import { historyQuerySchema } from "./execution-history.js";
import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";
import type { WorkflowApplication } from "./application.js";

// Optional for API compatibility; the browser always sends its reviewed revision.
const expectedRevision = (headers: { "if-match"?: string }) => {
  if (headers["if-match"] === undefined) { return undefined; }
  const value = z.string().regex(/^"\d+"$/, "If-Match must contain a quoted draft revision").parse(headers["if-match"]);
  return z.number().int().nonnegative().parse(Number(value.slice(1, -1)));
};

/** HTTP is a borrowed adapter: closing it never stops the application. */
export async function createHttpServer(app: WorkflowApplication, port = 4310) {
  const server = Fastify({ bodyLimit: 1_000_000, logger: false, forceCloseConnections: true });
  const streams = new Set<import("node:http").ServerResponse>();
  const requests = new AbortController();
  const cancellable = async <T>(reply: FastifyReply, action: (signal: AbortSignal) => Promise<T>) => {
    const cancelled = new AbortController();
    const close = () => { if (!reply.raw.writableEnded) cancelled.abort(new Error("Request cancelled")); };
    reply.raw.once("close", close);
    try { return await action(AbortSignal.any([requests.signal, cancelled.signal])); }
    finally { reply.raw.removeListener("close", close); }
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
  server.get("/api/project", () => app.getProject());
  server.get("/api/health", async () => ({ status: "ready", pid: process.pid }));
  server.get("/api/models", () => app.models());
  server.post("/api/models/refresh", () => app.refreshModels());
  server.get("/api/setup", () => app.setup());
  server.post("/api/setup-jobs", async (request, reply) => reply.code(202).send(await app.startSetup(request.body)));
  server.get("/api/setup-jobs/latest", () => app.setupJobs.latest());
  server.get<{ Params: { id: string } }>("/api/setup-jobs/:id", request => app.setupJobs.get(request.params.id));
  server.post<{ Params: { id: string } }>("/api/setup-jobs/:id/resume", async (request, reply) => reply.code(202).send(await app.resumeSetup(request.params.id, request.body)));
  server.post<{ Params: { id: string } }>("/api/setup-jobs/:id/cancel", request => app.setupJobs.cancel(request.params.id, request.body));
  server.get<{ Params: { id: string } }>("/api/setup-jobs/:id/usage", request => app.setupJobs.usage(request.params.id));
  server.get("/api/usage", () => app.usage());
  server.get("/api/memory", () => app.memory());
  server.put("/api/memory", request => app.setMemoryEnabled(request.body));
  server.get<{ Params: { id: string } }>("/api/memory/entries/:id", request => app.memoryEntry(request.params.id));
  server.post("/api/memory/entries", request => app.createMemoryEntry(request.body));
  server.patch<{ Params: { id: string } }>("/api/memory/entries/:id", request => app.updateMemoryEntry(request.params.id, request.body));
  server.delete<{ Params: { id: string } }>("/api/memory/entries/:id", request => app.deleteMemoryEntry(request.params.id, request.body));
  server.get<{ Params: { id: string } }>("/api/tasks/:id/usage", request => app.taskUsage(request.params.id));
  server.get<{ Params: { id: string } }>("/api/runs/:id/usage", request => app.runUsage(request.params.id));
  server.put("/api/project/model", request => app.updateProjectModel(request.body));
  server.get("/api/settings/orchestration", () => app.orchestration());
  server.put("/api/settings/orchestration", request => app.updateOrchestration(request.body));
  server.get("/api/settings/execution", () => app.executionSettings());
  server.put("/api/settings/execution", request => app.updateExecutionSettings(request.body));
  server.post("/api/settings/mcp/inspect", (request, reply) => cancellable(reply, signal => app.inspectMcp(request.body, signal)));
  server.post("/api/format", request => app.format(request.body));
  server.get("/api/library", () => app.library());
  server.post("/api/library/proposals", request => app.createProposal(request.body));
  server.post("/api/design", request => app.designChats.create(request.body));
  server.get<{ Params: { scope: string } }>("/api/design/:scope/latest", request => app.latestDesign(request.params.scope));
  server.get("/api/tasks", async () => app.tasks.list(true));
  server.get("/api/triggers", () => app.triggers.state());
  server.post("/api/triggers", request => app.triggers.save(request.body));
  server.post("/api/triggers/poll", async () => { await app.triggers.tick(true); return app.triggers.state(); });
  server.post<{ Params: { id: string } }>("/api/triggers/:id/test", request => app.triggers.test(request.params.id, request.body));
  server.post<{ Params: { id: string; action: string } }>("/api/trigger-events/:id/:action", request =>
    app.triggers.action(request.params.id, z.enum(["retry", "cancel"]).parse(request.params.action)));
  server.post("/api/tasks", async (request, reply) => reply.code(202).send(await app.tasks.create(request.body)));
  server.get("/api/auth/options", () => app.auth.options());
  server.get("/api/auth/session", async () => app.auth.current());
  server.post("/api/auth/session", request => app.auth.start(request.body));
  server.post("/api/attachments", { bodyLimit: 8_100_000 }, request => app.attachments.add(request.body));
  server.get<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
    const entry = await app.attachments.get(request.params.id);
    reply.header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'");
    return reply.type(entry.mimeType).send(await app.attachments.read(entry));
  });
  server.get("/api/runs", async () => app.listRuns());
  server.post("/api/programs", (request, reply) => cancellable(reply, signal => app.createProgram(request.body, signal)));
  server.post("/api/runs", (request, reply) => cancellable(reply, signal => app.createRun(request.body, signal)));
  server.get<{ Params: { id: string } }>("/api/design/:id", async request => app.designChats.get(request.params.id));
  server.post<{ Params: { id: string } }>("/api/design/:id/messages", async (request, reply) => reply.code(202).send(await app.designChats.send(request.params.id, request.body)));
  server.post<{ Params: { id: string } }>("/api/design/:id/cancel", async request => app.designChats.cancel(request.params.id));
  server.post<{ Params: { id: string } }>("/api/design/:id/discard", async request => app.designChats.discard(request.params.id, request.body));
  server.post<{ Params: { id: string } }>("/api/design/:id/apply", async request => app.applyDesign(request.params.id, request.body));
  server.delete<{ Params: { id: string } }>("/api/tasks/:id", async request => app.tasks.remove(request.params.id));
  server.get<{ Params: { id: string } }>("/api/tasks/:id", async request => app.tasks.get(request.params.id));
  server.post<{ Params: { id: string } }>("/api/tasks/:id/answer", async request => app.tasks.answer(request.params.id, request.body));
  server.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async request => app.tasks.retry(request.params.id));
  server.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async request => app.tasks.cancel(request.params.id));
  server.post<{ Params: { id: string } }>("/api/auth/session/:id/respond", async request => app.auth.respond(request.params.id, request.body));
  server.post<{ Params: { id: string } }>("/api/auth/session/:id/cancel", async request => app.auth.cancel(request.params.id));
  server.delete<{ Params: { id: string } }>("/api/library/blocks/:id", async request => app.removeBlock(request.params.id, request.body));
  server.get<{ Params: { id: string } }>("/api/library/proposals/:id", async request => app.getProposal(request.params.id));
  server.post<{ Params: { id: string } }>("/api/library/proposals/:id/apply", async request => app.applyProposal(request.params.id));
  server.post<{ Params: { id: string } }>("/api/library/proposals/:id/reject", async request => app.rejectProposal(request.params.id));
  server.put<{ Params: { id: string } }>("/api/runs/:id/program", async request => app.updateProgram(request.params.id, request.body, expectedRevision(request.headers)));
  server.put<{ Params: { id: string } }>("/api/runs/:id/plan", async request => app.updatePlan(request.params.id, request.body, expectedRevision(request.headers)));
  server.delete<{ Params: { id: string } }>("/api/runs/:id", async request => app.removeRun(request.params.id));
  server.get<{ Params: { id: string } }>("/api/runs/:id/events", async request => app.events(request.params.id));
  server.get<{ Params: { id: string } }>("/api/runs/:id/history", request => app.history(request.params.id, historyQuerySchema.parse(request.query)));
  server.get<{ Params: { id: string } }>("/api/runs/:id/execution", request => app.execution(request.params.id));
  server.get<{ Params: { id: string } }>("/api/runs/:id/report-evidence", request => app.reportEvidence(request.params.id));
  server.get<{ Params: { id: string }; Querystring: { key: string } }>("/api/runs/:id/operation-events", request =>
    app.operationEvents(request.params.id, z.string().min(1).max(4000).parse(request.query.key)));

  server.get<{ Params: { id: string } }>("/api/runs/:id/strategy-preview", (request, reply) => cancellable(reply, signal => app.strategyPreview(request.params.id, signal)));
  server.post<{ Params: { id: string } }>("/api/runs/:id/remember", (request, reply) => cancellable(reply, signal => app.rememberStrategy(request.params.id, request.body, signal)));
  server.get<{ Params: { id: string; nodeId: string; visit: string } }>("/api/runs/:id/attempts/:nodeId/:visit/evidence", request =>
    app.attemptEvidence(request.params.id, request.params.nodeId, z.coerce.number().int().positive().parse(request.params.visit)));
  server.get<{ Params: { id: string; nodeId: string; visit: string; contentId: string }; Querystring: { download?: string } }>("/api/runs/:id/attempts/:nodeId/:visit/content/:contentId", async (request, reply) => {
    const content = await app.evidenceContent(request.params.id, request.params.nodeId, z.coerce.number().int().positive().parse(request.params.visit), request.params.contentId);
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "default-src 'none'; sandbox");
    if (request.query.download === "1") reply.header("content-disposition", `attachment; filename="evidence-${content.ref.id}.${content.ref.mediaType === "application/json" ? "json" : content.ref.mediaType.startsWith("text/") ? "txt" : "bin"}"`);
    return reply.type(content.ref.mediaType).send(content.data);
  });
  server.get<{ Params: { id: string; nodeId: string; visit: string; captureId: string; stream: string } }>("/api/runs/:id/attempts/:nodeId/:visit/outputs/:captureId/:stream", async (request, reply) => {
    const { id, nodeId } = request.params;
    const visit = z.coerce.number().int().positive().parse(request.params.visit);
    const captureId = z.string().uuid().parse(request.params.captureId);
    const stream = z.enum(["stdout", "stderr", "output"]).parse(request.params.stream);
    const query = z.object({ offset: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().min(1).max(256000).optional(), download: z.enum(["0", "1"]).optional() }).strict().parse(request.query);
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "default-src 'none'; sandbox");
    if (query.download === "1") {
      const output = await app.commandOutputDownload(id, nodeId, visit, captureId, stream);
      reply.header("content-disposition", `attachment; filename="${captureId}-${stream}.txt"`);
      reply.header("x-workflow-output-truncated", String(output.reference.truncated));
      return reply.type("text/plain; charset=utf-8").send(output.stream);
    }
    return app.commandOutput(id, nodeId, visit, captureId, stream, query);
  });
  server.post<{ Params: { id: string } }>("/api/runs/:id/refine", async (request, reply) => cancellable(reply, signal => app.refine(request.params.id, request.body, expectedRevision(request.headers), signal)));
  server.post<{ Params: { id: string } }>("/api/runs/:id/approve", async request => app.approve(request.params.id, expectedRevision(request.headers)));
  server.post<{ Params: { id: string } }>("/api/runs/:id/reject", async request => app.reject(request.params.id));
  server.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async request => app.cancel(request.params.id));
  server.post<{ Params: { id: string } }>("/api/runs/:id/pause", async request => app.pause(request.params.id));
  server.post<{ Params: { id: string } }>("/api/runs/:id/resume", async request => app.resume(request.params.id));
  server.post<{ Params: { id: string } }>("/api/runs/:id/recover", async request => app.recover(request.params.id));
  server.post<{ Params: { id: string } }>("/api/runs/:id/keep-recovery-files", async request => app.keepRecoveryFiles(request.params.id));
  server.post<{ Params: { id: string } }>("/api/auth/providers/:id/logout", async request => {
    await app.auth.logout(request.params.id);
    return { removed: true };
  });
  server.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = app.getRun(request.params.id);
    reply.header("etag", `"${run.revision}"`);
    return run;
  });
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
    const unsubscribe = app.subscribe((event) => {
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
    requests.abort(new Error("HTTP adapter closing"));
    for (const stream of streams) stream.end();
  });
  return server;
}
