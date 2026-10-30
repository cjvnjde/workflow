import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { planningMemory } from "../src/core/planning/planning-memory.js";
import { MemoryStore } from "../src/core/memory/memory-store.js";
import { planTask } from "../src/core/planning/task-planner.js";
import { createAiPlan } from "../src/core/planning/planner.js";
import { refineProgram } from "../src/core/planning/program-refiner.js";
import type { runAgentSession } from "../src/core/models/agent-session.js";
import { agentSchema, runSchema } from "../src/contracts/domain.js";
import { taskSchema } from "../src/contracts/task-schema.js";
import { orchestrationSchema } from "../src/contracts/orchestration-schema.js";
import { createTemplate } from "../src/core/library/templates.js";
import { UsageStore } from "../src/core/storage/usage-store.js";
import { fixture } from "./helpers.js";

const models = [
  {
    provider: "memory-test",
    id: "small",
    name: "Small",
    reasoning: false,
    thinkingLevels: ["off"],
    contextWindow: 32000,
    maxTokens: 1000,
    cost: null,
  },
];
const detail =
  "PRIVATE_DETAIL: Prefer concise documentation; use unavailable-provider/unavailable-model only if it becomes available.";
const description = "User preferences for documentation tasks";
const signal = () => new AbortController().signal;
async function call(
  tools: ToolDefinition[],
  name: string,
  args: Record<string, unknown>,
  cancellation = signal(),
) {
  const tool = tools.find((value) => value.name === name);
  assert.ok(tool, "Expected " + name);
  const result = await tool.execute("memory-test", args, cancellation, undefined, {} as never);
  const text = result.content
    .filter((value) => value.type === "text")
    .map((value) => value.text)
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
async function seed(store: MemoryStore) {
  const saved = await store.create({
    revision: (await store.state()).revision,
    kind: "preference",
    title: "Documentation preferences",
    description,
    details: detail,
    tags: ["docs"],
  });
  await store.setEnabled({ enabled: true, revision: saved.state.revision });
  return saved.entry;
}

test("disabled memory adds no planner context/tools and creates no memory storage", async (t) => {
  const { project } = await fixture(t);
  assert.deepEqual(await planningMemory(project, signal()), { tools: [] });
  await assert.rejects(stat(path.join(project, ".workflow/memory")), /ENOENT/);
});

test("memory descriptions are lazy, paginated and revoked for future tool reads after deletion or disable", async (t) => {
  const { project } = await fixture(t);
  const store = new MemoryStore(project),
    entry = await seed(store);
  const context = await planningMemory(project, signal());
  assert.match(context.prompt!, /User preferences for documentation tasks/);
  assert.ok(!context.prompt!.includes(detail));
  assert.deepEqual(
    context.tools.map((tool) => tool.name),
    ["list_memory", "load_memory"],
  );
  const listed = await call(context.tools, "list_memory", { query: "DOCS", limit: 1 });
  assert.equal(listed.entries[0]?.id, entry.id);
  assert.equal(listed.entries[0]?.details, undefined);
  assert.ok(!JSON.stringify(listed).includes("PRIVATE_DETAIL"));
  assert.equal((await call(context.tools, "load_memory", { id: entry.id })).entry.details, detail);
  assert.equal((await call(context.tools, "load_memory", { id: randomUUID() })).available, false);
  const second = await store.create({
    revision: (await store.state()).revision,
    kind: "note",
    title: "Validation note",
    description: "Review check conventions",
    details: "A second selected detail",
    tags: ["checks"],
  });
  const page = await call(context.tools, "list_memory", { limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.equal(page.total, 2);
  assert.ok(page.nextOffset !== null);
  const next = await call(context.tools, "list_memory", { offset: page.nextOffset, limit: 1 });
  assert.equal(next.entries.length, 1);
  assert.notEqual(next.entries[0].id, page.entries[0].id);
  await store.remove(entry.id, { revision: second.state.revision });
  assert.equal((await call(context.tools, "load_memory", { id: entry.id })).available, false);
  await store.setEnabled({ enabled: false, revision: (await store.state()).revision });
  assert.equal(
    (await call(context.tools, "load_memory", { id: second.entry.id })).available,
    false,
  );
  assert.deepEqual((await call(context.tools, "list_memory", {})).entries, []);
  assert.deepEqual(await planningMemory(project, signal()), { tools: [] });
  assert.equal(
    (await store.get(second.entry.id)).details,
    "A second selected detail",
    "Disabling prevents planner reads without deleting user memory",
  );
});

test("cancellation during a selected memory read prevents delivering its details", async (t) => {
  const { project } = await fixture(t);
  const store = new MemoryStore(project),
    entry = await seed(store),
    controller = new AbortController();
  const context = await planningMemory(project, controller.signal, {
    descriptions: store.descriptions.bind(store),
    detail: async (id) => {
      const value = await store.detail(id);
      controller.abort(new Error("Planning cancelled"));
      return value;
    },
  });
  await assert.rejects(call(context.tools, "load_memory", { id: entry.id }), /Planning cancelled/);
  await assert.rejects(planningMemory(project, controller.signal), /Planning cancelled/);
});

test("an aborted tool execution signal prevents reads while the outer planner remains active", async (t) => {
  const { project } = await fixture(t);
  const store = new MemoryStore(project),
    entry = await seed(store);
  const planner = new AbortController(),
    execution = new AbortController();
  let descriptions = 0,
    details = 0;
  const context = await planningMemory(project, planner.signal, {
    descriptions: async (query) => {
      descriptions++;
      return store.descriptions(query);
    },
    detail: async (id) => {
      details++;
      return store.detail(id);
    },
  });
  execution.abort(new Error("Model session stopped"));
  await assert.rejects(
    call(context.tools, "list_memory", {}, execution.signal),
    /Model session stopped/,
  );
  await assert.rejects(
    call(context.tools, "load_memory", { id: entry.id }, execution.signal),
    /Model session stopped/,
  );
  assert.equal(planner.signal.aborted, false);
  assert.equal(descriptions, 1, "Only the initial description catalog was read");
  assert.equal(details, 0);
});

test("task planning, graph planning and TypeScript refinement share the opt-in read-only memory surface", async (t) => {
  const { project, library } = await fixture(t);
  library.config.agent = agentSchema.parse({
    provider: "memory-test",
    model: "small",
    thinking: "off",
  });
  const task = taskSchema.parse({
    id: randomUUID(),
    createdAt: "now",
    updatedAt: "now",
    revision: 0,
    status: "planning",
    prompt: "Review documentation",
    attachments: [],
    answers: [],
    approval: "review",
  });
  const plan = createTemplate(task.prompt, "feature", library);
  const run = runSchema.parse({
    id: randomUUID(),
    createdAt: "now",
    updatedAt: "now",
    mode: "live",
    status: "draft",
    plan,
    config: library.config,
    blocks: library.blocks,
    program: {
      source:
        'import {workflow} from "workflow"; export default workflow({name:"Review",async run(){return "Done";}});',
      catalog: library.blocks,
      models: {},
    },
    cursor: plan.entry,
    visits: {},
    artifacts: {},
    attempts: [],
  });
  const stop = new Error("Session inspected");
  let calls = 0;
  const inspect =
    (enabled: boolean): typeof runAgentSession =>
    async (options) => {
      calls++;
      const names = options.tools.map((tool) => tool.name);
      assert.equal(names.includes("list_memory"), enabled);
      assert.equal(names.includes("load_memory"), enabled);
      assert.equal(options.systemPrompt.includes(description), enabled);
      assert.ok(!options.systemPrompt.includes(detail));
      assert.ok(!names.some((name) => /^(create|save|update|delete)_memory/.test(name)));
      if (enabled) {
        const listed = await call(options.tools, "list_memory", { query: "docs" });
        assert.equal(
          (await call(options.tools, "load_memory", { id: listed.entries[0].id })).entry.details,
          detail,
        );
      }
      throw stop;
    };
  const inspectAll = async (enabled: boolean) => {
    await assert.rejects(
      planTask(
        {
          project,
          library,
          task,
          settings: orchestrationSchema.parse({}),
          models,
          signal: signal(),
          emit() {},
        },
        inspect(enabled),
      ),
      (error) => error === stop,
    );
    await assert.rejects(
      createAiPlan(
        {
          project,
          library,
          task: task.prompt,
          instructions: "Review",
          models,
          signal: signal(),
          emit() {},
        },
        inspect(enabled),
      ),
      (error) => error === stop,
    );
    await assert.rejects(
      refineProgram(
        { project, run, instructions: "Refine", models, signal: signal(), emit() {} },
        inspect(enabled),
      ),
      (error) => error === stop,
    );
  };
  await inspectAll(false);
  await seed(new MemoryStore(project));
  await inspectAll(true);
  assert.equal(
    calls,
    6,
    "Each requested planning operation still invokes exactly one model session",
  );
  assert.equal(
    (await new UsageStore(project).report()).sessionCount,
    0,
    "Reading memory launches no model sessions itself",
  );
});

test("a loaded memory preference cannot bypass available-model validation or change the current task", async (t) => {
  const { project, library } = await fixture(t);
  library.config.agent = agentSchema.parse({
    provider: "memory-test",
    model: "small",
    thinking: "off",
  });
  const entry = await seed(new MemoryStore(project));
  const task = taskSchema.parse({
    id: randomUUID(),
    createdAt: "now",
    updatedAt: "now",
    revision: 0,
    status: "planning",
    prompt: "Review the current change",
    attachments: [],
    answers: [],
    approval: "review",
  });
  let calls = 0;
  const result = await planTask(
    {
      project,
      library,
      task,
      settings: orchestrationSchema.parse({}),
      models,
      signal: signal(),
      emit() {},
    },
    async (options) => {
      calls++;
      await call(options.tools, "load_memory", { id: entry.id });
      await call(options.tools, "choose_task_case", {
        id: "review",
        reason: "The current task requests a review",
      });
      const plan = createTemplate(task.prompt, "feature", library);
      plan.nodes[0]!.agent = {
        provider: "unavailable-provider",
        model: "unavailable-model",
        thinking: "off",
      };
      await assert.rejects(
        call(options.tools, "submit_plan", {
          json: JSON.stringify(plan),
          rationale: "Follow saved preference",
        }),
        /not available/,
      );
      plan.nodes[0]!.agent = { provider: "memory-test", model: "small", thinking: "off" };
      await call(options.tools, "submit_plan", {
        json: JSON.stringify(plan),
        rationale: "Use the available model for the current review",
      });
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.kind, "plan");
  if (result.kind === "plan") {
    assert.equal(result.plan.task, task.prompt);
    assert.equal(result.plan.nodes[0]!.agent!.model, "small");
  }
});
