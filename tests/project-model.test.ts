import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { WorkflowEngine } from "../src/engine.js";
import { createServer } from "../src/server.js";
import { createTemplate } from "../src/templates.js";
import { loadLibrary } from "../src/library.js";
import { setupSchema } from "../src/setup-schema.js";
import { fixture, passingRunner } from "./helpers.js";

const headers = { host: "127.0.0.1:4310", "x-workflow-client": "1" };

test("browser model controls validate choices, preserve snapshots and reject stale settings", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const filename = path.join(project, ".workflow", "config.json");
  const original = JSON.parse(await readFile(filename, "utf8"));
  original.agent = { timeoutMs: 12345, maxToolCalls: 17 };
  await writeFile(filename, JSON.stringify(original));
  const engine = new WorkflowEngine(project, "demo", passingRunner);
  const server = await createServer(engine, 4310, {
    providers: async () => [{ id: "test", name: "Test provider", method: "api_key", source: "stored" }],
    catalog: async () => ({ warnings: [], models: [{ provider: "test", id: "basic", name: "Test model", reasoning: false, thinkingLevels: ["off"], contextWindow: 32000, maxTokens: 4000, cost: null }] }),
  });
  cleanup(() => server.close());
  const run = await engine.create(createTemplate("Frozen model snapshot", "feature", library), library);
  const setup = setupSchema.parse((await server.inject({ method: "GET", url: "/api/setup", headers })).json());
  assert.deepEqual(setup.providers, [{ id: "test", name: "Test provider", method: "api_key", source: "stored" }]);
  const agent = { provider: "test", model: "basic", thinking: "off" };
  for (const bad of [{ ...agent, model: "missing" }, { ...agent, thinking: "high" }]) {
    const response = await server.inject({ method: "PUT", url: "/api/project/model", headers, payload: { configRevision: setup.configRevision, agent: bad } });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), original);
  }
  const saved = await server.inject({ method: "PUT", url: "/api/project/model", headers, payload: { configRevision: setup.configRevision, agent } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), { ...original, agent: { ...original.agent, ...agent } });
  assert.equal((await loadLibrary(project)).config.agent.model, "basic");
  assert.deepEqual(engine.get(run.id).config, run.config);
  const stale = await server.inject({ method: "PUT", url: "/api/project/model", headers, payload: { configRevision: setup.configRevision, agent: null } });
  assert.equal(stale.statusCode, 409);
  assert.match(stale.json().error, /settings changed/);
  const reset = await server.inject({ method: "PUT", url: "/api/project/model", headers, payload: { configRevision: saved.json().configRevision, agent: null } });
  assert.equal(reset.statusCode, 200);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), original);
});
