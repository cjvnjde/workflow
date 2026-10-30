import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  BLOCK_CATALOG_BYTES,
  BLOCK_DETAIL_BYTES,
  blockCatalogTools,
  describeBlocks,
  readBlockDetail,
  type BlockDetailPage,
} from "../src/core/library/block-catalog.js";
import {
  agentSchema,
  blocksForAgent,
  bundleSchema,
  runSchema,
  type Library,
} from "../src/contracts/domain.js";
import { designInspectionTools } from "../src/core/design/design-tools.js";
import { planTask } from "../src/core/planning/task-planner.js";
import { createAiPlan } from "../src/core/planning/planner.js";
import { refineProgram } from "../src/core/planning/program-refiner.js";
import { generateLibraryChanges } from "../src/core/library/library-generator.js";
import { orchestrationSchema } from "../src/contracts/orchestration-schema.js";
import { taskSchema } from "../src/contracts/task-schema.js";
import { createTemplate } from "../src/core/library/templates.js";
import type { runAgentSession } from "../src/core/models/agent-session.js";
import { fixture } from "./helpers.js";

const signal = () => new AbortController().signal;
const models = [
  {
    provider: "catalog-test",
    id: "small",
    name: "Small",
    reasoning: false,
    thinkingLevels: ["off"],
    contextWindow: 32000,
    maxTokens: 1000,
    cost: null,
  },
];
function bundle(id: string, source = "SELECTED_SOURCE_SENTINEL") {
  return bundleSchema.parse({
    definition: {
      id,
      name: "Example " + id,
      description: "A reusable block for " + id,
      executor: { kind: "code", source },
      contract: {
        inputs: "A request",
        outputs: "A result",
        effects: "No effects",
        failure: "Throws",
      },
      permissions: { read: ["**/*"], write: [] },
      skills: ["skill.md"],
    },
    prompt: "PRIVATE_PROMPT_" + id,
    skills: [{ path: "skill.md", content: "PRIVATE_SKILL_" + id }],
  });
}
async function call(
  tools: ToolDefinition[],
  name: string,
  args: Record<string, unknown>,
  cancellation = signal(),
) {
  const tool = tools.find((value) => value.name === name);
  assert.ok(tool, "Missing tool " + name);
  const result = await tool.execute("catalog-test", args, cancellation, undefined, {} as never);
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

test("description catalogs stay bounded, search descriptions only, and substantially reduce initial prompt bytes", () => {
  const blocks = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => {
      const id = "block-" + String(index).padStart(2, "0");
      const value = bundle(id, ("UNUSED_SOURCE_" + id + " ").repeat(1000));
      value.definition.description = "Long description 😀 ".repeat(160);
      return [id, value];
    }),
  );
  const tools = blockCatalogTools({ blocks: () => blocks, signal: signal() });
  const page = describeBlocks(blocks);
  assert.ok(page.entries.length <= 20);
  assert.ok(page.entries.every((entry) => entry.descriptionTruncated));
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= BLOCK_CATALOG_BYTES);
  assert.ok(page.nextOffset !== null);
  assert.equal(describeBlocks(blocks, { query: "UNUSED_SOURCE" }).total, 0);
  const next = describeBlocks(blocks, { offset: page.nextOffset! });
  assert.notEqual(page.entries[0]!.id, next.entries[0]!.id);
  const initial = tools.prompt(),
    previous = JSON.stringify(blocksForAgent(blocks));
  assert.ok(!initial.includes("UNUSED_SOURCE"));
  assert.ok(!initial.includes("PRIVATE_PROMPT"));
  assert.ok(!initial.includes("PRIVATE_SKILL"));
  assert.ok(
    Buffer.byteLength(initial) < Buffer.byteLength(previous) * 0.25,
    "The initial description catalog must remove at least75% of this fixture's eager catalog bytes",
  );
});

test("selected details preserve exact Unicode and JSON across bounded pages without exposing sibling sources", () => {
  const source = "/*" + '😀 Привіт "\\\\\n'.repeat(6000) + "*/\nexport default 1;";
  const blocks = {
    selected: bundle("selected", source),
    sibling: bundle("sibling", "SIBLING_SOURCE_SENTINEL"),
  };
  let offset = 0,
    combined = "",
    pages = 0,
    final: BlockDetailPage | undefined;
  do {
    const page = readBlockDetail(blocks, {
      id: "selected",
      path: ["definition", "executor", "source"],
      offset,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= BLOCK_DETAIL_BYTES);
    assert.ok(!page.text.includes("SIBLING_SOURCE_SENTINEL"));
    assert.equal(page.complete, false);
    combined += page.text;
    pages++;
    final = page;
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (pages < 100);
  assert.ok(pages > 1);
  assert.equal(final?.nextOffset, null);
  assert.equal(final?.complete, false, "A later final page is not the complete source");
  assert.equal(combined, source);
  let json = "",
    jsonOffset = 0;
  for (let index = 0; index < 100; index++) {
    const page = readBlockDetail(blocks, { id: "selected", offset: jsonOffset });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= BLOCK_DETAIL_BYTES);
    json += page.text;
    if (page.nextOffset === null) break;
    jsonOffset = page.nextOffset;
  }
  assert.deepEqual(
    JSON.parse(json),
    blocksForAgent(blocks).selected,
    "Whole-bundle JSON pages reassemble without losing nested source or instructions",
  );
  assert.throws(
    () =>
      readBlockDetail(blocks, {
        id: "selected",
        path: ["definition", "executor", "source"],
        offset: source.indexOf("😀") + 1,
      }),
    /splits a Unicode/,
  );
  const empty = readBlockDetail(blocks, {
    id: "selected",
    path: ["definition", "executor", "source"],
    offset: source.length + 10,
  });
  assert.equal(empty.text, "");
  assert.equal(empty.complete, false);
  assert.equal(empty.nextOffset, null);
  const contract = readBlockDetail(blocks, { id: "selected", path: ["definition", "contract"] });
  assert.equal(contract.format, "json");
  assert.equal(contract.complete, true);
  assert.deepEqual(JSON.parse(contract.text), blocks.selected.definition.contract);
  const small = readBlockDetail({ selected: bundle("selected") }, { id: "selected" });
  assert.equal(small.complete, true);
  assert.equal(JSON.parse(small.text).definition.permissions, undefined);
  assert.equal(JSON.parse(small.text).prompt, "PRIVATE_PROMPT_selected");
});

test("block lookup refuses inherited IDs, prototype paths and getters", () => {
  const blocks: Library["blocks"] = Object.assign(
    Object.create({ inherited: bundle("inherited") }),
    { selected: bundle("selected") },
  );
  for (const id of ["inherited", "constructor", "toString", "__proto__"])
    assert.throws(() => readBlockDetail(blocks, { id }));
  for (const path of [
    ["__proto__"],
    ["definition", "constructor"],
    ["skills", "map"],
    ["definition", "missing"],
  ])
    assert.throws(() => readBlockDetail(blocks, { id: "selected", path }), /Unknown block field/);
  let invoked = false;
  Object.defineProperty(blocks.selected!.definition, "getter", {
    enumerable: true,
    get() {
      invoked = true;
      return "hidden";
    },
  });
  assert.throws(
    () => readBlockDetail(blocks, { id: "selected", path: ["definition", "getter"] }),
    /Unknown block field/,
  );
  assert.throws(() => readBlockDetail(blocks, { id: "selected" }), /contains a getter/);
  assert.equal(invoked, false);
  for (const property of [
    {
      value() {
        invoked = true;
        return "lossy";
      },
    },
    {
      get() {
        invoked = true;
        return () => "lossy";
      },
    },
  ]) {
    const selected = bundle("selected");
    Object.defineProperty(selected.definition, "toJSON", { ...property, enumerable: false });
    assert.throws(() => readBlockDetail({ selected }, { id: "selected" }), /custom toJSON/);
  }
  const selected = bundle("selected");
  Object.defineProperty(selected.definition, "description", {
    enumerable: true,
    get() {
      invoked = true;
      return "secret";
    },
  });
  assert.throws(() => describeBlocks({ selected }), /contains a getter/);
  assert.equal(invoked, false);
});

test("outer and tool-only cancellation prevent block reads", async () => {
  const planner = new AbortController(),
    execution = new AbortController();
  let reads = 0;
  const context = blockCatalogTools({
    blocks: () => {
      reads++;
      return { selected: bundle("selected") };
    },
    signal: planner.signal,
  });
  execution.abort(new Error("Tool stopped"));
  await assert.rejects(
    call(context.tools, "load_block", { id: "selected" }, execution.signal),
    /Tool stopped/,
  );
  await assert.rejects(call(context.tools, "list_blocks", {}, execution.signal), /Tool stopped/);
  assert.equal(reads, 0);
  planner.abort(new Error("Planner stopped"));
  assert.throws(context.prompt, /Planner stopped/);
  await assert.rejects(call(context.tools, "load_block", { id: "selected" }), /Planner stopped/);
});

test("all four planning surfaces omit unused sources and refinement reads its frozen catalog", async (t) => {
  const { project, library } = await fixture(t);
  library.config.agent = agentSchema.parse({
    provider: "catalog-test",
    model: "small",
    thinking: "off",
  });
  for (let index = 0; index < 6; index++) {
    const id = "unused-" + index;
    library.blocks[id] = bundle(
      id,
      "/* UNUSED_SOURCE_SENTINEL " + "x".repeat(20_000) + " */\nexport default 1;",
    );
  }
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
      catalog: structuredClone(library.blocks),
      models: {},
    },
    cursor: plan.entry,
    visits: {},
    artifacts: {},
    attempts: [],
  });
  const old = readBlockDetail(run.program!.catalog, {
    id: "unused-0",
    path: ["definition", "executor", "source"],
    limit: 100,
  }).text;
  const changed = library.blocks["unused-0"]!.definition.executor;
  if (changed?.kind !== "code") throw new Error("Expected code fixture");
  changed.source = "UPDATED_CURRENT_LIBRARY_SOURCE";
  await writeFile(
    path.join(project, "workflow.ts"),
    "A later project edit must not replace the run catalog.",
  );
  const stop = new Error("Session inspected");
  let sessions = 0;
  const inspect =
    (frozen = false): typeof runAgentSession =>
    async (options) => {
      sessions++;
      assert.ok(options.tools.some((tool) => tool.name === "list_blocks"));
      assert.ok(options.tools.some((tool) => tool.name === "load_block"));
      for (const hidden of [
        "UNUSED_SOURCE_SENTINEL",
        "PRIVATE_PROMPT_unused",
        "PRIVATE_SKILL_unused",
        "UPDATED_CURRENT_LIBRARY_SOURCE",
      ])
        assert.ok(!options.systemPrompt.includes(hidden), "Initial prompt leaked " + hidden);
      const catalog = blockCatalogTools({
        blocks: () => (frozen ? run.program!.catalog : library.blocks),
        signal: signal(),
      }).prompt();
      const before =
        Buffer.byteLength(options.systemPrompt) -
        Buffer.byteLength(catalog) +
        Buffer.byteLength(
          JSON.stringify(blocksForAgent(frozen ? run.program!.catalog : library.blocks)),
        );
      assert.ok(
        Buffer.byteLength(options.systemPrompt) < before * 0.25,
        "This unused-library fixture should reduce the complete initial prompt by at least75%",
      );
      const selected = await call(options.tools, "load_block", {
        id: "unused-0",
        path: ["definition", "executor", "source"],
        limit: 100,
      });
      assert.equal(selected.text, frozen ? old : changed.source);
      throw stop;
    };
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
      inspect(),
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
      inspect(),
    ),
    (error) => error === stop,
  );
  await assert.rejects(
    refineProgram(
      { project, run, instructions: "Refine", models, signal: signal(), emit() {} },
      inspect(true),
    ),
    (error) => error === stop,
  );
  await assert.rejects(
    generateLibraryChanges(
      {
        project,
        library,
        kind: "regenerate",
        instructions: "Tailor blocks",
        models,
        signal: signal(),
        emit() {},
      },
      inspect(),
    ),
    (error) => error === stop,
  );
  assert.equal(sessions, 4, "Catalog access must not start an extra model session");
});

test("a validated task-local block becomes immediately readable without weakening submission validation", async (t) => {
  const { project, library } = await fixture(t);
  library.config.agent = agentSchema.parse({
    provider: "catalog-test",
    model: "small",
    thinking: "off",
  });
  const task = taskSchema.parse({
    id: randomUUID(),
    createdAt: "now",
    updatedAt: "now",
    revision: 0,
    status: "planning",
    prompt: "Review the task",
    attachments: [],
    answers: [],
    approval: "review",
  });
  const proposed = bundle(
    "local-report",
    'import {block} from "workflow"; export default block({async run(){return {localMarker:"TASK_LOCAL_SOURCE"};}});',
  );
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
      await assert.rejects(
        call(options.tools, "load_block", { id: "local-report" }),
        /Unknown block/,
      );
      await call(options.tools, "suggest_block", {
        json: JSON.stringify(proposed),
        rationale: "A focused report block",
      });
      const catalog = await call(options.tools, "list_blocks", { query: "local-report" });
      assert.equal(catalog.entries[0]?.id, "local-report");
      const source = await call(options.tools, "load_block", {
        id: "local-report",
        path: ["definition", "executor", "source"],
      });
      assert.match(source.text, /TASK_LOCAL_SOURCE/);
      await call(options.tools, "choose_task_case", { id: "review", reason: "Review the request" });
      const plan = createTemplate(task.prompt, "feature", library);
      plan.nodes[0]!.agent = { provider: "catalog-test", model: "invented", thinking: "off" };
      await assert.rejects(
        call(options.tools, "submit_plan", {
          json: JSON.stringify(plan),
          rationale: "Check models",
        }),
        /not available/,
      );
      plan.nodes[0]!.agent = { provider: "catalog-test", model: "small", thinking: "off" };
      await call(options.tools, "submit_plan", {
        json: JSON.stringify(plan),
        rationale: "Use available models",
      });
    },
  );
  assert.equal(result.kind, "plan");
  if (result.kind === "plan") assert.ok(result.library.blocks["local-report"]);
  assert.equal(library.blocks["local-report"], undefined);
});

test("designer block inspection defaults to descriptions and keeps selected-path paging plus history reads", async (t) => {
  const { library } = await fixture(t);
  const source = "DESIGN_SELECTED_SOURCE ".repeat(2000);
  library.blocks.selected = bundle("selected", source);
  library.blocks.sibling = bundle("sibling", "DESIGN_SIBLING_SECRET");
  const tools = designInspectionTools({
    library,
    settings: orchestrationSchema.parse({}),
    models,
    signal: signal(),
    inspect: async () => ({ attempts: [{ summary: "Retained history" }] }),
  });
  const listed = await call(tools, "workflow_inspect", { resource: "blocks", limit: 100 });
  assert.ok(listed.entries.some((entry: { id: string }) => entry.id === "selected"));
  assert.ok(!JSON.stringify(listed).includes("DESIGN_SELECTED_SOURCE"));
  assert.ok(!JSON.stringify(listed).includes("DESIGN_SIBLING_SECRET"));
  const page = await call(tools, "workflow_inspect", {
    resource: "blocks",
    path: ["selected", "definition", "executor", "source"],
    limit: 1,
  });
  assert.equal(page.text, source.slice(0, 1000));
  assert.equal(page.nextOffset, 1000);
  assert.equal(page.complete, false);
  await assert.rejects(
    call(tools, "workflow_inspect", { resource: "blocks", path: ["constructor"] }),
    /Reserved identifier/,
  );
  const history = await call(tools, "workflow_inspect", {
    resource: "run",
    id: randomUUID(),
    path: ["attempts"],
    limit: 1,
  });
  assert.equal(history.items[0].summary, "Retained history");
});
