import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runAgentSession } from "../src/core/models/agent-session.js";
import { agentSchema, runSchema } from "../src/contracts/domain.js";
import { EvidenceStore } from "../src/core/storage/evidence-store.js";
import type { AttemptEvidence, StoredEvidenceValue } from "../src/contracts/evidence-schema.js";
import { createAccountingContext, UsageStore } from "../src/core/storage/usage-store.js";
import { createTemplate } from "../src/core/library/templates.js";
import { fixture } from "./helpers.js";

test("actual AI dispatches capture application context, prompts, images and complete tool feedback under the original run", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const workspace = path.join(project, "worktree"),
    home = path.join(project, "provider");
  await Promise.all([mkdir(workspace), mkdir(home)]);
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      const turn = requests.length;
      const item =
        turn < 3
          ? {
              type: "function_call",
              id: `fc_${turn}`,
              call_id: `call_${turn}`,
              name: "inspect",
              arguments: JSON.stringify({ count: turn === 1 ? "invalid" : 2, label: "2" }),
              status: "completed",
            }
          : {
              type: "message",
              id: `msg_${turn}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Finished.", annotations: [] }],
            };
      const response = {
        id: `resp_${turn}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      };
      return new Response(
        [
          { type: "response.created", response: { id: response.id, status: "in_progress" } },
          { type: "response.output_item.added", output_index: 0, item },
          { type: "response.output_item.done", output_index: 0, item },
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
  await writeFile(
    path.join(home, "models.json"),
    JSON.stringify({
      providers: {
        "evidence-fixture": {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: "openai-responses",
          apiKey: "private-test-credential",
          models: [
            {
              id: "vision",
              input: ["text", "image"],
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
  t.after(() => {
    if (previous === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = previous;
  });
  const runId = randomUUID(),
    identity = { runId, nodeId: "prepare", visit: 2 };
  const accounting = await createAccountingContext(project, "execution", {
    runId,
    nodeId: "prepare",
    visit: 2,
    operationId: "prepare:call:7",
    activityAttempt: 3,
  });
  const fullText = "Complete model-facing feedback ".repeat(2000);
  const image = Buffer.from("image-fixture");
  let executed = 0;
  const operations: import("../src/contracts/operation-schema.js").OperationRecord[] = [];
  await runAgentSession({
    project: workspace,
    accounting,
    contextMode: "none",
    operation: {
      parentId: accounting.operationId,
      record: async (record) => {
        operations.push(record);
      },
    },
    settings: agentSchema.parse({ provider: "evidence-fixture", model: "vision", thinking: "off" }),
    systemPrompt: "Inspect the selected input only.",
    prompt: "Check this image and record the result.",
    images: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }],
    tools: [
      defineTool({
        name: "inspect",
        label: "Inspect",
        description: "Inspect a typed record.",
        parameters: Type.Object({ count: Type.Number(), label: Type.String() }),
        async execute(_id, args) {
          executed++;
          args.count = 99;
          return {
            content: [{ type: "text" as const, text: fullText }],
            details: { count: 2, label: "2" },
          };
        },
      }),
    ],
    signal: AbortSignal.timeout(20_000),
    emit() {},
    completion: {
      isComplete: () => requests.length >= 4,
      prompt: () => "Submit the final result.",
    },
  });
  assert.equal(executed, 1);
  assert.equal(requests.length, 4);
  const finishedRequests = operations.filter(
    (record) => record.kind === "request" && record.state === "completed",
  );
  assert.equal(finishedRequests.length, 4, "every actual provider invocation has a settled trace");
  assert.ok(
    finishedRequests.every(
      (record) =>
        record.durationMs !== undefined &&
        record.durationMs >= 0 &&
        record.visit === 2 &&
        record.attempt === 3 &&
        record.sessionId,
    ),
  );
  const usage = await new UsageStore(project).report({ scopeId: accounting.scopeId });
  assert.equal(usage.sessions.length, 1);
  const run = runSchema.parse({
    id: runId,
    createdAt: "now",
    updatedAt: "now",
    mode: "live",
    status: "completed",
    plan: createTemplate("Evidence", "bug", library),
    config: library.config,
    blocks: library.blocks,
    cursor: "$complete",
    visits: { prepare: 2 },
    artifacts: {},
    attempts: [
      {
        nodeId: "prepare",
        visit: 2,
        startedAt: "now",
        finishedAt: "now",
        result: { outcome: "pass", summary: "Done", artifacts: {} },
      },
    ],
  });
  const store = new EvidenceStore(project),
    evidence = await store.readAttempt(run, identity, usage.sessions);
  const session = evidence.sessions[0]!;
  assert.equal(session.sessionId, usage.sessions[0]!.id);
  assert.equal(session.operationId, accounting.operationId);
  assert.equal(session.activityAttempt, 3);
  assert.equal(session.usage?.usage.requests, 4);
  assert.equal(session.context.state, "available");
  if (session.context.state !== "available") throw new Error("Missing session context");
  assert.equal(session.context.value.contextMode, "none");
  assert.equal(session.context.value.settings.model, "vision");
  const system = (
    await store.content(evidence, session.context.value.systemPrompt.id)
  ).data.toString();
  assert.match(system, /Inspect the selected input only/);
  assert.ok(
    JSON.stringify(requests[0]).includes(system.replaceAll("\n", "\\n")),
    "Captured application system prompt must be present in the actual request",
  );
  const tools = JSON.parse(
    (await store.content(evidence, session.context.value.tools.id)).data.toString(),
  );
  assert.deepEqual(
    tools.map((value: { name: string }) => value.name),
    ["inspect"],
  );
  assert.equal(tools[0].parameters.properties.count.type, "number");
  assert.deepEqual(
    session.prompts.map((value) => value.kind),
    ["initial", "continuation"],
  );
  assert.equal(
    await text(store, evidence, session.prompts[0]!.text),
    "Check this image and record the result.",
  );
  assert.equal(await text(store, evidence, session.prompts[1]!.text), "Submit the final result.");
  const storedImage = session.prompts[0]!.images[0]!;
  assert.equal(storedImage.state, "captured");
  if (storedImage.state === "captured")
    assert.deepEqual((await store.content(evidence, storedImage.ref.id)).data, image);
  const rejected = session.tools.find((value) => value.callId === "call_1|fc_1")!,
    completed = session.tools.find((value) => value.callId === "call_2|fc_2")!;
  assert.ok(rejected && completed, JSON.stringify(session.tools));
  assert.equal(rejected.state, "failed");
  assert.deepEqual(JSON.parse(await text(store, evidence, rejected.input!)), {
    count: "invalid",
    label: "2",
  });
  assert.equal(completed.name, "inspect");
  assert.deepEqual(
    JSON.parse(await text(store, evidence, completed.input!)),
    { count: 2, label: "2" },
    "Capture the requested arguments before a tool mutates its working copy",
  );
  assert.deepEqual(JSON.parse(await text(store, evidence, completed.output!)), [
    { type: "text", text: fullText },
  ]);
  assert.deepEqual(JSON.parse(await text(store, evidence, completed.details!)), {
    count: 2,
    label: "2",
  });
  assert.ok(!JSON.stringify(evidence).includes("private-test-credential"));
  await assert.rejects(stat(path.join(workspace, ".workflow/runs")), /ENOENT/);
});

async function text(store: EvidenceStore, evidence: AttemptEvidence, value: StoredEvidenceValue) {
  if (value.state !== "captured") throw new Error(`Expected captured value, got ${value.state}`);
  return (await store.content(evidence, value.ref.id)).data.toString("utf8");
}
