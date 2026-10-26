import path from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

/** Optional presentation assets. The engine and API do not import this module. */
export async function registerWebGui(server: FastifyInstance, directory = fileURLToPath(new URL("../dist/web/", import.meta.url))) {
  try { await access(path.join(directory, "index.html")); }
  catch {
    server.get("/", async () => ({ message: "Workflow API is ready. Use bun run dev for the UI, or bun run build and restart." }));
    return;
  }
  const { default: fastifyStatic } = await import("@fastify/static");
  await server.register(fastifyStatic, { root: directory });
}
