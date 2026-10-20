import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.js";
import { loadLibrary } from "../src/library.js";
import { LibraryProposals, validateLibraryChanges, validatePlanModels } from "../src/library-proposals.js";
import { generateLibraryChanges } from "../src/library-generator.js";
import { createTemplate } from "../src/templates.js";
import { createAiPlan } from "../src/planner.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AvailableModel } from "../src/library-editor-schema.js";

const toolContext = {} as Parameters<ToolDefinition["execute"]>[4];

const testModels: AvailableModel[] = [
  { provider: "test", id: "strong", name: "Strong reasoner", reasoning: true, thinkingLevels: ["off", "low", "medium", "high"], contextWindow: 200_000, maxTokens: 8000, cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 } },
  { provider: "test", id: "cheap", name: "Cheap writer", reasoning: false, thinkingLevels: ["off"], contextWindow: 32_000, maxTokens: 4000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } },
];

test("manual block proposals do not change the library before review; apply is atomic and retryable", async (t) => {
  const { project, library } = await fixture(t);
  const store = new LibraryProposals(project);
  const bundle = structuredClone(library.blocks.review!);
  bundle.prompt = "Review every acceptance criterion and return concrete feedback.";
  const proposal = await store.create(library, "manual", { summary: "Sharper review", blocks: [{ bundle, rationale: "Explicit acceptance evidence" }] }, []);
  assert.equal((await loadLibrary(project)).blocks.review!.prompt, library.blocks.review!.prompt);
  assert.equal((await store.get(proposal.id)).status, "draft");
  await store.apply(proposal.id, []);
  assert.equal((await loadLibrary(project)).blocks.review!.prompt, bundle.prompt);
  assert.equal((await loadLibrary(project)).blocks.fix!.prompt, library.blocks.fix!.prompt);
  assert.equal((await store.apply(proposal.id, [])).status, "applied");
  const before = JSON.parse(await readFile(path.join(project, ".workflow", "libraries", `${proposal.baseHash}.json`), "utf8"));
  assert.equal(before.blocks.review.prompt, library.blocks.review!.prompt);
  // Simulate a crash after publishing the library but before marking the proposal applied.
  const filename = path.join(project, ".workflow", "library-proposals", `${proposal.id}.json`);
  const pending = await store.get(proposal.id);
  await writeFile(filename, JSON.stringify({ ...pending, status: "draft" }));
  assert.equal((await new LibraryProposals(project).apply(proposal.id, [])).status, "applied");
});

test("stale or rejected library proposals preserve later manual edits", async (t) => {
  const { project, library } = await fixture(t);
  const store = new LibraryProposals(project);
  const changes = { summary: "Review adjustment", blocks: [{ bundle: library.blocks.review!, rationale: "Manual change" }] };
  const stale = await store.create(library, "manual", changes, []);
  await writeFile(path.join(project, ".workflow", "blocks", "review", "prompt.md"), "Important manual edit");
  await assert.rejects(store.apply(stale.id, []), /changed/);
  assert.equal((await loadLibrary(project)).blocks.review!.prompt, "Important manual edit");
  const rejected = await store.create(await loadLibrary(project), "manual", changes, []);
  await store.reject(rejected.id);
  await assert.rejects(store.apply(rejected.id, []), /Only draft/);
});

test("model-only updates require every block and preserve instructions and limits", async (t) => {
  const { library } = await fixture(t);
  const blocks = Object.values(library.blocks).map((entry) => ({ bundle: { ...entry, definition: { ...entry.definition, agent: { provider: "test", model: "strong", thinking: "high" as const } } }, rationale: "Strong reasoning for this task" }));
  const good = { summary: "Choose suitable models", blocks };
  assert.equal(validateLibraryChanges(good, library, "models", testModels).blocks.review!.definition.agent!.model, "strong");
  assert.throws(() => validateLibraryChanges({ ...good, blocks: blocks.slice(1) }, library, "models", testModels), /every existing block/);
  const changed = structuredClone(good);
  changed.blocks[0]!.bundle.prompt = "Overwritten prompt";
  assert.throws(() => validateLibraryChanges(changed, library, "models", testModels), /preserve block instructions/);
  const limits = structuredClone(good);
  Object.assign(limits.blocks[0]!.bundle.definition.agent, { maxToolCalls: 1000 });
  assert.throws(() => validateLibraryChanges(limits, library, "models", testModels), /execution limits/);
});

test("generated blocks reject invented models, unsupported thinking, undefined commands and unsafe resources", async (t) => {
  const { library } = await fixture(t);
  const bundle = structuredClone(library.blocks.review!);
  bundle.definition.agent = { provider: "test", model: "imaginary", thinking: "high" };
  const changes = () => ({ summary: "Proposed review", blocks: [{ bundle, rationale: "Reasoning choice" }] });
  assert.throws(() => validateLibraryChanges(changes(), library, "regenerate", testModels), /not available/);
  bundle.definition.agent.model = "cheap";
  assert.throws(() => validateLibraryChanges(changes(), library, "regenerate", testModels), /not supported/);
  bundle.definition.agent = { provider: "test", model: "cheap", thinking: "off" };
  bundle.definition.checks = [{ command: "git-commit", expect: "success" }];
  assert.throws(() => validateLibraryChanges(changes(), library, "regenerate", testModels), /undefined command/);
  bundle.definition.checks = [];
  bundle.definition.skills = ["../secret"];
  bundle.skills = [{ path: "../secret", content: "bad" }];
  assert.throws(() => validateLibraryChanges(changes(), library, "regenerate", testModels), /Invalid.*resource/);
});

test("AI model assignment sees the real allowed catalog and submits strong review plus cheap routine choices", async (t) => {
  const { project, library } = await fixture(t);
  const before = structuredClone(library);
  const changes = await generateLibraryChanges({ project, library, kind: "models", models: testModels, instructions: "Strong review, cheap requirements summaries", signal: new AbortController().signal, emit: () => {} }, async (options) => {
    assert.match(options.systemPrompt, /Available models/);
    assert.match(options.systemPrompt, /Strong reasoner/);
    assert.match(options.systemPrompt, /Price.*not.*quality|not reliable quality/);
    assert.match(options.prompt, /cheap requirements/);
    assert.equal(options.tools.some((tool) => tool.name === "write_file"), true);
    const submit = options.tools.find((tool) => tool.name === "submit_library")!;
    await submit.execute("call", { json: JSON.stringify({ summary: "Balance quality and cost", assignments: Object.keys(library.blocks).map((id) => ({ block: id, agent: { provider: "test", model: id === "requirements" ? "cheap" : "strong", thinking: id === "requirements" ? "off" : "high" }, rationale: id === "requirements" ? "Routine summary uses cheaper model" : "Complex work needs strong reasoning" })) }) }, new AbortController().signal, undefined, toolContext);
  });
  assert.equal(changes.blocks.find((entry) => entry.bundle.definition.id === "review")!.bundle.definition.agent!.model, "strong");
  assert.equal(changes.blocks.find((entry) => entry.bundle.definition.id === "requirements")!.bundle.definition.agent!.model, "cheap");
  assert.deepEqual(library, before);
  assert.deepEqual(await loadLibrary(project), before);
});

test("AI-generated new blocks can write commit-message artifacts without creating an executable commit command", async (t) => {
  const { project, library } = await fixture(t);
  const bundle = structuredClone(library.blocks.review!);
  bundle.definition = { ...bundle.definition, id: "commit-message", name: "Write commit message", outputs: ["message"], checks: [], agent: { provider: "test", model: "cheap", thinking: "off" } };
  bundle.prompt = "Read the changes and publish a concise commit message artifact. Do not commit.";
  const changes = await generateLibraryChanges({ project, library, kind: "regenerate", models: testModels, instructions: "Add a commit message block", signal: new AbortController().signal, emit: () => {} }, async (options) => {
    await options.tools.find((tool) => tool.name === "submit_library")!.execute("call", { json: JSON.stringify({ summary: "Add routine message writer", blocks: [{ bundle, rationale: "Cheaper model handles a concise message" }] }) }, new AbortController().signal, undefined, toolContext);
  });
  const store = new LibraryProposals(project);
  const proposal = await store.create(library, "regenerate", changes, testModels);
  await store.apply(proposal.id, testModels);
  assert.equal((await loadLibrary(project)).blocks["commit-message"]!.definition.agent!.model, "cheap");
  assert.equal(Object.keys((await loadLibrary(project)).blocks).length, Object.keys(library.blocks).length + 1);
  await assert.rejects(generateLibraryChanges({ project, library, kind: "models", models: [], instructions: "", signal: new AbortController().signal, emit: () => {} }), /No models/);
});

test("workflow model validation includes block defaults and rejects unauthenticated or unavailable overrides", async (t) => {
  const { library } = await fixture(t);
  library.config.agent = { ...library.config.agent, provider: "test", model: "strong" };
  library.blocks.review!.definition.agent = { provider: "test", model: "cheap", thinking: "off" };
  const plan = createTemplate("Feature", "feature", library);
  validatePlanModels(plan, library, testModels);
  plan.nodes[0]!.agent = { provider: "unknown", model: "strong" };
  assert.throws(() => validatePlanModels(plan, library, testModels), /not available/);
});

test("AI draft refinement receives the existing graph and cannot submit an unavailable model", async (t) => {
  const { project, library } = await fixture(t);
  const previousPlan = createTemplate("Keep the exact task", "feature", library);
  const plan = await createAiPlan({ project, library, task: previousPlan.task, previousPlan, instructions: "Strengthen the review", models: testModels, signal: new AbortController().signal, emit: () => {} }, async (options) => {
    assert.match(options.systemPrompt, /Available models/);
    assert.equal(JSON.parse(options.prompt).previousPlan.title, previousPlan.title);
    assert.equal(JSON.parse(options.prompt).coordinatorInstructions, "Strengthen the review");
    const submit = options.tools.find((tool) => tool.name === "submit_plan")!;
    const next = structuredClone(previousPlan);
    next.nodes.forEach((node) => { node.agent = { provider: "test", model: "strong", thinking: "high" }; });
    next.nodes[0]!.agent!.model = "invented";
    await assert.rejects(submit.execute("call", { json: JSON.stringify(next) }, new AbortController().signal, undefined, toolContext), /not available/);
    next.nodes[0]!.agent!.model = "strong";
    await submit.execute("call", { json: JSON.stringify(next) }, new AbortController().signal, undefined, toolContext);
  });
  assert.equal(plan.task, previousPlan.task);
  assert.equal(plan.nodes[0]!.agent!.model, "strong");
});
