import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

/** Source hosts share one HTTP port for the API, Vite modules, and HMR socket. */
export async function registerDevelopmentWebGui(server: FastifyInstance) {
  // Production installations omit Vite; only source hosts load this adapter.
  const { createServer } = await import("vite");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const vite = await createServer({
    configFile: path.join(root, "vite.config.ts"),
    root: path.join(root, "web"),
    server: { middlewareMode: true, ws: { server: server.server } },
  });
  server.addHook("preClose", () => vite.close());
  server.get("/*", (request, reply) => {
    // Unknown API routes must remain API 404s, not the app's HTML shell.
    if (request.url.startsWith("/api/")) return reply.callNotFound();
    reply.hijack();
    vite.middlewares(request.raw, reply.raw, (error?: unknown) => {
      reply.raw.statusCode = error ? 500 : 404;
      reply.raw.end(error ? "Development web request failed" : "Not found");
    });
  });
}
