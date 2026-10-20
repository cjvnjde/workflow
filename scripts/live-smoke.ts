// Explicit opt-in: uses the existing ChatGPT subscription and real model requests.
// All project/Git mutations stay in disposable fixtures. Chromium is always headless.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { availableModels } from "../src/available-models.js";
import { providerStatus } from "../src/provider-status.js";
import { initializeProject } from "../src/library.js";
import { WorkflowEngine } from "../src/engine.js";
import { runPiBlock } from "../src/block-runner.js";
import { createServer } from "../src/server.js";
import { agentSchema, runSchema, type WorkflowRun } from "../src/domain.js";
import { taskSchema, type TaskRequest } from "../src/task-schema.js";
import {
  loadOrchestration,
  saveOrchestration,
} from "../src/orchestration-settings.js";
import { designSessionSchema } from "../src/design-schema.js";

const execute = promisify(execFile);
const signal = AbortSignal.timeout(15 * 60_000);
const scenario = process.env.WORKFLOW_LIVE_SCENARIO ?? "all";
assert.ok(
  ["all", "publication", "cancellation"].includes(scenario),
  "Use all, publication or cancellation for WORKFLOW_LIVE_SCENARIO",
);
const providers = await providerStatus(signal);
assert.ok(
  providers.some(
    (provider) => provider.id === "openai" && provider.method === "oauth",
  ),
  "Connect ChatGPT in Workflow before running test:live. This check does not provision API keys.",
);
const catalog = await availableModels(signal);
const model = catalog.models.find(
  (item) =>
    item.provider === "openai" &&
    item.id === (process.env.WORKFLOW_LIVE_MODEL ?? "gpt-6-luna"),
);
assert.ok(
  model,
  "The selected live-test model is not in the connected catalog.",
);
const agent = agentSchema.parse({
  provider: model.provider,
  model: model.id,
  thinking: "medium",
  timeoutMs: 240_000,
  maxToolCalls: 50,
});
const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-live-"));
const project = path.join(directory, "project");
const remote = path.join(directory, "remote.git");
await mkdir(project);
const git = (...args: string[]) => execute("git", args, { cwd: project });
await execute("git", ["init", "--bare", remote]);
await git("init", "-b", "main");
await git("config", "user.name", "Workflow Live Test");
await git("config", "user.email", "live-test@example.invalid");
await git("config", "commit.gpgsign", "false");
await git("config", "core.hooksPath", "/dev/null");
await git("remote", "add", "origin", remote);
await writeFile(
  path.join(project, "package.json"),
  JSON.stringify({
    name: "workflow-live-fixture",
    private: true,
    type: "module",
    scripts: { test: "bun test" },
  }),
);
await writeFile(path.join(project, ".gitignore"), "node_modules/\n.env\n");
await writeFile(path.join(project, ".env"), "EXAMPLE_FIXTURE_ONLY=private\n");
await writeFile(
  path.join(project, "math.ts"),
  "export function add(a: number, b: number) { return a + b; }\n",
);
await writeFile(
  path.join(project, "math.test.ts"),
  'import { test, expect } from "bun:test";\nimport { add } from "./math";\ntest("adds numbers", () => expect(add(2, 3)).toBe(5));\n',
);
const library = await initializeProject(project);
library.config.agent = agent;
library.config.coordinator = agent;
library.config.instructions =
  "This is a disposable Bun/TypeScript test project. Use the task's acceptance criteria and existing conventions. Git identity and origin are configured locally. Keep private .env and .workflow runtime data out of commits. Do not interact with other directories except the configured local origin. Keep workflows small and task-specific.";
await writeFile(
  path.join(project, ".workflow/config.json"),
  JSON.stringify(library.config, null, 2),
);
const orchestration = await loadOrchestration(project);
await saveOrchestration(
  project,
  {
    ...orchestration,
    settings: {
      ...orchestration.settings,
      approval: "review",
      profiles: [
        {
          id: "live",
          name: "Live test model",
          description: "Use for all steps in this small test project.",
          enabled: true,
          agent: {
            provider: agent.provider,
            model: agent.model,
            thinking: agent.thinking,
          },
        },
      ],
      coordinatorProfile: "live",
    },
  },
  catalog.models,
);

const engine = new WorkflowEngine(project, "live", runPiBlock);
await engine.initialize();
const server = await createServer(engine, 0);
const { address, browser } = await (async () => {
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.WORKFLOW_CHROMIUM_PATH
        ? { executablePath: process.env.WORKFLOW_CHROMIUM_PATH }
        : {}),
    });
    return { address, browser };
  } catch (error) {
    await server.close();
    await engine.shutdown();
    throw error;
  }
})();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const reports: { task: TaskRequest; run: WorkflowRun }[] = [];
async function api(route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${address}${route}`, {
    method,
    signal,
    headers: {
      "x-workflow-client": "1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `${method} ${route}: ${response.status} ${text.slice(0, 1500)}`,
    );
  return JSON.parse(text) as unknown;
}
async function until<T>(
  description: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 300_000,
) {
  const started = Date.now();
  let progress = started;
  while (Date.now() - started < timeout) {
    signal.throwIfAborted();
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() - progress > 20_000) {
      console.log(
        `${description}: waiting (${Math.round((Date.now() - started) / 1000)}s)`,
      );
      progress = Date.now();
    }
    await Bun.sleep(500);
  }
  throw new Error(`Timed out: ${description}`);
}
async function startTaskFromComposer(prompt: string, attachment?: string) {
  await page.goto(address);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByLabel("What should we work on?", { exact: true })
    .fill(prompt);
  if (attachment)
    await page.locator('input[type="file"]').setInputFiles(attachment);
  const created = page.waitForResponse(
    (response) =>
      response.url() === `${address}/api/tasks` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  const task = taskSchema.parse(await (await created).json());
  console.log(`Planning ${task.id}: ${prompt}`);
  return task;
}
async function taskFromComposer(prompt: string, attachment?: string) {
  const task = await startTaskFromComposer(prompt, attachment);
  const planned = await until(
    "Planning",
    async () => taskSchema.parse(await api(`/api/tasks/${task.id}`)),
    (item) => !["queued", "planning"].includes(item.status),
  );
  await writeFile(
    path.join(directory, `${task.id}-planning.json`),
    JSON.stringify(planned, null, 2),
  );
  assert.equal(
    planned.status,
    "ready",
    planned.error ?? JSON.stringify(planned.question),
  );
  assert.ok(planned.runId);
  return planned;
}
async function finish(task: TaskRequest, publicationStep?: string) {
  let reachedPublication = false;
  const run = await until(
    "Execution",
    async () => {
      const run = runSchema.parse(await api(`/api/runs/${task.runId}`));
      reachedPublication ||=
        run.cursor === publicationStep ||
        run.attempts.some((attempt) => attempt.nodeId === publicationStep);
      if (publicationStep && !reachedPublication) {
        const pushed = (
          await execute("git", ["--git-dir", remote, "rev-list", "--all"])
        ).stdout;
        const committed = (await git("rev-list", "--all")).stdout;
        if (pushed || committed) {
          // A step can transition while the read-only Git checks are in flight.
          const latest = runSchema.parse(await api(`/api/runs/${task.runId}`));
          reachedPublication = latest.attempts.some(
            (attempt) => attempt.nodeId === publicationStep,
          );
          assert.ok(
            reachedPublication,
            "Implementation/verification must not commit or push ahead of the publication step",
          );
          return latest;
        }
      }
      return run;
    },
    (item) =>
      ["completed", "failed", "interrupted", "cancelled"].includes(item.status),
  );
  reports.push({ task, run });
  await writeFile(
    path.join(directory, `${task.id}-run.json`),
    JSON.stringify(run, null, 2),
  );
  await page.screenshot({
    path: path.join(directory, `${task.id}.png`),
    fullPage: true,
  });
  assert.equal(
    run.status,
    "completed",
    run.error ?? run.attempts.at(-1)?.result?.summary,
  );
  await expect(page.locator(".status-pill")).toHaveText("Completed");
  return run;
}
async function approveAndFinish(
  task: TaskRequest,
  checkPublicationOrder = false,
) {
  const draft = runSchema.parse(await api(`/api/runs/${task.runId}`));
  assert.equal(draft.status, "draft", "Review mode must wait for approval");
  assert.equal(draft.attempts.length, 0);
  const publicationStep = checkPublicationOrder
    ? draft.plan.nodes.find((node) =>
        /publish|commit|push/i.test(`${node.id} ${node.label}`),
      )
    : undefined;
  if (checkPublicationOrder)
    assert.ok(
      publicationStep,
      "The plan must include a dedicated publication step",
    );
  await expect(
    page.getByRole("button", { name: "Approve & start", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Approve & start", exact: true })
    .click();
  return await finish(task, publicationStep?.id);
}

async function checkCancellation() {
  const planning = await startTaskFromComposer(
    "Review the accessible source and tests for correctness. Plan one read-only inspection step.",
  );
  await until(
    "Planning model started",
    async () => taskSchema.parse(await api(`/api/tasks/${planning.id}`)),
    (task) => task.events.some((event) => event.kind === "agent_start"),
  );
  await page
    .getByRole("button", { name: "Cancel planning", exact: true })
    .click();
  const stoppedPlanning = await until(
    "Planning cancelled",
    async () => taskSchema.parse(await api(`/api/tasks/${planning.id}`)),
    (task) => task.status === "cancelled",
  );
  assert.equal(stoppedPlanning.runId, undefined);
  await page.reload();
  assert.equal(
    taskSchema.parse(await api(`/api/tasks/${planning.id}`)).status,
    "cancelled",
  );
  console.log(
    "PASS: real coordinator cancellation persists without creating a workflow.",
  );

  const execution = await taskFromComposer(
    "This is an execution-cancellation test. Plan one AI step whose only action during execution is to run this exact Bash command: `printf ready > cancel-started; sleep 8; printf unexpected > cancel-late`. Do not run it during planning. Do not edit source, tests, Git state or configuration. The user will stop execution while the command sleeps. No checks or other steps are needed.",
  );
  await assert.rejects(stat(path.join(project, "cancel-started")), /ENOENT/);
  await page
    .getByRole("button", { name: "Approve & start", exact: true })
    .click();
  await until(
    "Real Bash command started",
    () =>
      stat(path.join(project, "cancel-started")).then(
        () => true,
        () => false,
      ),
    (started) => started,
  );
  await page
    .getByRole("button", { name: "Stop execution", exact: true })
    .click();
  const stoppedRun = await until(
    "Execution cancelled",
    async () => runSchema.parse(await api(`/api/runs/${execution.runId}`)),
    (run) => run.status === "cancelled",
    30_000,
  );
  await expect(page.locator(".status-pill")).toHaveText("Cancelled");
  await Bun.sleep(8500);
  await assert.rejects(stat(path.join(project, "cancel-late")), /ENOENT/);
  await page.reload();
  await expect(page.locator(".status-pill")).toHaveText("Cancelled");
  assert.equal((await git("rev-list", "--all")).stdout, "");
  reports.push({ task: execution, run: stoppedRun });
  console.log(
    "PASS: real execution cancellation stops Bash with no late write and survives browser reload.",
  );

  // A subsequent real request proves cancellation releases both the task queue
  // and the project's execution ownership.
  const next = await taskFromComposer(
    "Use one read-only inspection step to summarize the add function in math.ts as a Markdown artifact. Do not change files or Git state.",
  );
  await approveAndFinish(next);
  assert.equal(
    await readFile(path.join(project, "math.ts"), "utf8"),
    "export function add(a: number, b: number) { return a + b; }\n",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify(
      {
        scenario,
        model: agent.model,
        stoppedPlanning,
        reports,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `Live cancellation checks passed. Report and screenshots: ${directory}`,
  );
}

console.log(
  `Live fixture: ${directory}\nModel: ${agent.provider}/${agent.model}\nBrowser: headless`,
);
async function checkWorkflows() {
  if (scenario === "all") {
    // The original failure: an unborn branch should still produce a useful review.
    const review = await taskFromComposer(
      "Review changes in the current branch.",
    );
    assert.equal(
      await readFile(path.join(project, "math.ts"), "utf8"),
      "export function add(a: number, b: number) { return a + b; }\n",
    );
    await approveAndFinish(review);
    assert.equal(
      (await git("rev-list", "--all")).stdout,
      "",
      "Review must not create a commit",
    );
    console.log(
      "PASS: real planning adapts to an unborn branch; review executes after approval.",
    );

    // Real conversational settings generation, applied through the browser.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Model profiles", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Design with AI", exact: true })
      .click();
    const chat = page.getByRole("dialog", {
      name: "Design model profiles with AI",
      exact: true,
    });
    await chat
      .getByLabel("Message AI designer", { exact: true })
      .fill(
        `Replace the profiles with one called Project lead. Use openai/${agent.model} with medium thinking for planning and every execution role in this tiny project. Set it as planning model. Explain the proposed change.`,
      );
    await chat
      .getByRole("button", { name: "Send to AI designer", exact: true })
      .click();
    const design = await until(
      "Settings designer",
      async () => {
        const state = await api("/api/design/profiles/latest");
        return state ? designSessionSchema.parse(state) : undefined;
      },
      (item) => !!item && ["ready", "failed"].includes(item.status),
    );
    assert.equal(design?.status, "ready", design?.error);
    await chat
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect(
      chat.getByText("Changes applied", { exact: true }),
    ).toBeVisible();
    await chat
      .getByRole("button", { name: "Minimize design chat", exact: true })
      .click();
    assert.equal(
      (await loadOrchestration(project)).settings.profiles[0]?.name,
      "Project lead",
    );
    console.log(
      "PASS: real settings chat generates and applies a model profile.",
    );
  }

  // Attachment, code/test changes, a task-local publication block and real local push.
  const screenshot = path.join(directory, "acceptance.png");
  const attachmentPage = await context.newPage();
  await attachmentPage.setContent(
    '<main style="font:24px sans-serif;padding:32px"><h1>Clamp acceptance criteria</h1><p>Export clamp(value, min, max) from math.ts.</p><p>Below min → min; above max → max; otherwise → value.</p><p>If min &gt; max, throw RangeError.</p><p>Keep add() working. Add focused tests.</p></main>',
  );
  await attachmentPage.screenshot({ path: screenshot });
  await attachmentPage.close();
  const feature = await taskFromComposer(
    "Implement the clamp function described in the attached screenshot and add focused tests. After verifying the changes, stage and commit the intended project files in a dedicated commit step, then use the editable JavaScript push script block to push to the already configured origin on main, without an AI call for the push. Use the existing Git identity. Exclude private/runtime files.",
    screenshot,
  );
  const implemented = await approveAndFinish(feature, true);
  const pushNode = implemented.plan.nodes.find(
    (node) =>
      implemented.blocks[node.block]?.definition.executor?.kind === "script",
  );
  assert.ok(
    pushNode,
    "The planner should select the editable push script",
  );
  const pushAttempt = implemented.attempts.find(
    (attempt) => attempt.nodeId === pushNode.id,
  );
  assert.equal(pushAttempt?.result?.outcome, "pass");
  assert.equal(
    pushAttempt?.usage?.requests ?? 0,
    0,
    "The push script must not call a model",
  );
  const local = (await git("rev-parse", "HEAD")).stdout.trim();
  const published = (
    await execute("git", ["--git-dir", remote, "rev-parse", "main"])
  ).stdout.trim();
  assert.equal(published, local);
  const tracked = (await git("ls-files")).stdout.trim().split("\n");
  for (const filename of [
    "math.ts",
    "math.test.ts",
    "package.json",
    ".gitignore",
  ]) {
    assert.ok(
      tracked.includes(filename),
      `Initial publication must include ${filename}`,
    );
  }
  assert.ok(
    !tracked.some(
      (file) =>
        file === ".env" ||
        /^\.workflow\/(runs|tasks|attachments|versions|temporal|design-chats|server-lease)\//.test(
          file,
        ),
    ),
  );
  const acceptance = await execute(
    process.execPath,
    [
      "-e",
      'import assert from "node:assert/strict"; import {add,clamp} from "./math.ts"; assert.equal(add(2,3),5); assert.equal(clamp(-1,0,10),0); assert.equal(clamp(20,0,10),10); assert.equal(clamp(5,0,10),5); assert.throws(()=>clamp(5,10,0),RangeError); console.log("Acceptance passed");',
    ],
    { cwd: project },
  );
  assert.match(acceptance.stdout, /Acceptance passed/);
  await execute(process.execPath, ["run", "test"], { cwd: project });
  assert.ok(implemented.attempts.length > 0);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const allSteps = page.getByRole("button", {
    name: "Show all steps",
    exact: true,
  });
  if (await allSteps.isVisible()) await allSteps.click();
  await page
    .getByRole("button", { name: "Expand workspace", exact: true })
    .click();
  const workspace = page.getByRole("dialog", {
    name: "Expanded workflow workspace",
    exact: true,
  });
  await expect(workspace).toBeVisible();
  await workspace.getByLabel("Search activity", { exact: true }).fill("bash");
  await expect(workspace.locator(".event").first()).toBeVisible();
  await page.screenshot({
    path: path.join(directory, "expanded-activity.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(workspace).not.toBeVisible();
  await expect(page.getByLabel("Search activity", { exact: true })).toHaveValue(
    "bash",
  );
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page
    .getByRole("button", { name: "Expand workspace", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Fit workflow", exact: true })
    .click();
  await page.screenshot({
    path: path.join(directory, "expanded-workflow.png"),
    fullPage: true,
  });
  await workspace
    .getByRole("button", { name: "Close expanded view", exact: true })
    .click();
  await page.getByRole("button", { name: /View full results/ }).click();
  const artifact = page.locator(".result-artifact").first();
  await expect(artifact.locator(".markdown-body")).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await artifact
    .getByRole("button", { name: "Copy Markdown", exact: true })
    .click();
  await expect(
    artifact.getByText("Markdown copied", { exact: true }),
  ).toHaveCount(1);
  const markdown = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(markdown.length > 0);
  const downloadStarted = page.waitForEvent("download");
  await artifact
    .getByRole("button", { name: "Download Markdown", exact: true })
    .click();
  const download = await downloadStarted;
  assert.equal(await readFile((await download.path())!, "utf8"), markdown);
  console.log(
    `PASS: screenshot → workflow → code + tests → commit → push. HEAD ${local}`,
  );

  if (scenario === "all") {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Execution", exact: true }).click();
    await page
      .getByLabel("Workflow approval", { exact: true })
      .selectOption("automatic");
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    const automatic = await taskFromComposer(
      "Use one inspection step to summarize the exported functions in math.ts as a concise Markdown artifact. Do not edit files or make a commit.",
    );
    assert.equal(automatic.approval, "automatic");
    await finish(automatic);
    assert.equal((await git("rev-parse", "HEAD")).stdout.trim(), local);
    console.log(
      "PASS: automatic mode plans and executes without an approval click.",
    );
  }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify(
      {
        scenario,
        model: agent.model,
        reports,
        head: local,
        tracked,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(`Live checks passed. Report and screenshots: ${directory}`);
}
try {
  if (scenario === "cancellation") await checkCancellation();
  else await checkWorkflows();
} catch (error) {
  await page
    .screenshot({ path: path.join(directory, "failure.png"), fullPage: true })
    .catch(() => {});
  console.error(`Live check failed. Inspect fixture/logs at ${directory}`);
  throw error;
} finally {
  await browser.close();
  await server.close();
  await engine.shutdown();
}
