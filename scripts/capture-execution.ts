import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import {
  projectOperations,
  type OperationRecord,
  type RunEvent,
  type WorkflowRun,
} from "../src/contracts.js";

// Reproducible README captures of the actual built UI. Timings and tool payloads
// are deterministic demonstration records, not live model measurements.
// Run after `bun run build`:
// WORKFLOW_CHROMIUM_PATH=/usr/bin/chromium bun scripts/capture-execution.ts
const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "http://127.0.0.1:4311";
if (
  await fetch(origin).then(
    () => true,
    () => false,
  )
) {
  throw new Error(
    "Port 4311 is already in use; stop the browser fixture server first.",
  );
}
const server = Bun.spawn([process.execPath, "tests/e2e/server.ts"], {
  cwd: root,
  stdout: "ignore",
  stderr: "ignore",
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const deadline = Date.now() + 60_000;
  while (
    !(await fetch(`${origin}/api/project`).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    if (server.exitCode !== null)
      throw new Error(`Fixture server exited with ${server.exitCode}`);
    if (Date.now() > deadline)
      throw new Error("Fixture server did not become ready");
    await Bun.sleep(200);
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WORKFLOW_CHROMIUM_PATH
      ? { executablePath: process.env.WORKFLOW_CHROMIUM_PATH }
      : {}),
  });
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1400, height: 1500 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const source = `import {workflow,block,step,repeatUntil,sequence} from "workflow";
const implement=step("implement",block({run(ctx){return {round:ctx.input.round};}}),{label:"Implement checkout fix",maxVisits:2,inputs:ctx=>({round:ctx.iteration("revision")})});
const verify=step("verify",block({run(){return {status:"Demonstration complete"};}}),{label:"Verify acceptance"});
export default workflow({name:"Demo · checkout total regression",flow:sequence(repeatUntil("revision",{body:implement,until:ctx=>ctx.output(implement)?.round===2,maxIterations:2}),verify)});`;
  const created = await context.request.post("/api/programs", {
    headers: { "x-workflow-client": "1" },
    data: {
      title: "Demo · checkout total regression",
      task: "Demonstration of recorded execution history",
      source,
      input: {},
    },
  });
  if (!created.ok()) throw new Error(await created.text());
  const draft = (await created.json()) as WorkflowRun;
  await page.goto(`/#run=${draft.id}`);
  await page
    .getByRole("button", { name: "Approve & start", exact: true })
    .click();
  await expect(page.locator(".status-pill")).toHaveText("Completed", {
    timeout: 30_000,
  });
  const run = (await (
    await context.request.get(`/api/runs/${draft.id}`)
  ).json()) as WorkflowRun;
  const base = Date.UTC(2026, 9, 30, 10, 0, 0);
  const time = (milliseconds: number) =>
    new Date(base + milliseconds).toISOString();
  run.attempts = run.attempts.map((attempt) => ({
    ...attempt,
    startedAt: time(
      attempt.nodeId === "verify" ? 26_000 : attempt.visit === 1 ? 0 : 13_000,
    ),
    finishedAt: time(
      attempt.nodeId === "verify"
        ? 33_000
        : attempt.visit === 1
          ? 12_000
          : 25_000,
    ),
  }));
  const events: RunEvent[] = [];
  function span(
    nodeId: string,
    visit: number,
    id: string,
    name: string,
    kind: OperationRecord["kind"],
    start: number,
    end: number,
    fields: Partial<OperationRecord> = {},
  ) {
    const identity = { id, name, kind, visit, attempt: 1, ...fields };
    events.push({
      id: `${id}:start`,
      runId: run.id,
      nodeId,
      time: time(start),
      kind: "operation",
      message: "",
      operation: { ...identity, state: "started" },
    });
    events.push({
      id: `${id}:end`,
      runId: run.id,
      nodeId,
      time: time(end),
      kind: "operation",
      message: "",
      operation: { ...identity, state: "completed", durationMs: end - start },
    });
  }
  const before = `function total(items: Item[]) {\n  let amount = 0;\n  for (const item of items) {\n    amount += item.price * item.qty;\n  }\n  return amount;\n}`;
  const after = `function total(items: Item[]) {\n  let cents = 0;\n  for (const item of items) {\n    const price = Math.round(\n      item.price * 100\n    );\n    cents += price * item.qty;\n  }\n  return cents / 100;\n}`;
  for (const visit of [1, 2]) {
    const offset = visit === 1 ? 0 : 13_000;
    const parentId = `implement-${visit}`;
    span(
      "implement",
      visit,
      parentId,
      "Implement checkout fix",
      "ai",
      offset,
      offset + 12_000,
    );
    span(
      "implement",
      visit,
      `${parentId}/request`,
      "Model request",
      "request",
      offset + 100,
      offset + 2800,
      {
        parentId,
        details: {
          firstTokenMs: 420,
          generationMs: 2280,
          outputTokens: 184,
          timingSource: "client",
        },
        output:
          "Use integer cents while accumulating line items, then convert the result once.",
      },
    );
    if (visit === 2) {
      span(
        "implement",
        visit,
        `${parentId}/read`,
        "Read checkout.ts",
        "tool",
        offset + 3000,
        offset + 3450,
        {
          parentId,
          input: { path: "src/checkout.ts" },
          output: before,
          presentation: {
            card: "file-read",
            path: "src/checkout.ts",
            output: before,
          },
        },
      );
      span(
        "implement",
        visit,
        `${parentId}/edit`,
        "Update currency calculation",
        "tool",
        offset + 4100,
        offset + 4800,
        {
          parentId,
          input: { path: "src/checkout.ts" },
          output: "Updated src/checkout.ts",
          presentation: {
            card: "file-diff",
            path: "src/checkout.ts",
            before,
            after,
          },
        },
      );
    }
    span(
      "implement",
      visit,
      `${parentId}/test`,
      "Run checkout tests",
      "exec",
      offset + 5500,
      offset + 10_800,
      {
        parentId,
        input: { command: "bun test tests/checkout.test.ts" },
        output: {
          exitCode: visit === 1 ? 1 : 0,
          output:
            visit === 1
              ? "1 failed · 11 passed\nCheckout total must preserve exact cents."
              : "12 passed · 0 failed\nCheckout totals preserve exact cents.",
        },
        presentation: {
          card: "command",
          command: "bun test tests/checkout.test.ts",
          cwd: "project",
          exitCode: visit === 1 ? 1 : 0,
        },
      },
    );
  }
  span(
    "verify",
    1,
    "verify/test",
    "Run full test suite",
    "exec",
    26_500,
    31_500,
    {
      input: { command: "bun test" },
      output: {
        exitCode: 0,
        output: "48 passed · 0 failed\nAcceptance checks completed.",
      },
      presentation: {
        card: "command",
        command: "bun test",
        cwd: "project",
        exitCode: 0,
      },
    },
  );
  events.sort((a, b) => a.time.localeCompare(b.time));
  const operations = projectOperations(events, true);
  const details = projectOperations(events);
  await page.route(`**/api/runs/${run.id}`, (route) =>
    route.fulfill({ json: run }),
  );
  await page.route(`**/api/runs/${run.id}/execution`, (route) =>
    route.fulfill({
      json: {
        version: 1,
        asOf: events.length - 1,
        total: events.length,
        operations,
      },
    }),
  );
  await page.route(`**/api/runs/${run.id}/operation-events?*`, (route) => {
    const key = new URL(route.request().url()).searchParams.get("key");
    const operation = details.find((item) => item.key === key);
    return route.fulfill({
      json: {
        events: events.filter((event) => event.operation?.id === operation?.id),
        operation,
        asOf: events.length - 1,
      },
    });
  });
  await page.reload();
  await page
    .getByRole("navigation", { name: "Workflow views" })
    .getByRole("button", { name: "Timeline", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Expand workspace", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Expanded workflow workspace",
    exact: true,
  });
  const inspector = dialog.getByRole("region", {
    name: "Execution inspector",
    exact: true,
  });
  await expect(inspector).toContainText(
    `${operations.length} recorded operation attempts`,
  );
  for (const notification of await page
    .getByRole("button", { name: "Dismiss notification", exact: true })
    .all())
    await notification.click();
  await page.evaluate(() => document.fonts.ready);
  await mkdir(path.join(root, "docs/screenshots"), { recursive: true });
  async function capture(name: string, lastSelector: string) {
    const bounds = await dialog.boundingBox();
    const last = await dialog.locator(lastSelector).boundingBox();
    if (!bounds || !last) throw new Error("Capture content has no bounds");
    await page.screenshot({
      path: path.join(root, "docs/screenshots", name),
      clip: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: Math.ceil(last.y + last.height - bounds.y + 12),
      },
    });
  }
  await capture("execution-timeline.png", ".execution-timeline");
  await dialog
    .getByRole("navigation", { name: "Workflow views" })
    .getByRole("button", { name: "Activity", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Grouped calls", exact: true })
    .click();
  await inspector
    .getByRole("combobox", { name: "Step", exact: true })
    .selectOption("implement");
  await inspector
    .getByRole("combobox", { name: "Visit", exact: true })
    .selectOption("2");
  await inspector
    .locator(".call-select")
    .filter({ hasText: "Update currency calculation" })
    .click();
  await expect(inspector.locator(".recorded-diff")).toContainText("Math.round");
  await capture("tool-calls.png", ".inspection-layout");
  if (pageErrors.length) throw new Error(pageErrors.join("\n"));
  console.log(
    "Captured docs/screenshots/execution-timeline.png and docs/screenshots/tool-calls.png (deterministic demo records).",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await server.exited;
}
