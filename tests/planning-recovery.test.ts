import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers.js";
import { planTask } from "../src/task-planner.js";
import { taskSchema } from "../src/task-schema.js";
import { orchestrationSchema } from "../src/orchestration-schema.js";
import { runAgentSession } from "../src/agent-session.js";
import { agentSchema, type UsageTotals } from "../src/domain.js";

type ModelRequest = { messages: { role: string; content?: unknown }[] };
type Reply = string | { name: string; arguments: string };

async function modelFixture(t: TestContext, respond: (turn: number, request: ModelRequest) => Reply) {
  const context = await fixture(t);
  const requests: ModelRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const input = await request.json() as ModelRequest;
      requests.push(input);
      const reply = respond(requests.length, input);
      const delta = typeof reply === "string" ? { role: "assistant", content: reply } : {
        role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: reply }],
      };
      const chunk = { id: `reply-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "planner", choices: [{ index: 0, delta, finish_reason: null }] };
      const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: typeof reply === "string" ? "stop" : "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  context.cleanup(async () => { server.stop(true); });
  const directory = path.join(context.project, "model-fixture");
  await mkdir(directory);
  await writeFile(path.join(directory, "models.json"), JSON.stringify({ providers: {
    "planning-fixture": {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "planner", contextWindow: 32000, maxTokens: 2000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
    },
  } }));
  const previous = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = directory;
  t.after(() => { if (previous === undefined) { delete process.env.WORKFLOW_HOME; } else { process.env.WORKFLOW_HOME = previous; } });
  context.library.config.agent = agentSchema.parse({ provider: "planning-fixture", model: "planner", thinking: "off" });
  const events: { kind: string; message: string }[] = [];
  const options = {
    project: context.project, library: context.library,
    settings: orchestrationSchema.parse({}),
    task: taskSchema.parse({ id: randomUUID(), revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "planning", prompt: "Review changes", attachments: [], answers: [], approval: "review" }),
    models: [{ provider: "planning-fixture", id: "planner", name: "Planner", reasoning: false, thinkingLevels: ["off"], contextWindow: 32000, maxTokens: 2000, cost: null }],
    signal: AbortSignal.timeout(10_000),
    emit: (kind: string, message: string) => { events.push({ kind, message }); },
  };
  return { ...context, requests, events, options };
}
const call = (name: string, args: Record<string, unknown>): Reply => ({ name, arguments: JSON.stringify(args) });
const review = {
  title: "Review working files", task: "Review the accessible files without a commit baseline", entry: "review",
  nodes: [{ id: "review", block: "review", label: "Review files", goal: "Inspect working files read-only; no commit baseline is available.", maxVisits: 1, on: { pass: "$complete", retry: "$failed", fail: "$failed" } }],
};

test("a real Pi session repairs a rejected plan after a premature final answer without losing context", async (t) => {
  const fixture = await modelFixture(t, (turn) => {
    if (turn === 1) { return call("choose_task_case", { id: "investigation", reason: "Review, not implementation" }); }
    if (turn === 2) { return call("submit_plan", { json: JSON.stringify({ ...review, entry: "missing" }), rationale: "No commits; inspect working files" }); }
    if (turn === 3) { return "I've planned a read-only working-files review."; }
    return call("submit_plan", { json: JSON.stringify(review), rationale: "Review working files and state the missing baseline." });
  });
  const result = await planTask(fixture.options);
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") { return; }
  assert.equal(result.plan.task, "Review changes");
  assert.match(result.plan.nodes[0]!.goal, /no commit baseline/);
  assert.equal(fixture.requests.length, 4);
  assert.ok(fixture.requests[3]!.messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes("entry must exist")));
  assert.ok(fixture.requests[3]!.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Correct the rejected submission")));
  assert.equal(fixture.events.filter(event => event.kind === "agent_continuation").length, 1);
  assert.ok(fixture.events.some(event => event.kind === "tool_end" && /submit_plan: error\n.*entry must exist/s.test(event.message)));
  assert.equal(JSON.parse(fixture.events.filter(event => event.kind === "usage").at(-1)!.message).requests, 4);
});

test("planning continuations are bounded when the model never submits a graph", async (t) => {
  const fixture = await modelFixture(t, () => "I will prepare a workflow.");
  await assert.rejects(planTask(fixture.options), /after automatic correction/);
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.events.filter(event => event.kind === "agent_continuation").length, 2);
});

test("planning correction cannot reset the tool-call budget or continue after cancellation", async (t) => {
  const fixture = await modelFixture(t, turn => turn === 1
    ? call("choose_task_case", { id: "investigation", reason: "Review" })
    : "Ready to plan.");
  fixture.options.library.config.agent.maxToolCalls = 1;
  await assert.rejects(planTask(fixture.options), /Tool-call budget exhausted/);
  assert.equal(fixture.requests.length, 2);
  const controller = new AbortController();
  const requestsBefore = fixture.requests.length;
  await assert.rejects(planTask({
    ...fixture.options, signal: controller.signal,
    emit: (kind) => { if (kind === "agent_message") { controller.abort(new Error("User stopped planning")); } },
  }), /User stopped planning/);
  assert.equal(fixture.requests.length, requestsBefore + 1);
});

test("continuations retain cumulative spending and stop subsequent requests at the budget", async (t) => {
  const fixture = await modelFixture(t, () => "Still planning.");
  const usage: UsageTotals[] = [];
  await assert.rejects(runAgentSession({
    project: fixture.project, settings: fixture.library.config.agent,
    systemPrompt: "Submit a plan.", prompt: "Review changes", tools: [],
    signal: AbortSignal.timeout(10_000), emit: () => {}, maxCostUsd: 0.0003,
    onUsage: async value => { usage.push(value); },
    completion: { isComplete: () => false, prompt: () => "Finish the submission." },
  }), /spending limit/);
  assert.equal(fixture.requests.length, 2);
  assert.equal(usage.at(-1)!.requests, 2);
  assert.ok(usage.at(-1)!.costUsd >= 0.0003);
});
