import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.js";
import { Attachments } from "../src/attachments.js";
import { loadOrchestration, saveOrchestration } from "../src/orchestration-settings.js";
import { orchestrationSchema } from "../src/orchestration-schema.js";
import { planTask, type TaskPlannerOptions } from "../src/task-planner.js";
import { taskSchema } from "../src/task-schema.js";
import { createTemplate } from "../src/templates.js";
import type { AvailableModel } from "../src/library-editor-schema.js";
import type { runAgentSession } from "../src/agent-session.js";
import { mcpServerSchema } from "../src/capability-schema.js";
import { inspectMcp, mcpTools } from "../src/mcp-tools.js";

export const models: AvailableModel[] = [
  { provider: "test", id: "careful", name: "Careful", reasoning: true, thinkingLevels: ["off", "high"], imageInput: true, contextWindow: 100000, maxTokens: 8000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
  { provider: "test", id: "quick", name: "Quick", reasoning: false, thinkingLevels: ["off"], contextWindow: 32000, maxTokens: 4000, cost: null },
];
const newRequest = (prompt: string) => taskSchema.parse({ id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0, status: "planning", prompt, attachments: [], answers: [], approval: "review" });
async function call(options: Parameters<typeof runAgentSession>[0], name: string, args: Record<string, unknown>) {
  const tool = options.tools.find((item) => item.name === name);
  assert.ok(tool, `Missing tool ${name}`);
  return await tool.execute("test-call", args, options.signal, undefined, {} as never);
}

test("cases and described model profiles save with revision checks and explicit capability selection", async (t) => {
  const { project } = await fixture(t);
  const original = await loadOrchestration(project);
  assert.equal(original.settings.cases[0]!.id, "bug");
  assert.ok(!("nodes" in original.settings.cases[0]!));
  const settings = structuredClone(original.settings);
  settings.profiles = [{ id: "reviewer", name: "Careful reviewer", description: "Use for difficult reviews", agent: { provider: "test", model: "careful", thinking: "high" }, enabled: true }];
  settings.coordinatorProfile = "reviewer";
  settings.cases = [{ id: "audit", name: "Audit", description: "Investigate an issue", instructions: "Inspect evidence without editing files.", enabled: true }];
  const saved = await saveOrchestration(project, { ...original, settings }, models);
  assert.equal(saved.settings.cases.length, 1);
  assert.notEqual(saved.revision, original.revision);
  await assert.rejects(saveOrchestration(project, { ...original, settings }, models), /changed/);
  // Temporarily disconnected profiles must not prevent editing descriptions.
  saved.settings.profiles[0]!.description = "Read-only review and debugging";
  const edited = await saveOrchestration(project, saved, []);
  edited.settings.profiles[0]!.agent.model = "unavailable";
  await assert.rejects(saveOrchestration(project, edited, models), /unavailable/);
  assert.equal(mcpServerSchema.safeParse({ id: "tools", name: "Tools", url: "https://example.com/mcp?key=secret" }).success, false);
  assert.equal(mcpServerSchema.safeParse({ id: "tools", name: "Tools", url: "http://localhost:3000/mcp", tools: [], planningTools: ["write"] }).success, true);
});

test("attachments validate content, preserve identities and reject tampering or linked data", async (t) => {
  const { project } = await fixture(t);
  const store = new Attachments(project);
  const attachment = await store.add({ name: "../../bug.ts", mimeType: "", data: Buffer.from("export const bug = true;\n").toString("base64") });
  assert.equal(attachment.name, "bug.ts");
  assert.deepEqual(await store.get(attachment.id), attachment);
  assert.equal((await store.context([attachment])).texts[0]!.text, "export const bug = true;\n");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
  const image = await store.add({ name: "screenshot.png", mimeType: "image/png", data: png.toString("base64") });
  assert.equal((await store.context([image])).images[0]!.data, png.toString("base64"));
  await assert.rejects(store.add({ name: "fake.png", mimeType: "image/png", data: "dGV4dA==" }), /does not match/);
  await assert.rejects(store.add({ name: "large.txt", mimeType: "text/plain", data: Buffer.alloc(256001, 65).toString("base64") }), /256 KB/);
  await assert.rejects(store.add({ name: "bad.txt", mimeType: "text/plain", data: "!!!!" }), /encoding/);
  await assert.rejects(store.get("../../config"));
  const file = path.join(project, ".workflow", "attachments", `${attachment.id}.data`);
  await writeFile(file, "changed");
  await assert.rejects(store.read(attachment), /changed/);
  await unlink(file);
  await symlink(path.join(project, ".workflow", "config.json"), file);
  await assert.rejects(store.read(attachment));
  const metadata = path.join(project, ".workflow", "attachments", `${attachment.id}.json`);
  await writeFile(metadata, JSON.stringify({ ...attachment, id: randomUUID() }));
  await assert.rejects(store.get(attachment.id), /identity/);
});

test("the coordinator classifies dynamically, reads case instructions, selects profiles and proposes task-local command blocks", async (t) => {
  const { project, library } = await fixture(t);
  library.config.agent = { ...library.config.agent, provider: "test", model: "careful", thinking: "off" };
  library.config.commands.verify = { argv: [process.execPath, "--version"], timeoutMs: 1000 };
  const settings = orchestrationSchema.parse({ profiles: [{ id: "reviewer", name: "Reviewer", description: "Careful independent review", agent: { provider: "test", model: "careful", thinking: "high" } }], coordinatorProfile: "reviewer", capabilities: { skills: [{ id: "evidence", name: "Evidence", description: "Require evidence", content: "Cite a file for every finding." }] } });
  const task = newRequest("Investigate the failure with a screenshot");
  const store = new Attachments(project);
  task.attachments.push(await store.add({ name: "screen.png", mimeType: "image/png", data: "iVBORw0KGgo=" }));
  const events: string[] = [];
  const options: TaskPlannerOptions = { project, library, task, settings, models, signal: new AbortController().signal, emit: (kind) => events.push(kind) };
  const result = await planTask(options, async (session) => {
    assert.equal(session.settings.thinking, "high");
    assert.match(session.systemPrompt, /Careful independent review/);
    assert.match(session.systemPrompt, /Cite a file/);
    assert.equal(session.images?.length, 1);
    assert.ok((session.tools.find(tool => tool.name === "submit_plan")!.parameters as { required?: string[] }).required?.includes("attachmentSummary"));
    assert.deepEqual(session.tools.map(tool => tool.name).sort(), ["ask_user", "choose_task_case", "submit_plan", "suggest_block"]);
    const plan = createTemplate(task.prompt, "bug", library);
    plan.nodes.forEach((node) => { node.agent = { provider: "test", model: "careful", thinking: "off" }; });
    await assert.rejects(call(session, "submit_plan", { json: JSON.stringify(plan), rationale: "Plan" }), /case/);
    const instructions = await call(session, "choose_task_case", { id: "investigation", reason: "The user asks for diagnosis" });
    assert.match(JSON.stringify(instructions), /read-only/);
    plan.nodes[0]!.agent!.model = "quick";
    await assert.rejects(call(session, "submit_plan", { json: JSON.stringify(plan), rationale: "Plan", attachmentSummary: "Error dialog" }), /not available/);
    plan.nodes[0]!.agent!.model = "careful";
    await assert.rejects(call(session, "submit_plan", { json: JSON.stringify(plan), rationale: "Plan" }), /visual observations/);
    const bundle = structuredClone(library.blocks.review!);
    bundle.definition.id = "verify-command"; bundle.definition.name = "Verify without edits";
    bundle.definition.executor = { kind: "command", command: "verify", expect: "success" };
    await call(session, "suggest_block", { json: JSON.stringify(bundle), rationale: "A command can verify without an AI call" });
    await call(session, "submit_plan", { json: JSON.stringify(plan), rationale: "Independent investigation then verification", attachmentSummary: "The screenshot shows an empty error dialog." });
    await assert.rejects(call(session, "choose_task_case", { id: "bug", reason: "Late" }), /already finished/);
  });
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") { return; }
  assert.equal(result.caseId, "investigation");
  assert.match(result.library.config.instructions, /empty error dialog/);
  assert.equal(result.suggestedBlocks[0]?.id, "verify-command");
  assert.equal(library.blocks["verify-command"], undefined);
  assert.ok(events.includes("classification") && events.includes("plan_ready"));
});

test("essential questions stop planning; disabled block suggestions are not exposed", async (t) => {
  const { project, library } = await fixture(t);
  library.config.agent = { ...library.config.agent, provider: "test", model: "careful", thinking: "off" };
  const options = { project, library, task: newRequest("Implement the required integration"), settings: orchestrationSchema.parse({ suggestBlocks: false }), models, signal: new AbortController().signal, emit: () => {} };
  const result = await planTask(options, async (session) => {
    assert.ok(!session.tools.some((tool) => tool.name === "suggest_block"));
    await call(session, "ask_user", { question: "Which service should be integrated?", options: ["Internal service", "Public service"] });
  });
  assert.equal(result.kind, "question");
  options.task.answers = Array.from({ length: 3 }, () => ({ question: "Asked", answer: "Answered" }));
  await assert.rejects(planTask(options, async (session) => { await call(session, "ask_user", { question: "Again?" }); }), /answers already provided/);
});

test("adapted review scope preserves the host request and rejected graphs expose actionable repair context", async (t) => {
  const { project, library } = await fixture(t);
  library.config.agent = { ...library.config.agent, provider: "test", model: "careful", thinking: "off" };
  const task = newRequest("Review changes");
  const events: { kind: string; message: string }[] = [];
  const options = { project, library, task, settings: orchestrationSchema.parse({}), models, signal: new AbortController().signal, emit: (kind: string, message: string) => { events.push({ kind, message }); } };
  const result = await planTask(options, async session => {
    await call(session, "choose_task_case", { id: "investigation", reason: "Read-only review" });
    const plan = {
      title: "Review working files", task: "Review working files because main has no commits", entry: "review",
      nodes: [{ id: "review", block: "review", label: "Review files", goal: "Review accessible working files. No commit baseline exists; do not attribute defects to branch changes.", inputs: [], maxVisits: 1, on: { pass: "$complete", retry: "$failed", fail: "$failed" } }],
    };
    await assert.rejects(call(session, "submit_plan", { json: JSON.stringify({ ...plan, entry: "missing" }), rationale: "Adapt scope" }), /entry must exist/);
    assert.equal(session.completion?.isComplete(), false);
    assert.match(session.completion!.prompt(), /entry must exist/);
    await call(session, "submit_plan", { json: JSON.stringify(plan), rationale: "Use the working-files scope; no baseline exists." });
    assert.equal(session.completion?.isComplete(), true);
  });
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") { return; }
  assert.equal(result.plan.task, task.prompt);
  assert.match(result.plan.nodes[0]!.goal, /No commit baseline/);
  assert.equal(result.library.blocks.review!.definition.permissions, undefined);
  assert.ok(events.some(event => event.kind === "plan_validation" && /entry must exist/.test(event.message)));
  await assert.rejects(planTask(options, async session => {
    await call(session, "choose_task_case", { id: "investigation", reason: "Review" });
    await assert.rejects(call(session, "submit_plan", { json: "{}", rationale: "Invalid" }));
  }), /Last submission error:/);
});

test("graph composition uses only supplied context and never connects enabled MCP servers", async t => {
  const { project, library } = await fixture(t);
  library.config.agent = { ...library.config.agent, provider: "test", model: "careful", thinking: "off" };
  const task = newRequest("Review changes. Discover the comparison base during execution.");
  const settings = orchestrationSchema.parse({capabilities:{mcpServers:[{
    id:"offline",name:"Must not connect during planning",url:"http://127.0.0.1:1/mcp",enabled:true,
  }]}});
  const result = await planTask({ project, library, task, settings, models,
    signal: new AbortController().signal, emit: () => {} }, async session => {
    assert.deepEqual(session.tools.map(tool=>tool.name).sort(),["ask_user","choose_task_case","submit_plan","suggest_block"]);
    assert.match(session.systemPrompt,/Put all investigation and configuration checks into execution blocks/);
    assert.match(session.systemPrompt,/ctx.ai/);
    assert.ok(!(session.tools.find(tool => tool.name === "submit_plan")!.parameters as { required?: string[] }).required?.includes("attachmentSummary"));
    assert.ok(session.systemPrompt.includes(JSON.stringify(library.blocks.review!.prompt)));
    await call(session,"choose_task_case",{id:"investigation",reason:"Review"});
    await call(session,"submit_plan",{json:JSON.stringify({title:"Review changes",entry:"review",nodes:[{
      id:"review",block:"review",label:"Review",goal:"Inspect the baseline, adapt to working files if absent, and review.",inputs:[],maxVisits:1,on:{pass:"$complete",retry:"$failed",fail:"$failed"},
    }]}),rationale:"Inspection happens in the review block"});
  });
  assert.equal(result.kind,"plan");
  if(result.kind!=="plan")return;
  assert.equal(result.plan.nodes.length,1);
  assert.equal(result.plan.task,task.prompt);
});

test("enabled MCP servers expose every discovered tool, regardless of legacy selections", async (t) => {
  const { project } = await fixture(t);
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") { return new Response(null, { status: 405 }); }
    const input = await request.json() as { id?: number; method: string; params?: { name: string } };
    if (input.id === undefined) { return new Response(null, { status: 202 }); }
    const result = input.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "local-fixture", version: "1" } }
      : input.method === "tools/list" ? { tools: ["read", "write"].map((name) => ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } })) }
      : { content: [{ type: "text", text: `Called ${input.params?.name}` }] };
    if (input.method === "tools/call") { calls.push(input.params!.name); }
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  } });
  t.after(() => server.stop(true));
  const config = mcpServerSchema.parse({ id: "fixture", name: "Fixture", url: `http://127.0.0.1:${server.port}/mcp`, enabled: true, tools: ["read"], planningTools: ["read"] });
  const signal = AbortSignal.timeout(10000);
  assert.equal((await inspectMcp(config, project, signal)).length, 2);
  const planner = await mcpTools({ skills: [], mcpServers: [config] }, project, signal);
  try {
    assert.equal(planner.tools.length, 2);
    assert.match(planner.tools[0]!.name, /read/);
    const result = await planner.tools[0]!.execute("call", {}, signal, undefined, {} as never);
    assert.match(JSON.stringify(result), /Called read/);
  } finally { await planner.close(); }
  const execution = await mcpTools({ skills: [], mcpServers: [config] }, project, signal);
  try { assert.equal(execution.tools.length, 2); } finally { await execution.close(); }
  const disabled = await mcpTools({ skills: [], mcpServers: [{ ...config, enabled: false }] }, project, signal);
  assert.equal(disabled.tools.length, 0);
  assert.deepEqual(calls, ["read"]);
  // Tokens are environment references, never serialized credential values.
  assert.ok(!(await readFile(path.join(project, ".workflow", "config.json"), "utf8")).includes("Authorization"));
});

test("MCP stdio starts in the project and inherits the application environment", async (t) => {
  const { project } = await fixture(t);
  const filename = path.join(project, "mcp-fixture.mjs");
  await writeFile(filename, `
import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (input.id === undefined) continue;
  const result = input.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : input.method === "tools/list" ? { tools: [{ name: "inspect_env", inputSchema: { type: "object", properties: {} } }] }
    : { content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), selected: !!process.env.WORKFLOW_TEST_MCP_TOKEN, unrelated: !!process.env.WORKFLOW_TEST_PRIVATE }) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }) + "\\n");
}
`);
  const originalToken = process.env.WORKFLOW_TEST_MCP_TOKEN;
  const originalPrivate = process.env.WORKFLOW_TEST_PRIVATE;
  process.env.WORKFLOW_TEST_MCP_TOKEN = "fixture-token"; process.env.WORKFLOW_TEST_PRIVATE = "inherited-fixture-value";
  t.after(() => {
    if (originalToken === undefined) { delete process.env.WORKFLOW_TEST_MCP_TOKEN; } else { process.env.WORKFLOW_TEST_MCP_TOKEN = originalToken; }
    if (originalPrivate === undefined) { delete process.env.WORKFLOW_TEST_PRIVATE; } else { process.env.WORKFLOW_TEST_PRIVATE = originalPrivate; }
  });
  const server = mcpServerSchema.parse({ id: "local", name: "Local fixture", transport: "stdio", command: process.execPath, args: [filename], tokenEnv: "WORKFLOW_TEST_MCP_TOKEN", enabled: true, tools: ["inspect_env"] });
  const signal = AbortSignal.timeout(10000);
  const connection = await mcpTools({ skills: [], mcpServers: [server] }, project, signal);
  try {
    const result = await connection.tools[0]!.execute("call", {}, signal, undefined, {} as never);
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text?.type === "text");
    assert.deepEqual(JSON.parse(text.text), { cwd: project, selected: true, unrelated: true });
  } finally { await connection.close(); }
});
