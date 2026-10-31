import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "vitest";
import { TreeSitterClient } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { TerminalController } from "../src/terminal/controller.js";
import { TerminalWorkspace } from "../src/terminal/view.js";
import { WorkflowClient } from "../src/client/client.js";
import { graphLines, activityCard, transcript } from "../src/terminal/presentation.js";
import { runSchema, setupJobSchema, taskSchema, type RunEvent } from "../src/contracts/index.js";
import { createTemplate } from "../src/core/library/templates.js";
import { fixture } from "./helpers.js";

async function display(width = 120, height = 36) {
  const test = await createTestRenderer({ width, height, kittyKeyboard: true });
  const controller = new TerminalController(new WorkflowClient());
  controller.state.connected = true;
  const cache = await mkdtemp("/tmp/workflow-tui-parser-");
  const parser = new TreeSitterClient({ dataPath: cache });
  await parser.initialize();
  await Promise.all([parser.preloadParser("markdown"), parser.preloadParser("markdown_inline")]);
  const view = new TerminalWorkspace(test.renderer, controller, parser);
  return {
    ...test,
    controller,
    view,
    close: async () => {
      view.destroy();
      await parser.destroy();
      await controller.close();
      await test.dispose();
      await rm(cache, { recursive: true, force: true });
    },
  };
}

test("OpenTUI welcome, command completion, multiline editing, resize and keyboard navigation render", async () => {
  const ui = await display();
  try {
    await ui.renderOnce();
    assert.match(ui.captureCharFrame(), /W O R K F L O W/);
    await writeFile("/tmp/workflow-tui-welcome.txt", ui.captureCharFrame());
    const submitted: string[] = [];
    ui.controller.submit = async (value) => {
      submitted.push(value);
    };
    await ui.mockInput.typeText("/sess");
    await ui.renderOnce();
    assert.match(ui.captureCharFrame(), /Open task and run history/);
    ui.mockInput.pressTab();
    assert.equal(ui.view.composer.plainText, "/sessions ");
    ui.mockInput.pressEnter();
    assert.deepEqual(submitted, ["/sessions "]);
    await ui.mockInput.typeText("First line");
    ui.mockInput.pressEnter({ shift: true });
    await ui.mockInput.typeText("Second line");
    assert.equal(ui.view.composer.plainText, "First line\nSecond line");
    ui.mockInput.pressKey("g", { ctrl: true });
    assert.equal(submitted.at(-1), "/graph");
    ui.resize(64, 24);
    ui.view.render();
    await ui.renderOnce();
    await writeFile("/tmp/workflow-tui-narrow.txt", ui.captureCharFrame());
    assert.match(ui.captureCharFrame(), /REVIEW FIRST/);
    assert.match(ui.captureCharFrame(), /First line/);
    let quit = false;
    ui.controller.on("quit", () => {
      quit = true;
    });
    ui.mockInput.pressCtrlC();
    assert.equal(quit, true);
  } finally {
    await ui.close();
  }
});

test("draft graph, execution cards and actions are visible without a browser", async (t) => {
  const { library } = await fixture(t);
  const ui = await display(124, 40);
  try {
    const now = new Date().toISOString();
    const run = runSchema.parse({
      id: crypto.randomUUID(),
      mode: "demo",
      status: "draft",
      revision: 3,
      createdAt: now,
      updatedAt: now,
      plan: createTemplate("Build an API with tests", "feature", library),
      config: library.config,
      blocks: library.blocks,
      cursor: "requirements",
      visits: {},
      artifacts: {},
      attempts: [],
    });
    ui.controller.state.run = run;
    ui.controller.state.events = [
      {
        id: "1",
        runId: run.id,
        time: now,
        kind: "agent_message",
        message:
          "## Ready to build\n\nI will implement the API, run the tests, and review the result.",
      },
      {
        id: "2",
        runId: run.id,
        time: now,
        kind: "tool_start",
        message: 'read_file {"path":"src/http/server.ts"}',
      },
      {
        id: "3",
        runId: run.id,
        time: now,
        kind: "tool_end",
        message: "read_file: finished\nRead 120 lines.",
      },
      {
        id: "progress",
        runId: run.id,
        time: now,
        kind: "planning",
        message: "Considering the API design",
      },
    ];
    ui.view.render();
    await ui.renderOnce();
    ui.controller.state.project = {
      project: "/projects/workflow",
      mode: "demo",
      config: library.config,
      blocks: library.blocks,
    };
    ui.view.render();
    const frame = await ui.waitForFrame((frame) => frame.includes("Ready to build"));
    await writeFile("/tmp/workflow-tui-draft.txt", frame);
    await writeFile("/tmp/workflow-tui-draft-spans.json", JSON.stringify(ui.captureSpans()));
    assert.match(frame, /Approve & start/);
    assert.match(frame, /Review before execution/);
    assert.match(frame, /START/);
    assert.doesNotMatch(frame, /Read 120 lines|Considering the API design/);
    assert.deepEqual(ui.controller.state.chatVisibility, { tools: false, thinking: false });
    const storedEvents = structuredClone(ui.controller.state.events);
    await ui.mockInput.typeText("Keep this unfinished draft");
    await ui.controller.submit("/tools");
    ui.view.render();
    await ui.renderOnce();
    assert.equal(ui.view.composer.plainText, "Keep this unfinished draft");
    assert.match(ui.captureCharFrame(), /Read 120 lines/);
    assert.doesNotMatch(ui.captureCharFrame(), /Considering the API design/);
    await ui.controller.submit("/progress on");
    ui.view.render();
    await ui.renderOnce();
    assert.match(ui.captureCharFrame(), /Considering the API design/);
    await ui.controller.submit("/tools off");
    await ui.controller.submit("/progress");
    ui.view.render();
    await ui.renderOnce();
    assert.doesNotMatch(ui.captureCharFrame(), /Read 120 lines|Considering the API design/);
    assert.equal(ui.view.composer.plainText, "Keep this unfinished draft");
    assert.deepEqual(ui.controller.state.events, storedEvents);
    await ui.controller.submit("/tools invalid");
    assert.match(ui.controller.state.error, /\/tools \[on\|off\]/);
    assert.deepEqual(ui.controller.state.chatVisibility, { tools: false, thinking: false });
    await ui.controller.submit("/tools on");
    ui.controller.newSession();
    assert.equal(ui.controller.state.chatVisibility.tools, true);
    ui.controller.state.run = run;
    ui.controller.state.events = storedEvents;
    ui.controller.state.screen = "graph";
    ui.view.render();
    await ui.renderOnce();
    assert.match(ui.captureCharFrame(), /revision 3/);
    ui.resize(70, 24);
    ui.view.render();
    await ui.renderOnce();
    assert.match(ui.captureCharFrame(), /Workflow graph/);
  } finally {
    await ui.close();
  }
});

test("setup renders saved stages and disables cancellation during publication", async () => {
  const ui = await display(110, 40);
  try {
    const now = new Date().toISOString();
    ui.controller.state.screen = "setup";
    ui.controller.state.setupJob = setupJobSchema.parse({
      id: crypto.randomUUID(),
      usageScopeId: crypto.randomUUID(),
      revision: 4,
      createdAt: now,
      updatedAt: now,
      status: "interrupted",
      stage: "blocks",
      model: { provider: "test", model: "careful", thinking: "low" },
      instructions: "",
      stages: [
        { id: "profiles", status: "completed", attempt: 1, summary: "Profiles saved" },
        { id: "cases", status: "completed", attempt: 1, summary: "Task instructions saved" },
        { id: "blocks", status: "interrupted", attempt: 1 },
        { id: "validation", status: "pending", attempt: 0 },
        { id: "applying", status: "pending", attempt: 0 },
      ],
      actions: { canResume: true, canCancel: true },
    });
    ui.view.render();
    await ui.renderOnce();
    const stopped = ui.captureCharFrame();
    assert.match(stopped, /Model profiles · completed/);
    assert.match(stopped, /Reusable blocks · interrupted/);
    assert.match(stopped, /Resume setup/);
    assert.match(stopped, /Cancel setup/);
    ui.controller.state.setupJob = {
      ...ui.controller.state.setupJob,
      revision: 5,
      status: "running",
      stage: "applying",
      actions: { canResume: false, canCancel: false },
    };
    ui.view.render();
    await ui.renderOnce();
    const publishing = ui.captureCharFrame();
    assert.match(publishing, /Publication is finishing/);
    assert.doesNotMatch(publishing, /Cancel setup/);
    assert.doesNotMatch(publishing, /Resume setup/);
    ui.resize(65, 28);
    ui.view.render();
    await ui.renderOnce();
    assert.match(ui.captureCharFrame(), /Project setup/);
  } finally {
    await ui.close();
  }
});

test("secret login input is masked for typing and paste, never enters composer or transcript", async () => {
  const ui = await display(80, 24);
  const submitted: string[] = [];
  ui.controller.respondAuth = async (value) => {
    submitted.push(value);
  };
  try {
    ui.controller.state.screen = "auth";
    ui.controller.state.auth = {
      id: crypto.randomUUID(),
      provider: "openai",
      method: "api_key",
      status: "pending",
      events: [],
      prompt: { id: crypto.randomUUID(), type: "secret", message: "Enter your API key" },
    };
    ui.view.render();
    await ui.renderOnce();
    await ui.mockInput.pasteBracketedText("sk-test-private-value");
    await ui.renderOnce();
    const frame = ui.captureCharFrame();
    assert.ok(!frame.includes("sk-test") && !frame.includes("private-value"));
    assert.match(frame, /●●●/);
    assert.equal(ui.view.composer.plainText, "");
    ui.mockInput.pressBackspace();
    await ui.mockInput.typeText("X");
    ui.mockInput.pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(submitted, ["sk-test-private-valuX"]);
    assert.deepEqual(ui.controller.state.events, []);
    await ui.renderOnce();
    assert.ok(!ui.captureCharFrame().includes("sk-test"));
  } finally {
    await ui.close();
  }
});

test("graph distinguishes parallel groups, branches and loop limits; tool errors keep evidence", async (t) => {
  const { library } = await fixture(t);
  const now = new Date().toISOString();
  const run = runSchema.parse({
    id: crypto.randomUUID(),
    mode: "demo",
    status: "running",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    plan: createTemplate("Check", "feature", library),
    config: library.config,
    blocks: library.blocks,
    cursor: "check",
    activeNodes: ["check"],
    visits: {},
    artifacts: {},
    attempts: [],
    program: {
      source: "source",
      filename: "flow.ts",
      input: {},
      models: {},
      catalog: library.blocks,
      composition: "structured",
      structure: {
        id: "root",
        label: "Verify",
        kind: "parallel",
        concurrency: 2,
        children: [
          { id: "check", label: "Tests", kind: "step", children: [] },
          {
            id: "loop",
            label: "Review",
            kind: "loop",
            maxIterations: 3,
            children: [
              {
                id: "branch",
                label: "Publish",
                kind: "when",
                condition: "review.approved",
                children: [],
              },
            ],
          },
        ],
      },
    },
  });
  const graph = graphLines(run)
    .map((line) => line.text)
    .join("\n");
  assert.match(graph, /parallel ×2/);
  assert.match(graph, /≤3 rounds/);
  assert.match(graph, /branch/);
  assert.match(graph, /● Tests/);
  const event = {
    id: "tool",
    runId: run.id,
    time: now,
    kind: "tool_end",
    message: "bash: exit 1\nA failing check",
  };
  assert.equal(activityCard(event)?.tone, "red");
  assert.match(transcript(undefined, run, [event])[1]!.body, /A failing check/);
});

test("transcript filters before its event window and retains questions, failures and final results", async (t) => {
  const { library } = await fixture(t);
  const now = new Date().toISOString();
  const run = runSchema.parse({
    id: crypto.randomUUID(),
    mode: "demo",
    status: "completed",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    plan: createTemplate("Deliver a result", "feature", library),
    config: library.config,
    blocks: library.blocks,
    cursor: "check",
    visits: {},
    artifacts: {},
    attempts: [],
    output: "Final result remains visible",
  });
  const task = taskSchema.parse({
    id: crypto.randomUUID(),
    prompt: "User request",
    createdAt: now,
    updatedAt: now,
    status: "needs_input",
    revision: 0,
    attachments: [],
    answers: [],
    approval: "review",
    question: { question: "Which option?", options: ["First", "Second"] },
  });
  const event = (id: string, kind: string, message: string): RunEvent => ({
    id,
    kind,
    message,
    runId: run.id,
    time: now,
  });
  const events: RunEvent[] = [
    event("message", "agent_message", "Assistant response"),
    event("user", "user_message", "User response"),
    event("error", "planning_error", "Planning failure"),
    event("failed-tool", "tool_end", "bash: exit 1\nFailure evidence"),
    {
      ...event("operation", "operation", ""),
      operation: {
        id: "read",
        name: "read_file",
        kind: "read",
        state: "completed",
        output: [{ type: "text", text: "Completed operation evidence" }],
      },
    },
    event("tool", "tool_end", "read_file: finished\nCompleted tool evidence"),
    ...Array.from({ length: 160 }, (_, i) => event(`progress-${i}`, "planning", `Progress ${i}`)),
  ];
  const original = structuredClone(events);
  const hidden = transcript(task, run, events);
  const hiddenText = hidden.map((card) => card.body).join("\n");
  assert.match(hiddenText, /Assistant response/);
  assert.match(hiddenText, /User response/);
  assert.match(hiddenText, /Planning failure/);
  assert.match(hiddenText, /Failure evidence/);
  assert.match(hiddenText, /Which option\?/);
  assert.match(hiddenText, /Final result remains visible/);
  assert.doesNotMatch(
    hiddenText,
    /Completed operation evidence|Completed tool evidence|Progress \d/,
  );
  const tools = transcript(task, run, events, {}, { tools: true, thinking: false });
  assert.match(tools.map((card) => card.body).join("\n"), /Completed operation evidence/);
  assert.match(tools.map((card) => card.body).join("\n"), /Completed tool evidence/);
  assert.ok(
    transcript(task, run, events, {}, { tools: false, thinking: true }).some((card) =>
      card.body.includes("Progress 159"),
    ),
  );
  assert.deepEqual(events, original);
});
