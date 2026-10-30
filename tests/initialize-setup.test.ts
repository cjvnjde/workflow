import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeSetup } from "../src/initialize-setup.js";
import { initializeProject, loadLibrary } from "../src/library.js";
import { loadOrchestration, saveOrchestration } from "../src/orchestration-settings.js";
import { designAgent, type designSettings } from "../src/settings-designer.js";
import { bundleSchema } from "../src/domain.js";
import type { AvailableModel } from "../src/library-editor-schema.js";
import { fixture } from "./helpers.js";
import { UsageStore } from "../src/usage-store.js";
import { emptyUsage } from "../src/budget.js";

const models: AvailableModel[] = ["small", "careful"].map(id => ({
  provider: "test", id, name: id, reasoning: true, imageInput: false,
  thinkingLevels: ["low", "high"], contextWindow: 32000, maxTokens: 4000, cost: null,
}));
const catalog = async () => ({ models, warnings: [] });
const small = { provider: "test", model: "small", thinking: "low" as const };

async function setDefault(project: string) {
  const filename = path.join(project, ".workflow/config.json");
  const raw = JSON.parse(await readFile(filename, "utf8"));
  await writeFile(filename, JSON.stringify({ ...raw, agent: small, coordinator: { provider: "test", model: "careful", thinking: "high" } }));
}

const design: typeof designSettings = async options => {
  assert.equal(designAgent(options.library, options.settings, models).model, "small", "Every bootstrap stage uses the saved default even with an older coordinator");
  if (options.scope === "profiles") return { message: "Profiles", proposal: {
    scope: "profiles", summary: "Route careful reviews independently", coordinatorProfile: "reviewer",
    profiles: [{ id: "reviewer", name: "Reviewer", description: "Independent review", enabled: true, agent: { provider: "test", model: "careful", thinking: "high" } }],
  } };
  if (options.scope === "cases") return { message: "Cases", proposal: {
    scope: "cases", summary: "Project task instructions", instructions: "Prefer focused typed handoffs", suggestBlocks: true,
    cases: options.settings.cases,
  } };
  const request = options.messages[0]!.content;
  assert.match(request, /small, focused patch/);
  assert.match(request, /unmentioned blocks remain available unchanged/i);
  assert.match(request, /Preserve already suitable deterministic checks and publication blocks unchanged/);
  assert.match(request, /return OutputSchema\.parse/);
  return { message: "Blocks", proposal: { scope: "blocks", summary: "Small deterministic block", changes: {
    summary: "Add a formatter with no model call", blocks: [{ rationale: "Ordinary TypeScript needs no AI", bundle: bundleSchema.parse({
      definition: { id: "format-note", name: "Format a note", description: "Deterministic text normalization", executor: {
        kind: "code", source: 'import {block,z} from "workflow";export default block({input:z.object({text:z.string()}),run(ctx){return ctx.input.text.trim();}});',
      } }, skills: [],
    }) }],
  } } };
};

test("explicit setup refreshes models, uses the chosen default and saves reusable profiles, cases and code", async t => {
  const { project } = await fixture(t);
  await setDefault(project);
  let calls = 0;
  const services = {
    catalog: async (_signal: AbortSignal, refresh?: boolean) => { assert.equal(refresh, true); return catalog(); },
    design: (async options => { calls++; return design(options); }) as typeof designSettings,
  };
  const result = await initializeSetup(project, {}, services);
  assert.equal(result.status, "generated");
  assert.equal(result.profiles, 1); assert.equal(result.blocks, 9); assert.equal(calls, 3);
  const state = await loadOrchestration(project);
  assert.equal(state.settings.coordinatorProfile, "");
  assert.equal(state.settings.instructions, "Prefer focused typed handoffs");
  assert.ok(state.settings.cases.some(item => item.id === "review"));
  assert.ok(state.settings.cases.some(item => item.id === "docs"));
  assert.equal(state.settings.approval, "review");
  assert.equal((await loadLibrary(project)).blocks["format-note"]?.definition.executor?.kind, "code");
  const sourceFile = path.join(project, ".workflow/blocks/format-note/block.ts");
  const generatedSource = await readFile(sourceFile, "utf8");
  assert.match(generatedSource, /\.trim\(\)/);
  const editedSource = generatedSource.replace("ctx.input.text.trim()", "ctx.input.text.trim().toUpperCase()");
  await writeFile(sourceFile, editedSource);
  const edited = (await loadLibrary(project)).blocks["format-note"]!.definition.executor;
  assert.equal(edited?.kind === "code" ? edited.source : "", editedSource, "The ordinary generated TypeScript file is authoritative");
  const config = JSON.parse(await readFile(path.join(project, ".workflow/config.json"), "utf8"));
  assert.deepEqual(config.agent, small, "Bootstrap does not replace the default");
  assert.equal(config.coordinator, undefined, "A legacy coordinator cannot override the selected default after setup");
  assert.equal(designAgent(await loadLibrary(project), state.settings, models).model, "small");
  const existing = await initializeSetup(project, {}, { catalog: async () => { throw new Error("Must not contact provider"); }, design });
  assert.equal(existing.status, "existing"); assert.equal(calls, 3);
  assert.equal((await initializeSetup(project, { regenerate: true }, services)).status, "generated");
  assert.equal(calls, 6);
});

test("failed or concurrently edited setup does not publish partially generated settings", async t => {
  const { project } = await fixture(t);
  await setDefault(project);
  const initial = await loadOrchestration(project);
  await assert.rejects(initializeSetup(project, {}, { catalog, design: async options => {
    if (options.scope === "blocks") throw new Error("Model failed");
    return design(options);
  } }), /Model failed/);
  assert.equal((await loadOrchestration(project)).revision, initial.revision);
  await assert.rejects(readFile(path.join(project, ".workflow/library.json")), /ENOENT/);
  await assert.rejects(initializeSetup(project, {}, { catalog, design: async options => {
    if (options.scope === "blocks") {
      const current = await loadOrchestration(project);
      current.settings.instructions = "User's concurrent edit";
      await saveOrchestration(project, current, models);
    }
    return design(options);
  } }), /settings changed during setup/);
  assert.equal((await loadOrchestration(project)).settings.instructions, "User's concurrent edit");
  await assert.rejects(readFile(path.join(project, ".workflow/library.json")), /ENOENT/);
});

test("disconnected setup never requests generation or changes project settings", async t => {
  const { project } = await fixture(t);
  const result = await initializeSetup(project, {}, { catalog: async () => ({ models: [], warnings: [] }), design: async () => { throw new Error("Must not call AI"); } });
  assert.equal(result.status, "unconnected");
  await assert.rejects(readFile(path.join(project, ".workflow/setup.json")), /ENOENT/);
});

test("setup stages share one cap and retain failed generation spending without publishing", async t => {
  const { project } = await fixture(t);
  await setDefault(project);
  const contexts: NonNullable<Parameters<typeof designSettings>[0]["accounting"]>[] = [];
  await assert.rejects(initializeSetup(project, { maxSetupCostUsd: 0.1 }, { catalog, design: async options => {
    const context = options.accounting!;
    contexts.push(context);
    const session = await new UsageStore(project).beginSession(context, {
      provider: "test", model: "small", thinking: "low", pricing: { source: "override", rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    }, options.signal);
    await session.update({ ...emptyUsage(), requests: 1, inputTokens: 100, costUsd: 0.06 });
    await session.finish("completed"); session.release();
    return design(options);
  } }), /Total spending limit reached/);
  assert.equal(contexts.length, 3);
  assert.equal(new Set(contexts.map(context => context.scopeId)).size, 1);
  assert.deepEqual(contexts.map(context => context.setupStage), ["profiles", "cases", "blocks"]);
  const report = await new UsageStore(project).report({ scopeId: contexts[0]!.scopeId });
  assert.equal(report.scope.kind, "setup");
  assert.equal(report.total.costUsd, 0.12);
  assert.equal(report.sessionCount, 2);
  assert.equal(report.phases[0]?.phase, "setup");
  await assert.rejects(readFile(path.join(project, ".workflow/setup.json")), /ENOENT/);
  await assert.rejects(readFile(path.join(project, ".workflow/library.json")), /ENOENT/);
});

test("new projects run detected checks with code and honor their declared package manager", async t => {
  const project = await mkdtemp(path.join(os.tmpdir(), "workflow-setup-init-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(path.join(project, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "vitest run" } }));
  const library = await initializeProject(project);
  assert.deepEqual(library.config.commands.test?.argv, ["pnpm", "run", "test"]);
  const check = library.blocks.checks?.definition.executor;
  assert.equal(check?.kind, "code");
  if (check?.kind === "code") {
    assert.match(check.source, /ctx\.exec/);
    assert.doesNotMatch(check.source, /ctx\.ai/);
    assert.match(check.source, /pnpm/);
  }
});
