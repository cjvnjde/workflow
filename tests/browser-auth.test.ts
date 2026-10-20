import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { BrowserAuth } from "../src/browser-auth.js";
import { WorkflowEngine } from "../src/engine.js";
import { createServer } from "../src/server.js";
import { authRuntime } from "./auth-fixture.js";
import { fixture, passingRunner } from "./helpers.js";

const headers = { host: "127.0.0.1:4310", "x-workflow-client": "1" };
async function context(t: TestContext) {
  const result = await fixture(t);
  const previous = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = path.join(result.project, "user-settings");
  t.after(() => { if (previous === undefined) { delete process.env.WORKFLOW_HOME; } else { process.env.WORKFLOW_HOME = previous; } });
  return result;
}
async function settled(auth: BrowserAuth) {
  for (let tries = 0; tries < 100 && auth.current()?.status === "pending"; tries++) { await Bun.sleep(5); }
  assert.notEqual(auth.current()?.status, "pending");
  return auth.current()!;
}

test("browser sign-in only offers ChatGPT OAuth and API keys, without echoing submitted secrets", async (t) => {
  const { project, cleanup } = await context(t);
  let received = "";
  const secret = "test-only-private-api-key";
  const auth = new BrowserAuth(async () => authRuntime(async (_provider, _method, interaction) => {
    received = await interaction.prompt({ type: "secret", message: "Enter API key" });
    return { type: "api_key", key: received };
  }));
  const server = await createServer(new WorkflowEngine(project, "demo", passingRunner), 4310, { auth });
  cleanup(() => server.close());
  const options = await server.inject({ method: "GET", url: "/api/auth/options", headers });
  assert.deepEqual(options.json(), [
    { id: "openai", name: "OpenAI", methods: ["oauth", "api_key"] },
    { id: "test", name: "Test provider", methods: ["api_key"] },
  ]);
  assert.equal((await server.inject({ method: "GET", url: "/api/auth/session", headers: { host: headers.host } })).statusCode, 403);
  assert.equal((await server.inject({ method: "POST", url: "/api/auth/session", headers: { ...headers, origin: "https://evil.example" }, payload: { provider: "test", method: "api_key" } })).statusCode, 403);
  assert.equal((await server.inject({ method: "POST", url: "/api/auth/session", headers, payload: { provider: "test", method: "oauth" } })).statusCode, 409);
  const started = await server.inject({ method: "POST", url: "/api/auth/session", headers, payload: { provider: "test", method: "api_key" } });
  assert.equal(started.statusCode, 200, started.body);
  const session = started.json();
  assert.equal(session.prompt.type, "secret");
  const answered = await server.inject({ method: "POST", url: `/api/auth/session/${session.id}/respond`, headers, payload: { promptId: session.prompt.id, value: secret } });
  assert.equal(answered.statusCode, 200);
  assert.ok(!answered.body.includes(secret));
  assert.equal((await settled(auth)).status, "succeeded");
  assert.equal(received, secret);
  const duplicate = await server.inject({ method: "POST", url: `/api/auth/session/${session.id}/respond`, headers, payload: { promptId: session.prompt.id, value: secret } });
  assert.equal(duplicate.statusCode, 409);
  const status = await server.inject({ method: "GET", url: "/api/auth/session", headers });
  assert.equal(status.headers["cache-control"], "no-store");
  assert.ok(!status.body.includes(secret));
  const removed = await server.inject({ method: "POST", url: "/api/auth/providers/test/logout", headers, payload: {} });
  assert.equal(removed.statusCode, 200);
  assert.equal(auth.current(), null);
});

test("browser OAuth supports callback prompt cancellation, explicit cancel and sanitized failures", async (t) => {
  await context(t);
  const auth = new BrowserAuth(async () => authRuntime(async (_provider, _method, interaction) => {
    interaction.notify({ type: "auth_url", url: "https://auth.openai.com/authorize?state=test-state" });
    const manual = new AbortController();
    const answer = interaction.prompt({ type: "manual_code", message: "Paste callback", signal: manual.signal });
    manual.abort();
    await assert.rejects(answer);
    assert.equal(auth.current()?.prompt, undefined);
    await interaction.prompt({ type: "secret", message: "Second prompt" });
    throw new Error("sensitive-provider-response-that-must-not-leak");
  }));
  t.after(() => auth.close());
  const first = await auth.start({ provider: "openai", method: "oauth" });
  await assert.rejects(auth.start({ provider: "openai", method: "oauth" }), /already in progress/);
  auth.cancel(first.id);
  assert.equal((await settled(auth)).status, "cancelled");
  const second = await auth.start({ provider: "openai", method: "oauth" });
  for (let tries = 0; tries < 100 && auth.current()?.prompt?.type !== "secret"; tries++) { await Bun.sleep(5); }
  const prompt = auth.current()!.prompt!;
  auth.respond(second.id, { promptId: prompt.id, value: "private-test-response" });
  const failed = await settled(auth);
  assert.equal(failed.status, "failed");
  assert.ok(!JSON.stringify(failed).includes("sensitive-provider"));
  assert.equal(failed.prompt, undefined);
  assert.deepEqual(failed.events, []);
});

test("server shutdown aborts pending browser login and releases its prompt", async (t) => {
  await context(t);
  const auth = new BrowserAuth(async () => authRuntime(async (_provider, _method, interaction) => {
    await interaction.prompt({ type: "secret", message: "Enter API key" });
    return { type: "api_key", key: "never-saved" };
  }));
  await auth.start({ provider: "test", method: "api_key" });
  auth.close();
  assert.equal((await settled(auth)).status, "cancelled");
  await assert.rejects(auth.start({ provider: "test", method: "api_key" }), /closing/);
});
