import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runAgentSession } from "../src/agent-session.js";
import { agentSchema, type UsageTotals } from "../src/domain.js";
import { textResult } from "../src/block-runner.js";
import { fixture } from "./helpers.js";

type Reply = { tool?: boolean; truncated?: boolean; error?: string };
async function responseFixture(t: TestContext, respond: (turn: number) => Reply) {
  const context = await fixture(t);
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push(await request.json());
      const turn = requests.length;
      const reply = respond(turn);
      const item = reply.tool
        ? { type: "function_call", id: `fc_${turn}`, call_id: `side_effect_${turn}`, name: "record_effect", arguments: "{}", status: "completed" }
        : { type: "message", id: `msg_${turn}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Finished.", annotations: [] }] };
      const response = { id: `resp_${turn}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
      const events = [
        { type: "response.created", response: { id: response.id, status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        ...(reply.truncated ? [] : [reply.error
          ? { type: "response.failed", response: { ...response, status: "failed", error: { code: reply.error, message: reply.error } } }
          : { type: "response.completed", response }]),
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  context.cleanup(async () => { server.stop(true); });
  const directory = path.join(context.project, "model");
  await mkdir(directory);
  await writeFile(path.join(directory, "models.json"), JSON.stringify({ providers: { "response-fixture": {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-responses", apiKey: "fixture-only",
    models: [{ id: "retry-model", contextWindow: 32000, maxTokens: 2000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const previous = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = directory;
  t.after(() => { if (previous === undefined) delete process.env.WORKFLOW_HOME; else process.env.WORKFLOW_HOME = previous; });
  let effects = 0;
  const events: { kind: string; message: string }[] = [];
  const usage: UsageTotals[] = [];
  const options: Parameters<typeof runAgentSession>[0] = {
    project: context.project, settings: agentSchema.parse({ provider: "response-fixture", model: "retry-model", thinking: "off" }),
    systemPrompt: "Record one effect, then finish.", prompt: "Run the task.",
    tools: [defineTool({
      name: "record_effect", label: "Record effect", description: "Record one test side effect.",
      parameters: Type.Object({}),
      async execute() { effects++; return textResult(`Recorded ${effects}`); },
    })],
    signal: AbortSignal.timeout(20_000),
    emit: (kind, message) => { events.push({ kind, message }); },
    onUsage: async (value) => { usage.push(value); },
  };
  return { requests, options, events, usage, effects: () => effects };
}

test("a broken Responses stream retries in the same session without replaying completed tools", async (t) => {
  const fixture = await responseFixture(t, (turn) => turn === 1 ? { tool: true } : turn === 2 ? { tool: true, truncated: true } : {});
  await runAgentSession(fixture.options);
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.effects(), 1, "Neither a completed tool nor a partial streamed call may replay");
  assert.match(JSON.stringify(fixture.requests[2]), /Recorded 1/);
  assert.ok(fixture.events.some((event) => event.kind === "agent_retry" && event.message.includes("Retrying 1/2")));
  assert.ok(fixture.events.some((event) => event.message.includes("connection recovered")));
  assert.equal(fixture.usage.at(-1)?.requests, 3);
  assert.equal(fixture.usage.at(-1)?.inputTokens, 200);
});

test("repeated broken streams exhaust retries and preserve the provider error", async (t) => {
  const fixture = await responseFixture(t, () => ({ truncated: true }));
  await assert.rejects(runAgentSession(fixture.options), /stream ended before a terminal response event/);
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.effects(), 0);
  assert.equal(fixture.usage.at(-1)?.requests, 3);
});

test("cancellation during provider backoff stops retries immediately", async (t) => {
  const fixture = await responseFixture(t, () => ({ truncated: true }));
  const controller = new AbortController();
  const started = performance.now();
  await assert.rejects(runAgentSession({
    ...fixture.options, signal: controller.signal,
    emit: (kind) => { if (kind === "agent_retry") controller.abort(new Error("User cancelled retry")); },
  }), /User cancelled retry/);
  assert.equal(fixture.requests.length, 1);
  assert.ok(performance.now() - started < 1500, "Cancellation must interrupt the two-second retry delay");
});

test("quota errors are not retried or mistaken for successful sessions", async (t) => {
  const fixture = await responseFixture(t, () => ({ error: "insufficient_quota" }));
  await assert.rejects(runAgentSession(fixture.options), /insufficient_quota/);
  assert.equal(fixture.requests.length, 1);
  assert.ok(!fixture.events.some((event) => /Retrying/.test(event.message)));
});
