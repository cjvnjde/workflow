import { expect, test } from "@playwright/test";
import {
  usageReportSchema,
  type UsageReport,
  type UsageTotals,
} from "../../src/contracts.js";

const zero: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  requests: 0,
  unpricedRequests: 0,
};
const scopeId = "f5cb3974-c9db-4593-ab4d-e45c31551160";
function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return usageReportSchema.parse({
    scope: { kind: "project" },
    total: zero,
    phases: [],
    models: [],
    sessions: [],
    sessionCount: 0,
    sessionsTruncated: false,
    legacyExecution: zero,
    limits: { remainingCostUsd: null },
    incomplete: false,
    warnings: [],
    ...overrides,
  });
}

test("task totals include planning and execution once, with model and failed-session detail", async ({
  page,
  request,
}) => {
  const planning = {
    ...zero,
    inputTokens: 120,
    outputTokens: 30,
    costUsd: 0.025,
    requests: 1,
  };
  const execution = {
    ...zero,
    inputTokens: 400,
    outputTokens: 60,
    costUsd: 0.1,
    requests: 2,
  };
  const executionSession = {
    ...execution,
    inputTokens: 300,
    costUsd: 0.08,
    requests: 1,
  };
  const value = report({
    scope: { kind: "task", id: scopeId },
    total: {
      ...zero,
      inputTokens: 520,
      outputTokens: 90,
      costUsd: 0.125,
      requests: 3,
    },
    phases: [
      { phase: "planning", usage: planning, sessionCount: 1 },
      { phase: "execution", usage: execution, sessionCount: 1 },
    ],
    models: [
      {
        provider: "fixture",
        model: "careful-planner",
        usage: planning,
        sessionCount: 1,
      },
      {
        provider: "fixture",
        model: "small-coder",
        usage: executionSession,
        sessionCount: 1,
      },
    ],
    sessionCount: 2,
    sessionsTruncated: true,
    legacyExecution: { ...zero, inputTokens: 100, costUsd: 0.02, requests: 1 },
    limits: { totalCostUsd: 1, executionCostUsd: 0.5, remainingCostUsd: 0.875 },
    sessions: [
      {
        id: "9793963f-444a-4da9-8d19-163e1dfd4bc3",
        scopeId,
        operationId: "fixture/execution",
        phase: "execution",
        nodeId: "implementation",
        visit: 2,
        provider: "fixture",
        model: "small-coder",
        thinking: "low",
        usage: executionSession,
        pricing: {
          source: "catalog",
          rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
        status: "failed",
        startedAt: "2026-10-30T09:00:00.000Z",
        updatedAt: "2026-10-30T09:00:10.000Z",
        endedAt: "2026-10-30T09:00:10.000Z",
        error: "The check failed after model work completed.",
      },
    ],
  });
  await page.route(/\/api\/(tasks|runs)\/[^/]+\/usage$/, (route) =>
    route.fulfill({ json: value }),
  );
  const created = await request.post("/api/tasks", {
    headers: { "x-workflow-client": "1" },
    data: { prompt: "Review usage display fixture", attachments: [] },
  });
  expect(created.ok()).toBe(true);
  const task = await created.json();
  await page.goto(`/#task=${task.id}`);
  const usage = page.getByRole("region", { name: "Task cost", exact: true });
  await expect(usage.locator(".usage-total")).toHaveText("$0.1250");
  await expect(usage.getByLabel("Cost by phase")).toContainText(
    "Planning$0.0250",
  );
  await expect(usage.getByLabel("Cost by phase")).toContainText(
    "Execution$0.1000",
  );
  await expect(usage).toContainText("Remaining $0.8750");
  await usage.getByText(/Usage details ·/).click();
  await expect(
    usage.getByRole("table", { name: "Cost by model" }),
  ).toContainText("careful-planner");
  await expect(usage).toContainText(
    "$0.0200 is already included in this total",
  );
  await usage
    .getByText("Model sessions · latest 1 of 2", { exact: true })
    .click();
  await expect(usage).toContainText("Totals include all retained sessions");
  await expect(usage.locator(".usage-session")).toContainText(
    "Execution · failed · implementation · visit 2",
  );
  await expect(usage.locator(".usage-session")).toContainText("$0.0800");
  await expect(usage).toContainText(
    "The check failed after model work completed.",
  );
  await usage.screenshot({ path: "/tmp/workflow-feature2-usage.png" });
});

test("project setup and design usage keep missing prices visible on narrow screens", async ({
  page,
}) => {
  const unknown = {
    ...zero,
    inputTokens: 200,
    requests: 2,
    unpricedRequests: 2,
  };
  const value = report({
    total: unknown,
    incomplete: true,
    phases: [
      { phase: "setup", usage: unknown, sessionCount: 1 },
      { phase: "design", usage: zero, sessionCount: 0 },
    ],
    warnings: ["Older planning activity was not recorded."],
  });
  await page.route("**/api/usage", (route) => route.fulfill({ json: value }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#settings");
  const usage = page.getByRole("region", {
    name: "Project AI usage",
    exact: true,
  });
  await expect(usage.locator(".usage-total")).toHaveText("Unknown");
  await expect(usage.getByLabel("Cost by phase")).toContainText(
    "Project setupUnknown",
  );
  await expect(usage.getByLabel("Cost by phase")).toContainText(
    "Settings design",
  );
  await expect(usage).toContainText(
    "Missing usage or pricing is not counted as free",
  );
  await usage.getByText(/Usage details ·/).click();
  await expect(usage).toContainText("2 model requests have no recorded price");
  await expect(usage).toContainText("Older planning activity was not recorded");
  expect(
    await usage.evaluate(
      (element) => element.getBoundingClientRect().right <= innerWidth,
    ),
  ).toBe(true);
  await usage.screenshot({ path: "/tmp/workflow-feature2-usage-mobile.png" });
});

test("usage load failures keep the last total and offer refresh", async ({
  page,
}) => {
  let fail = false;
  await page.route("**/api/usage", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: { error: "Usage store temporarily unavailable" },
        })
      : route.fulfill({
          json: report({ total: { ...zero, costUsd: 0.5, requests: 1 } }),
        }),
  );
  await page.goto("/#settings");
  const usage = page.getByRole("region", {
    name: "Project AI usage",
    exact: true,
  });
  await expect(usage.locator(".usage-total")).toHaveText("$0.5000");
  fail = true;
  await usage
    .getByRole("button", { name: "Refresh project ai usage", exact: true })
    .click();
  await expect(usage).toContainText("Showing the last loaded usage");
  await expect(usage.locator(".usage-total")).toHaveText("$0.5000");
  fail = false;
  await usage
    .getByRole("button", { name: "Refresh project ai usage", exact: true })
    .click();
  await expect(usage.getByRole("status")).toHaveCount(0);
});

test("task, setup and execution spending defaults save independently and can be cleared", async ({
  page,
  request,
}) => {
  const original = await (await request.get("/api/settings/execution")).json();
  try {
    await page.goto("/#settings");
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Execution", exact: true })
      .click();
    await page
      .getByLabel("Total task spending limit (USD)", { exact: true })
      .fill("1.25");
    await page
      .getByLabel("Project setup spending limit (USD)", { exact: true })
      .fill("2.5");
    await page
      .getByLabel("Execution spending limit (USD)", { exact: true })
      .fill("0.75");
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(
      page.getByText("Execution settings saved.", { exact: true }),
    ).toBeVisible();
    expect(
      (await (await request.get("/api/settings/execution")).json()).budget,
    ).toMatchObject({
      maxTaskCostUsd: 1.25,
      maxSetupCostUsd: 2.5,
      maxCostUsd: 0.75,
    });
    await page
      .getByLabel("Total task spending limit (USD)", { exact: true })
      .fill("");
    const cleared = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/settings/execution") &&
        response.request().method() === "PUT",
    );
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    expect((await cleared).ok()).toBe(true);
    await expect(
      page.getByRole("button", { name: "Save settings", exact: true }),
    ).toBeDisabled();
    const budget = (await (await request.get("/api/settings/execution")).json())
      .budget;
    expect(budget.maxTaskCostUsd).toBeUndefined();
    expect(budget.maxSetupCostUsd).toBe(2.5);
    expect(budget.maxCostUsd).toBe(0.75);
  } finally {
    const latest = await (await request.get("/api/settings/execution")).json();
    const restored = await request.put("/api/settings/execution", {
      headers: { "x-workflow-client": "1" },
      data: { ...original, configRevision: latest.configRevision },
    });
    expect(restored.ok(), await restored.text()).toBe(true);
  }
});
