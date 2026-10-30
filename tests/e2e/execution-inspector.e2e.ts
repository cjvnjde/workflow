import { test, expect } from "@playwright/test";
import { projectOperations, type RunEvent } from "../../src/contracts/index.js";

const source = `import {workflow,block,step,repeatUntil} from "workflow";
const work=step("work",block({run(ctx){return {round:ctx.input.round};}}),{label:"Inspection fixture",maxVisits:2,inputs:ctx=>({round:ctx.iteration("rounds")})});
export default workflow({name:"Execution inspection fixture",flow:repeatUntil("rounds",{body:work,until:ctx=>ctx.output(work)?.round===2,maxIterations:2})});`;

test("timeline selects historical visits and opens persisted call details", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/programs", {
    headers: { "x-workflow-client": "1" },
    data: {
      title: "Execution inspection fixture",
      task: "Inspect historical operation data",
      source,
      input: {},
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const created = await response.json();
  await page.goto(`/#run=${created.id}`);
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Completed", {
    timeout: 20000,
  });
  const run = await (await request.get(`/api/runs/${created.id}`)).json();
  const events: RunEvent[] = run.attempts.flatMap(
    (attempt: { visit: number; startedAt: string; finishedAt: string }) => [
      {
        id: `parent-start-${attempt.visit}`,
        runId: run.id,
        nodeId: "work",
        time: attempt.startedAt,
        kind: "operation",
        message: "",
        operation: {
          id: `parent-${attempt.visit}`,
          name: "Model session",
          kind: "ai",
          state: "started",
          visit: attempt.visit,
          attempt: 1,
        },
      },
      {
        id: `start-${attempt.visit}`,
        runId: run.id,
        nodeId: "work",
        time: attempt.startedAt,
        kind: "operation",
        message: "",
        operation: {
          id: `command-${attempt.visit}`,
          parentId: `parent-${attempt.visit}`,
          name: "Run verification",
          kind: "exec",
          state: "started",
          visit: attempt.visit,
          attempt: 1,
          input: { command: "bun test" },
        },
      },
      {
        id: `end-${attempt.visit}`,
        runId: run.id,
        nodeId: "work",
        time: attempt.finishedAt,
        kind: "operation",
        message: "",
        operation: {
          id: `command-${attempt.visit}`,
          parentId: `parent-${attempt.visit}`,
          name: "Run verification",
          kind: "exec",
          state: "completed",
          visit: attempt.visit,
          attempt: 1,
          durationMs: 1,
          output: {
            exitCode: attempt.visit === 1 ? 1 : 0,
            output: `Recorded output visit ${attempt.visit}`,
          },
          presentation: {
            card: "command",
            command: "bun test",
            cwd: "/fixture",
            exitCode: attempt.visit === 1 ? 1 : 0,
          },
        },
      },
      {
        id: `parent-end-${attempt.visit}`,
        runId: run.id,
        nodeId: "work",
        time: attempt.finishedAt,
        kind: "operation",
        message: "",
        operation: {
          id: `parent-${attempt.visit}`,
          name: "Model session",
          kind: "ai",
          state: "completed",
          visit: attempt.visit,
          attempt: 1,
        },
      },
    ],
  );
  const operations = projectOperations(events, true);
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
    const operation = operations.find((item) => item.key === key)!;
    return route.fulfill({
      json: {
        events: events.filter((event) => event.operation?.id === operation.id),
        asOf: events.length - 1,
      },
    });
  });
  await page
    .getByRole("navigation", { name: "Workflow views" })
    .getByRole("button", { name: "Timeline", exact: true })
    .click();
  const inspector = page.getByRole("region", {
    name: "Execution inspector",
    exact: true,
  });
  await expect(inspector).toContainText("4 recorded operation attempts");
  await expect
    .poll(() =>
      inspector.locator(".timeline-span").evaluateAll(
        (spans) =>
          spans.length > 0 &&
          spans.every((span) => {
            const bar = span.getBoundingClientRect();
            const lane = span.parentElement!.getBoundingClientRect();
            return bar.top >= lane.top && bar.bottom <= lane.bottom;
          }),
      ),
    )
    .toBe(true);
  await inspector.getByRole("combobox", { name: "Visit", exact: true }).selectOption("1");
  await inspector.getByRole("button", { name: "Fold calls", exact: true }).click();
  await expect(inspector.locator(".call-select")).toHaveCount(1);
  await inspector
    .getByRole("searchbox", { name: "Search calls", exact: true })
    .fill("Run verification");
  await expect(inspector.locator(".call-select")).toHaveCount(1);
  await inspector.locator(".call-select").click();
  await expect(
    inspector.getByRole("complementary", { name: "Selected call details" }),
  ).toContainText("Recorded output visit 1");
  await expect(
    inspector.getByRole("complementary", { name: "Selected call details" }),
  ).toContainText("Exit 1");
  const notification = page.getByRole("button", {
    name: "Dismiss notification",
    exact: true,
  });
  if (await notification.isVisible()) await notification.click();
  await page.screenshot({
    path: "/tmp/workflow-execution-inspector.png",
    fullPage: true,
  });
  await inspector.getByRole("button", { name: "Open exact evidence" }).click();
  const data = page.getByRole("region", {
    name: "Step data inspector",
    exact: true,
  });
  await expect(data.getByRole("combobox", { name: "Visit", exact: true })).toHaveValue("1");
  await expect(data).toContainText("Inspection fixture · visit 1");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Workflow views" })
    .getByRole("button", { name: "Timeline", exact: true })
    .click();
  await expect(inspector).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
  ).toBe(true);
});

test("raw history loads earlier records beyond the live event tail", async ({ page, request }) => {
  const response = await request.post("/api/programs", {
    headers: { "x-workflow-client": "1" },
    data: {
      title: "History paging fixture",
      task: "Inspect earlier events",
      source,
      input: {},
    },
  });
  expect(response.ok()).toBe(true);
  const run = await response.json();
  const history: RunEvent[] = Array.from({ length: 600 }, (_, index) => ({
    id: `history-${index}`,
    runId: run.id,
    nodeId: "work",
    // Append order is authoritative even if clocks move backward or tie.
    time: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor((599 - index) / 2))).toISOString(),
    kind: "agent_message",
    message: index === 1 ? "Early retained diagnostic" : "Historical update " + index,
  }));
  await page.route(`**/api/runs/${run.id}/events`, (route) =>
    route.fulfill({ json: history.slice(-500) }),
  );
  await page.route(`**/api/runs/${run.id}/history*`, (route) => {
    const url = new URL(route.request().url()),
      before = Number(url.searchParams.get("before") ?? 600),
      start = Math.max(0, before - 200);
    return route.fulfill({
      json: {
        events: history
          .slice(start, before)
          .map((event, index) => ({ cursor: start + index, event })),
        asOf: 599,
        total: 600,
        nextBefore: start,
        hasMore: start > 0,
      },
    });
  });
  await page.goto(`/#run=${run.id}`);
  await page
    .getByRole("navigation", { name: "Workflow views" })
    .getByRole("button", { name: "Activity", exact: true })
    .click();
  await expect(
    page.locator(".activity-feed .event").filter({ hasText: "Historical update" }).first(),
  ).toContainText("Historical update 599");
  await page.getByRole("button", { name: "Load earlier events", exact: true }).click();
  await page.getByRole("button", { name: "Load earlier events", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search activity" }).fill("Early retained diagnostic");
  await expect(page.locator(".activity-feed")).toContainText("Early retained diagnostic");
  await expect(page.getByRole("button", { name: "Load earlier events", exact: true })).toHaveCount(
    0,
  );
});
