import type { WorkflowEngine } from "../core/engine.js";
import { attachApplication, type ApplicationServices } from "../core/application.js";
import { createHttpServer } from "./http-server.js";
import { registerWebGui } from "./web-server.js";

/** Compatibility entry point. New hosts own createApplication/createHttpServer separately. */
export async function createServer(
  engine: WorkflowEngine,
  port = 4310,
  services: ApplicationServices = {},
) {
  const app = await attachApplication(engine, services);
  try {
    const server = await createHttpServer(app, port);
    server.addHook("preClose", () => app.close());
    await registerWebGui(server);
    return server;
  } catch (error) {
    await app.close();
    throw error;
  }
}
