import assert from "node:assert/strict";
import { test } from "vitest";
import { createApplication } from "../src/core/application.js";
import { createHttpServer } from "../src/http/http-server.js";
import { WorkflowClient } from "../src/client/client.js";
import { automationConfigSchema, workSignalSchema } from "../src/contracts/automation-schema.js";
import { fixture } from "./helpers.js";

const source = `import { workflow, block, step, z } from "workflow";
const capture = block({ input: z.object({}), run() { return { ok: true }; } });
export default workflow({ name: "Offline capture", input: z.object({}), flow: step("capture", capture) });`;

test("automation API authenticates signals, preserves revisions and exposes lifecycle state", async (t) => {
  const { project, cleanup } = await fixture(t);
  const previous = process.env.WORKFLOW_SIGNAL_TOKEN;
  cleanup(async () => {
    if (previous === undefined) delete process.env.WORKFLOW_SIGNAL_TOKEN;
    else process.env.WORKFLOW_SIGNAL_TOKEN = previous;
  });
  const app = await createApplication({
    project,
    mode: "demo",
    startTriggers: false,
    startAutomations: false,
  });
  cleanup(() => app.close());
  const http = await createHttpServer(app, 0);
  cleanup(() => http.close());
  const address = await http.listen({ host: "127.0.0.1", port: 0 });
  const client = new WorkflowClient({ baseUrl: address });
  const draft = await client.createProgram({ title: "Offline", task: "Capture", source });
  const config = automationConfigSchema.parse({
    name: "Signals",
    schedule: { kind: "signal" },
    target: { kind: "workflow", runId: draft.id },
    execution: { workspace: "project" },
    policy: { approval: "required" },
  });
  const saved = await client.saveAutomation(config);
  assert.equal(saved.state, "disabled");
  const enabled = await client.automationAction(saved.id, "enable", saved.revision);
  assert.ok("revision" in enabled);
  await assert.rejects(client.saveAutomation(config, saved.id, saved.revision));
  const signal = workSignalSchema.parse({
    sourceId: "fixture",
    resourceKey: "item-1",
    signalKind: "changed",
    revision: "1",
    fingerprint: "one",
    observedAt: "2026-01-01T00:00:00Z",
  });
  const payload = { signals: [signal] };
  delete process.env.WORKFLOW_SIGNAL_TOKEN;
  const authorized = new WorkflowClient({ baseUrl: address, signalToken: "test-only-secret" });
  await assert.rejects(authorized.emitSignals(saved.id, payload), /Signal authentication required/);
  process.env.WORKFLOW_SIGNAL_TOKEN = "test-only-secret";
  await assert.rejects(client.emitSignals(saved.id, payload), /Signal authentication required/);
  await assert.rejects(
    new WorkflowClient({ baseUrl: address, signalToken: "wrong" }).emitSignals(saved.id, payload),
    /Signal authentication required/,
  );
  const accepted = await authorized.emitSignals(saved.id, payload);
  assert.equal(accepted.observations.length, 1);
  assert.equal((await authorized.emitSignals(saved.id, payload)).observations.length, 1);
  assert.ok(!JSON.stringify(accepted).includes("test-only-secret"));
  const forbidden = await fetch(`${address}/api/automations/${saved.id}/signals`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-only-secret",
      "content-type": "application/json",
      "x-workflow-client": "1",
      origin: "https://untrusted.example",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(forbidden.status, 403);
  const noGuard = await fetch(`${address}/api/automations/${saved.id}/signals`, {
    method: "POST",
    headers: { authorization: "Bearer test-only-secret", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(noGuard.status, 403);
  const paused = await client.automationAction(saved.id, "pause", enabled.revision);
  assert.ok("state" in paused && paused.state === "paused");
  const current = (await client.automations()).automations[0]!;
  const disabled = await client.automationAction(saved.id, "disable", current.revision);
  assert.ok("state" in disabled && disabled.state === "disabled");
  assert.ok(await client.automationVersion(saved.versionId));
});
