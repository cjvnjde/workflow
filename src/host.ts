import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createApplication } from "./core/index.js";
import { createHttpServer, registerWebGui } from "./web/index.js";
import { announceProjectServer, type HostInfo } from "./host-discovery.js";
import { registerHostControl } from "./host-control.js";
import type { TemporalOptions } from "./temporal-runtime.js";

/** Composition root. The core application itself never imports HTTP or a GUI. */
export async function runHost(options: {
  project: string; port: number; mode: "live" | "demo"; web: boolean;
  background?: boolean; hostId?: string; temporal?: TemporalOptions;
}) {
  const hostId = options.hostId ?? randomUUID();
  z.string().uuid().parse(hostId);
  if (options.background && (!process.send || !process.connected)) throw new Error("Background hosts must be started with workflow start.");
  const token = randomUUID();
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const stop = () => controller.abort();
  let acknowledged = !options.background;
  let ready = false;
  const disconnect = () => { if (!acknowledged) stop(); };
  const message = (value: unknown) => {
    if (ready && value && typeof value === "object" && "type" in value && value.type === "detach" && "hostId" in value && value.hostId === hostId) {
      acknowledged = true;
      process.disconnect?.();
    }
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  if (options.background) { process.once("disconnect", disconnect); process.on("message", message); }
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let server: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  let unannounce: (() => Promise<void>) | undefined;
  try {
    app = await createApplication({ project: options.project, mode: options.mode, temporal: options.temporal });
    if (controller.signal.aborted) return;
    server = await createHttpServer(app, options.port);
    const application = app;
    server.addHook("preClose", () => application.close());
    let address = "";
    const info = (): HostInfo => ({ hostId, project: application.project, url: address, pid: process.pid,
      mode: application.mode, background: !!options.background, web: options.web, startedAt, state: controller.signal.aborted ? "stopping" : "ready" });
    registerHostControl(server, { info, token, stop });
    if (options.web) await registerWebGui(server);
    address = await server.listen({ port: options.port, host: "127.0.0.1" });
    unannounce = await announceProjectServer(application.project, address, { hostId, token });
    console.log(`Workflow ${app.mode.toUpperCase()} · ${address}${options.web ? "" : " · API only"}\nProject: ${application.project}`);
    if (options.mode === "demo") console.log("DEMO: agents and checks are simulated. No task files are changed.");
    ready = true;
    if (options.background && process.connected) process.send?.({ type: "ready", host: info() });
    if (!controller.signal.aborted) await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  } finally {
    try { await server?.close(); }
    finally {
      try { await app?.close(); }
      finally {
        try { await unannounce?.(); }
        finally {
          process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
          process.removeListener("disconnect", disconnect); process.removeListener("message", message);
        }
      }
    }
  }
}
