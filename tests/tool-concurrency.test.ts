import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { agentSchema } from "../src/contracts/domain.js";
import { runAgentSession } from "../src/core/models/agent-session.js";
import { fixture } from "./helpers.js";

async function scenario(
  t: TestContext,
  names: string[],
  limit: number | undefined,
  cancel = false,
) {
  const { project, cleanup } = await fixture(t);
  let turns = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json();
      turns++;
      const items =
        turns === 1
          ? names.map((name, index) => ({
              type: "function_call",
              id: `fc_${index}`,
              call_id: `call_${index}`,
              name,
              arguments: "{}",
              status: "completed",
            }))
          : [
              {
                type: "message",
                id: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "Finished", annotations: [] }],
              },
            ];
      const response = {
        id: `response_${turns}`,
        status: "completed",
        output: items,
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      };
      return new Response(
        [
          { type: "response.created", response: { id: response.id, status: "in_progress" } },
          ...items.flatMap((item, output_index) => [
            { type: "response.output_item.added", output_index, item },
            { type: "response.output_item.done", output_index, item },
          ]),
          { type: "response.completed", response },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  cleanup(async () => {
    server.stop(true);
  });
  const home = path.join(project, "provider");
  await mkdir(home);
  await writeFile(
    path.join(home, "models.json"),
    JSON.stringify({
      providers: {
        "concurrency-fixture": {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: "openai-responses",
          apiKey: "fixture-only",
          models: [
            {
              id: "fixture",
              contextWindow: 32000,
              maxTokens: 2000,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const previous = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = home;
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = previous;
  });
  const controller = new AbortController();
  let active = 0,
    peak = 0;
  const started: string[] = [],
    completed: string[] = [];
  const tools = ["read_file", "write_file"].map((name) =>
    defineTool({
      name,
      label: name,
      description: "Controlled concurrency fixture",
      parameters: Type.Object({}),
      executionMode: name === "read_file" ? "parallel" : "sequential",
      async execute(id) {
        active++;
        peak = Math.max(peak, active);
        started.push(`${name}:${id}`);
        if (cancel && active === 2) controller.abort(new Error("Stop queued tools"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        completed.push(`${name}:${id}`);
        return { content: [{ type: "text" as const, text: "done" }], details: {} };
      },
    }),
  );
  const work = runAgentSession({
    project,
    settings: agentSchema.parse({
      provider: "concurrency-fixture",
      model: "fixture",
      thinking: "off",
      ...(limit === undefined ? {} : { maxParallelTools: limit }),
    }),
    systemPrompt: "Execute the provided tools then finish",
    prompt: "Start",
    tools,
    signal: controller.signal,
    emit: () => {},
  });
  if (cancel) await assert.rejects(work, /Stop queued tools/);
  else await work;
  return { peak, started, completed, active, turns };
}

test("opt-in read batches overlap under the configured bound", async (t) => {
  const value = await scenario(t, Array(5).fill("read_file"), 2);
  assert.equal(value.peak, 2);
  assert.equal(value.started.length, 5);
  assert.equal(value.completed.length, 5);
  assert.equal(value.active, 0);
});

test("defaults remain sequential and a mutation makes the entire mixed batch exclusive", async (t) => {
  const defaults = await scenario(t, ["read_file", "read_file"], undefined);
  assert.equal(defaults.peak, 1);
  const mixed = await scenario(t, ["read_file", "read_file", "write_file", "read_file"], 3);
  assert.equal(mixed.peak, 1);
  assert.deepEqual(
    mixed.started.map((item) => item.split(":")[0]),
    ["read_file", "read_file", "write_file", "read_file"],
  );
});

test("cancelling a parallel read batch stops queued tools and drains running calls", async (t) => {
  const value = await scenario(t, Array(6).fill("read_file"), 2, true);
  assert.equal(value.started.length, 2);
  assert.equal(value.completed.length, 2);
  assert.equal(value.active, 0);
  assert.equal(value.turns, 1);
});
