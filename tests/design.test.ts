import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fixture, passingRunner } from "./helpers.js";
import { loadLibrary } from "../src/library.js";
import { loadOrchestration, saveOrchestration } from "../src/orchestration-settings.js";
import { orchestrationSchema } from "../src/orchestration-schema.js";
import { executionSettings } from "../src/project-model.js";
import { designAgent, designSettings, validateDesign, type DesignOptions } from "../src/settings-designer.js";
import { DesignChats } from "../src/design-chats.js";
import { initializeProfiles } from "../src/initialize-profiles.js";
import { validateLibraryChanges } from "../src/library-proposals.js";
import { WorkflowEngine } from "../src/engine.js";
import { createServer } from "../src/server.js";
import type { DesignProposal } from "../src/design-schema.js";
import type { AvailableModel } from "../src/library-editor-schema.js";
import { bundleSchema } from "../src/domain.js";

const models: AvailableModel[] = [{ provider: "test", id: "careful", name: "Careful model", reasoning: true, imageInput: true, thinkingLevels: ["off", "medium", "high"], contextWindow: 128000, maxTokens: 8000, cost: null }];
const catalog = async () => ({ models, warnings: [] });
const profileProposal = (description = "Use for careful diagnosis and independent review."): Extract<DesignProposal, { scope: "profiles" }> => ({ scope: "profiles", summary: "Choose a planning and review model", coordinatorProfile: "reviewer", profiles: [{ id: "reviewer", name: "Careful reviewer", description, enabled: true, agent: { provider: "test", model: "careful", thinking: "high" } }] });
const profileDesigner: typeof designSettings = async () => ({ message: "Here is a proposed model lineup.", proposal: profileProposal() });
const toolContext = {} as Parameters<ToolDefinition["execute"]>[4];

test("AI code proposals resolve unchanged blocks from the complete library snapshot", async t => {
  const { project, library } = await fixture(t);
  library.config.agent = { thinking: "off", timeoutMs: 30000, maxToolCalls: 20 };
  library.config.coordinator = {};
  library.blocks.base = bundleSchema.parse({ definition: { id: "base", name: "Shared", description: "Shared code", executor: {
    kind: "code", source: 'import {block} from "workflow"; export default block({name:"Shared",async run(){return "existing";}});',
  } }, skills: [] });
  const proposal = { scope: "blocks", summary: "Reuse the existing module", changes: { summary: "Add composition", blocks: [{
    bundle: { definition: { id: "composed", name: "Composition", description: "Uses the saved shared module", executor: {
      kind: "code", source: 'import {block} from "workflow";import base from "../base/block.ts";export default block({async run(ctx){return base.options.run(ctx);}});',
    } }, skills: [] }, rationale: "Compose saved code",
  }] } };
  const signal = AbortSignal.timeout(30000);
  const result = await designSettings({ project, library, settings: orchestrationSchema.parse({}), models,
    scope: "blocks", messages: [], signal, emit: () => {},
  }, async session => {
    await session.tools.find(tool => tool.name === "propose_settings")!.execute("proposal", {json:JSON.stringify(proposal),message:"Shared code reused."}, signal, undefined, toolContext);
  });
  assert.equal(result.proposal?.scope, "blocks");
  assert.equal(library.blocks.composed, undefined, "Submitting does not change settings");
});
async function settled(chats: DesignChats, id: string) {
  for (let count = 0; count < 300; count++) {
    const session = chats.get(id);
    if (session.status !== "working") { return session; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Design did not settle");
}
async function turn(chats: DesignChats, id: string, message: string) {
  await chats.send(id, { message, revision: chats.get(id).revision });
  return await settled(chats, id);
}

test("discarding a design proposal persists without changing settings and fences stale apply requests", async (t) => {
  const { project, cleanup } = await fixture(t);
  const chats = new DesignChats(project, catalog, profileDesigner);
  await chats.initialize();
  cleanup(() => chats.close());
  const settings = await loadOrchestration(project);
  const created = await chats.create({ scope: "profiles" });
  const ready = await turn(chats, created.id, "Design profiles");
  await assert.rejects(chats.discard(created.id, { revision: ready.revision - 1 }), /changed/);
  const discarded = await chats.discard(created.id, { revision: ready.revision });
  assert.equal(discarded.status, "idle");
  assert.equal(discarded.proposal, undefined);
  assert.deepEqual(discarded.messages, ready.messages);
  await assert.rejects(chats.apply(created.id, { revision: ready.revision }), /changed/);
  assert.deepEqual(await loadOrchestration(project), settings);
  const restored = new DesignChats(project, catalog, profileDesigner);
  await restored.initialize(); cleanup(() => restored.close());
  assert.equal(restored.get(created.id).proposal, undefined);
  assert.equal((await turn(restored, created.id, "Try a different lineup")).status, "ready");
});

test("settings designer supports cross-section proposals, validates catalog choices, and bootstraps a supported planning model", async (t) => {
  const { library } = await fixture(t);
  const settings = orchestrationSchema.parse({});
  const context = { scope: "profiles" as const, library, settings, models };
  assert.equal(validateDesign(profileProposal(), context).scope, "profiles");
  assert.equal(validateDesign(profileProposal(), { ...context, scope: "cases" }).scope, "profiles");
  const invalid = profileProposal(); invalid.profiles[0]!.agent.model = "invented";
  assert.throws(() => validateDesign(invalid, context), /not available/);
  invalid.profiles[0]!.agent.model = "careful"; invalid.profiles[0]!.agent.thinking = "max";
  assert.throws(() => validateDesign(invalid, context), /not supported/);
  assert.throws(() => validateDesign({ ...profileProposal(), coordinatorProfile: "missing" }, context), /enabled coordinator/);
  library.config.agent = { thinking: "off", timeoutMs: 30000, maxToolCalls: 20 }; library.config.coordinator = {};
  const agent = designAgent(library, settings, [{ ...models[0]!, thinkingLevels: ["medium"] }]);
  assert.equal(agent.thinking, "medium");
  assert.equal(agent.model, "careful");
  library.config.agent = { ...library.config.agent, provider: "test", model: "unavailable" };
  assert.throws(() => designAgent(library, settings, models), /not available/);
  assert.throws(() => designAgent(library, settings, []), /Connect ChatGPT/);
});

test("design sessions receive the conversation and draft, have read-only inspection tools, and stop after submitting", async (t) => {
  const { project, library } = await fixture(t);
  library.config.agent = { thinking: "off", timeoutMs: 30000, maxToolCalls: 20 }; library.config.coordinator = {};
  const proposal = profileProposal();
  const options: DesignOptions = { project, library, settings: orchestrationSchema.parse({}), models, scope: "profiles", previous: proposal, messages: [{ role: "user", content: "Use careful review", time: new Date().toISOString() }], signal: new AbortController().signal, emit: () => {} };
  const result = await designSettings(options, async (session) => {
    assert.match(session.systemPrompt, /Available models/);
    assert.deepEqual(JSON.parse(session.prompt).previousDraft, proposal);
    assert.equal(JSON.parse(session.prompt).conversation[0].content, "Use careful review");
    assert.deepEqual(session.tools.map((tool) => tool.name), ["git_changes", "list_files", "read_file", "workflow_inspect", "reply_to_user", "propose_settings"]);
    assert.equal(session.completion?.isComplete(), false);
    assert.match(session.completion!.prompt(), /prose does not create/);
    const submit = session.tools.find((tool) => tool.name === "propose_settings")!;
    await assert.rejects(submit.execute("invalid", { json: JSON.stringify({ ...proposal, scope: "cases" }), message: "Wrong scope" }, options.signal, undefined, toolContext));
    assert.match(session.completion!.prompt(), /Correct the rejected submission/);
    await submit.execute("valid", { json: JSON.stringify(proposal), message: "Careful review is covered." }, options.signal, undefined, toolContext);
    assert.equal(session.completion?.isComplete(), true);
    await assert.rejects(session.tools[0]!.execute("late", {}, options.signal, undefined, toolContext), /already finished/);
  });
  assert.deepEqual(result.proposal, proposal);
  assert.equal((await loadOrchestration(project)).settings.profiles.length, 0);
  const reply = await designSettings(options, async (session) => {
    await session.tools.find((tool) => tool.name === "reply_to_user")!.execute("reply", { message: "A profile describes when to choose a model." }, options.signal, undefined, toolContext);
  });
  assert.equal(reply.proposal, undefined);
  await assert.rejects(designSettings(options, async () => {}), /after automatic correction/);
});

test("design chat refines a reviewed draft, preserves unrelated settings, persists, and starts fresh after apply", async (t) => {
  const { project, cleanup } = await fixture(t);
  const initial = await loadOrchestration(project);
  initial.settings.instructions = "Preserve public APIs.";
  await saveOrchestration(project, initial, models);
  const seen: DesignOptions[] = [];
  const chats = new DesignChats(project, catalog, async (options) => {
    seen.push(options);
    if (options.messages.at(-1)!.content === "Explain the choice") { return { message: "This model supports deliberate review." }; }
    return { message: "Updated the lineup.", proposal: profileProposal(options.messages.at(-1)!.content) };
  });
  await chats.initialize(); cleanup(() => chats.close());
  const created = await chats.create({ scope: "profiles" });
  let draft = await turn(chats, created.id, "Use careful review");
  assert.equal(draft.status, "ready");
  assert.equal((await loadOrchestration(project)).settings.profiles.length, 0);
  draft = await turn(chats, created.id, "Focus on security review");
  assert.deepEqual(seen[1]!.previous, profileProposal("Use careful review"));
  assert.equal(seen[1]!.messages.length, 3);
  draft = await turn(chats, created.id, "Explain the choice");
  assert.equal(draft.status, "ready");
  assert.deepEqual(draft.proposal, profileProposal("Focus on security review"));
  assert.equal((await chats.apply(draft.id, { revision: draft.revision })).status, "applied");
  const stored = await loadOrchestration(project);
  assert.equal(stored.settings.profiles[0]!.description, "Focus on security review");
  assert.equal(stored.settings.instructions, "Preserve public APIs.");
  assert.deepEqual(stored.settings.cases, initial.settings.cases);
  const restored = new DesignChats(project, catalog, profileDesigner);
  await restored.initialize(); cleanup(() => restored.close());
  assert.deepEqual(restored.latest("profiles"), JSON.parse(JSON.stringify(chats.get(created.id))));
  assert.equal((await stat(path.join(project, ".workflow", "design-chats", `${created.id}.json`))).mode & 0o777, 0o600);
  await turn(chats, created.id, "Use careful implementation too");
  assert.equal(seen.at(-1)!.previous, undefined);
});

test("stale design proposals and stale browser revisions cannot overwrite manual changes", async (t) => {
  const { project, cleanup } = await fixture(t);
  const chats = new DesignChats(project, catalog, profileDesigner);
  await chats.initialize(); cleanup(() => chats.close());
  const created = await chats.create({ scope: "profiles" });
  const draft = await turn(chats, created.id, "Generate profiles");
  await assert.rejects(chats.apply(draft.id, { revision: created.revision }), /changed/);
  const current = await loadOrchestration(project);
  current.settings.instructions = "A newer manual instruction";
  await saveOrchestration(project, current, models);
  await assert.rejects(chats.apply(draft.id, { revision: draft.revision }), /changed since this proposal/);
  assert.equal((await loadOrchestration(project)).settings.instructions, current.settings.instructions);
  assert.equal((await loadOrchestration(project)).settings.profiles.length, 0);
  const refreshed = await turn(chats, draft.id, "Keep the manual instruction and refresh profiles");
  await chats.apply(refreshed.id, { revision: refreshed.revision });
  assert.equal((await loadOrchestration(project)).settings.instructions, current.settings.instructions);
});

test("design cancellation rejects concurrent messages and prevents a late provider result from applying", async (t) => {
  const { project, cleanup } = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const chats = new DesignChats(project, catalog, async () => { entered.resolve(); await release.promise; return { message: "Late reply", proposal: profileProposal() }; });
  await chats.initialize(); cleanup(() => chats.close());
  const created = await chats.create({ scope: "profiles" });
  await chats.send(created.id, { message: "Generate profiles", revision: created.revision });
  await entered.promise;
  await assert.rejects(chats.send(created.id, { message: "Duplicate", revision: chats.get(created.id).revision }), /busy/);
  const cancellation = chats.cancel(created.id);
  release.resolve();
  const cancelled = await cancellation;
  assert.equal(cancelled.status, "failed");
  assert.match(cancelled.error!, /stopped/);
  assert.equal(cancelled.proposal, undefined);
  assert.equal((await loadOrchestration(project)).settings.profiles.length, 0);
});

test("shutdown during initial chat persistence waits for cancellation without starting the model", async (t) => {
  const { project } = await fixture(t);
  let called = false;
  const chats = new DesignChats(project, catalog, async () => { called = true; return await profileDesigner({} as DesignOptions); });
  await chats.initialize();
  const created = await chats.create({ scope: "profiles" });
  const sending = chats.send(created.id, { message: "Generate", revision: created.revision });
  const closing = chats.close();
  await Promise.all([sending, closing]);
  assert.equal(called, false);
  assert.equal(chats.get(created.id).status, "failed");
  const restored = new DesignChats(project, catalog, profileDesigner); await restored.initialize();
  assert.equal(restored.get(created.id).status, "failed"); await restored.close();
  await assert.rejects(chats.send(created.id, { message: "Again", revision: chats.get(created.id).revision }), /shutting down/);
});

test("cancelling while a design reply is being saved cannot publish the new proposal", async (t) => {
  const { project, cleanup } = await fixture(t);
  const chats = new DesignChats(project, catalog, profileDesigner);
  await chats.initialize(); cleanup(() => chats.close());
  const created = await chats.create({ scope: "profiles" });
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = chats["save"].bind(chats);
  chats["save"] = async session => {
    await save(session);
    if (session.status === "ready") { publishing.resolve(); await release.promise; }
  };
  cleanup(async () => { release.resolve(); });
  await chats.send(created.id, { message: "Generate profiles", revision: created.revision });
  await publishing.promise;
  assert.equal(chats.get(created.id).status, "working");
  const cancelling = chats.cancel(created.id);
  release.resolve();
  const cancelled = await cancelling;
  assert.equal(cancelled.status, "failed");
  assert.match(cancelled.error!, /stopped/);
  assert.equal(cancelled.proposal, undefined);
  await assert.rejects(chats.apply(created.id, { revision: cancelled.revision }), /cannot be applied/);
  const restored = new DesignChats(project, catalog, profileDesigner);
  await restored.initialize(); cleanup(() => restored.close());
  assert.equal(restored.get(created.id).status, "failed");
  assert.equal(restored.get(created.id).proposal, undefined);
});

test("interrupted persisted chats recover with their conversation intact", async (t) => {
  const { project, cleanup } = await fixture(t);
  const chats = new DesignChats(project, catalog, profileDesigner); await chats.initialize();
  const created = await chats.create({ scope: "cases" }); await chats.close();
  const filename = path.join(project, ".workflow", "design-chats", `${created.id}.json`);
  await writeFile(filename, JSON.stringify({ ...created, status: "working", messages: [{ role: "user", content: "Add a release case", time: created.createdAt }] }));
  const restored = new DesignChats(project, catalog, profileDesigner); await restored.initialize(); cleanup(() => restored.close());
  const recovered = restored.get(created.id);
  assert.equal(recovered.status, "failed"); assert.match(recovered.error!, /server stopped/);
  assert.equal(recovered.messages[0]!.content, "Add a release case");
  assert.equal(JSON.parse(await readFile(filename, "utf8")).status, "failed");
});

test("AI block removal is reviewed, rejects invalid removals, and saves a recoverable library snapshot", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const change = { summary: "Remove an unused block", blocks: [], remove: ["reproduce"] };
  assert.throws(() => validateLibraryChanges({ ...change, remove: ["missing"] }, library, "regenerate", models), /Unknown block/);
  assert.throws(() => validateLibraryChanges({ ...change, remove: ["reproduce", "reproduce"] }, library, "regenerate", models), /Duplicate/);
  assert.throws(() => validateLibraryChanges({ ...change, remove: Object.keys(library.blocks) }, library, "regenerate", models), /requires 1–50 blocks/);
  assert.throws(() => validateLibraryChanges({ ...change, blocks: [{ bundle: library.blocks.reproduce!, rationale: "Conflicting edit" }] }, library, "regenerate", models), /update and remove/);
  assert.throws(() => validateLibraryChanges(change, library, "models", models), /cannot remove/);
  const chats = new DesignChats(project, catalog, async () => ({ message: "Remove reproduction only.", proposal: { scope: "blocks", summary: change.summary, changes: change } }));
  await chats.initialize(); cleanup(() => chats.close());
  const created = await chats.create({ scope: "blocks" });
  const draft = await turn(chats, created.id, "Remove the reproduction block");
  assert.ok((await loadLibrary(project)).blocks.reproduce);
  const applied = await chats.apply(draft.id, { revision: draft.revision });
  assert.equal((await loadLibrary(project)).blocks.reproduce, undefined);
  assert.equal((await loadLibrary(project)).blocks.review!.prompt, library.blocks.review!.prompt);
  const snapshot = JSON.parse(await readFile(path.join(project, ".workflow", "libraries", `${applied.base!.library}.json`), "utf8"));
  assert.ok(snapshot.blocks.reproduce);
});

test("case, capability and execution proposals apply only their section and preserve command contracts", async (t) => {
  const { project, cleanup } = await fixture(t);
  const chats = new DesignChats(project, catalog, async (options) => {
    if (options.scope === "cases") { return { message: "Added a release case.", proposal: { scope: "cases", summary: "Release checks", instructions: "Keep changes focused", suggestBlocks: false, cases: [...options.settings.cases, { id: "release", name: "Release", description: "Prepare a release", instructions: "Verify changelog and tests", enabled: true }] } }; }
    if (options.scope === "capabilities") { return { message: "Added a review skill.", proposal: { scope: "capabilities", summary: "Evidence-backed review", capabilities: { skills: [{ id: "evidence", name: "Evidence", description: "Support findings", content: "Cite files for findings.", enabled: true }], mcpServers: [] } } }; }
    const { configRevision: _revision, ...settings } = await executionSettings(project);
    return { message: "Adjusted limits.", proposal: { scope: "execution", summary: "Use shorter workflows", settings: { ...settings, maxSteps: 15 } } };
  });
  await chats.initialize(); cleanup(() => chats.close());
  for (const scope of ["cases", "capabilities", "execution"] as const) {
    const created = await chats.create({ scope }); const draft = await turn(chats, created.id, `Configure ${scope}`);
    assert.equal(draft.status, "ready", draft.error); await chats.apply(draft.id, { revision: draft.revision });
  }
  const saved = (await loadOrchestration(project)).settings;
  assert.equal(saved.cases.at(-1)!.id, "release"); assert.equal(saved.capabilities.skills[0]!.id, "evidence");
  assert.equal(saved.instructions, "Keep changes focused"); assert.equal(saved.approval, "review");
  assert.equal((await executionSettings(project)).maxSteps, 15);
  const library = await loadLibrary(project);
  library.blocks.review!.definition.checks = [{ command: "test", expect: "success" }];
  const config = await executionSettings(project); const { configRevision: _revision, ...settings } = config;
  assert.throws(() => validateDesign({ scope: "execution", summary: "Missing test", settings: { ...settings, commands: {} } }, { scope: "execution", library, settings: saved, models }), /undefined command/);
});

test("profile initialization uses project instructions, skips existing profiles, and supports explicit regeneration", async (t) => {
  const { project } = await fixture(t);
  const initial = await loadOrchestration(project); initial.settings.instructions = "Custom task instructions";
  await saveOrchestration(project, initial, models);
  let calls = 0;
  const design: typeof designSettings = async (options) => {
    calls++; assert.match(options.messages[0]!.content, /Prefer deliberate review/);
    assert.equal(options.settings.instructions, initial.settings.instructions);
    return { message: "Generated", proposal: { ...profileProposal(), coordinatorProfile: "" } };
  };
  assert.deepEqual(await initializeProfiles(project, {}, { catalog: async () => ({ models: [], warnings: [] }), design }), { status: "unconnected", count: 0 });
  assert.equal(calls, 0);
  assert.deepEqual(await initializeProfiles(project, { instructions: "Prefer deliberate review" }, { catalog, design }), { status: "generated", count: 1 });
  const saved = await loadOrchestration(project); assert.equal(saved.settings.coordinatorProfile, "");
  assert.equal(saved.settings.instructions, initial.settings.instructions);
  assert.equal((await initializeProfiles(project, {}, { catalog, design })).status, "existing"); assert.equal(calls, 1);
  await initializeProfiles(project, { regenerate: true, instructions: "Prefer deliberate review" }, { catalog, design }); assert.equal(calls, 2);
});

test("aborted initialization and concurrent configuration changes cannot publish generated profiles", async (t) => {
  const { project } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(initializeProfiles(project, { signal: controller.signal }, { catalog, design: async () => { controller.abort(new Error("Cancelled")); return { message: "Late", proposal: profileProposal() }; } }), /Cancelled/);
  assert.equal((await loadOrchestration(project)).settings.profiles.length, 0);
  await assert.rejects(initializeProfiles(project, {}, { catalog, design: async () => {
    const manual = await loadOrchestration(project); manual.settings.instructions = "Concurrent edit"; await saveOrchestration(project, manual, models);
    return { message: "Generated", proposal: profileProposal() };
  } }), /changed/);
  assert.equal((await loadOrchestration(project)).settings.instructions, "Concurrent edit");
  assert.equal((await loadOrchestration(project)).settings.profiles.length, 0);
});

test("design API enforces mutation headers and revision checks with real persisted chat state", async (t) => {
  const { project, cleanup } = await fixture(t);
  const server = await createServer(new WorkflowEngine(project, "live", passingRunner), 4310, { catalog, design: profileDesigner });
  cleanup(() => server.close());
  const headers = { host: "127.0.0.1:4310", "x-workflow-client": "1" };
  assert.equal((await server.inject({ method: "POST", url: "/api/design", headers: { host: headers.host }, payload: { scope: "profiles" } })).statusCode, 403);
  const created = (await server.inject({ method: "POST", url: "/api/design", headers, payload: { scope: "profiles" } })).json();
  const queued = await server.inject({ method: "POST", url: `/api/design/${created.id}/messages`, headers, payload: { message: "Generate profiles", revision: created.revision } });
  assert.equal(queued.statusCode, 202);
  let ready = queued.json();
  for (let count = 0; count < 100 && ready.status === "working"; count++) { await new Promise((resolve) => setTimeout(resolve, 10)); ready = (await server.inject({ method: "GET", url: `/api/design/${created.id}`, headers })).json(); }
  assert.equal(ready.status, "ready", ready.error);
  assert.equal((await server.inject({ method: "POST", url: `/api/design/${created.id}/apply`, headers, payload: { revision: created.revision } })).statusCode, 409);
  const applied = await server.inject({ method: "POST", url: `/api/design/${created.id}/apply`, headers, payload: { revision: ready.revision } });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal((await loadOrchestration(project)).settings.profiles[0]!.id, "reviewer");
  assert.equal((await server.inject({ method: "GET", url: "/api/design/profiles/latest", headers })).json().status, "applied");
});

test("global designer inspects live history and applies another section while retaining per-turn page context", async t => {
  const { project, library, cleanup } = await fixture(t);
  const taskId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  library.config.agent = { thinking: "off", timeoutMs: 30000, maxToolCalls: 20 }; library.config.coordinator = {};
  const calls: unknown[] = [];
  await designSettings({ project, library, settings: orchestrationSchema.parse({}), models, scope: "project", messages: [], signal: AbortSignal.timeout(30000), emit: () => {},
    inspect: async (resource, id) => { calls.push([resource, id]); return { attempts: [{ result: "failed assertion" }] }; },
  }, async session => {
    const inspect = session.tools.find(tool => tool.name === "workflow_inspect")!;
    const inspected = await inspect.execute("read", {resource:"run",id:runId,path:["attempts"],limit:1}, undefined, undefined, toolContext);
    assert.match(JSON.stringify(inspected), /failed assertion/);
    assert.deepEqual(calls, [["run", runId]]);
    await assert.rejects(inspect.execute("invalid", {resource:"run",id:runId,path:["__proto__"]}, undefined, undefined, toolContext), /Unknown field/);
    assert.equal(session.tools.some(tool => ["bash", "write_file", "edit_file"].includes(tool.name)), false);
    await session.tools.find(tool => tool.name === "propose_settings")!.execute("proposal", {json:JSON.stringify(profileProposal()),message:"Use this model profile."}, undefined, undefined, toolContext);
  });
  let context: unknown;
  const chats = new DesignChats(project, catalog, async options => {
    context = options.messages.at(-1)?.context;
    options.emit("tool_start", "workflow_inspect run");
    options.emit("tool_end", "workflow_inspect: finished");
    return { message: "Profile proposal", proposal: profileProposal() };
  });
  await chats.initialize(); cleanup(() => chats.close());
  const created = await chats.create({ scope: "project" });
  await chats.send(created.id, { message:"Improve the reviewer",revision:created.revision,context:{page:"task",taskId,runId} });
  const ready = await settled(chats, created.id);
  assert.deepEqual(context, {page:"task",taskId,runId});
  assert.equal((await loadOrchestration(project)).settings.profiles.length, 0);
  await chats.apply(created.id, {revision:ready.revision});
  assert.equal((await loadOrchestration(project)).settings.coordinatorProfile, "reviewer");
  const restored = new DesignChats(project, catalog, profileDesigner);
  await restored.initialize(); cleanup(() => restored.close());
  assert.deepEqual(restored.get(created.id).messages[0]?.context, context);
  assert.equal(restored.get(created.id).toolActivity.length, 2);
});
