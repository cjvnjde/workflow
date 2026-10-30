import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { HostInfo } from "./host-discovery.js";

/** Optional controls owned by the CLI host, never by a borrowed application. */
export function registerHostControl(
  server: FastifyInstance,
  options: {
    info: () => HostInfo;
    token: string;
    stop: () => void;
  },
) {
  server.get("/api/host", () => options.info());
  server.post("/api/host/stop", async (request, reply) => {
    const token = request.headers["x-workflow-host-token"];
    const expected = Buffer.from(options.token);
    const supplied = Buffer.from(typeof token === "string" ? token : "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return reply.code(403).send({ error: "This host's private shutdown token is required." });
    }
    const body = z.object({ hostId: z.string().uuid() }).strict().parse(request.body);
    if (body.hostId !== options.info().hostId)
      return reply.code(409).send({ error: "Host identity changed. No shutdown was requested." });
    // Finish the response before stopping admission and draining the worker.
    reply.raw.once("finish", () => {
      queueMicrotask(options.stop);
    });
    return reply.code(202).send({ status: "stopping", hostId: body.hostId });
  });
}
