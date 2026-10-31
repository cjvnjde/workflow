import { expect } from "vitest";
import { test } from "./fixtures.js";
import { matchesText, matchesValue } from "./text.js";
import { type Page } from "playwright";

const composer = (page: Page) => page.getByLabel("What should we work on?", { exact: true });
async function attach(page: Page) {
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "draft-context.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Preserve this context"),
  });
  await expect
    .poll(async () =>
      matchesText(
        await page.getByRole("list", { name: "Attached files", exact: true }).allTextContents(),
        "draft-context.txt",
        true,
      ),
    )
    .toBe(true);
}

test("unsent task text and attachments survive Settings, session navigation and reload until explicitly discarded", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/tasks", {
    headers: { "x-workflow-client": "1" },
    data: { prompt: "Another saved task for draft navigation" },
  });
  const task = await response.json();
  await expect
    .poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).status)
    .toBe("ready");
  await page.goto("/");
  await composer(page).fill("Unsent task with important context");
  await attach(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await expect
    .poll(async () =>
      matchesValue(await composer(page).inputValue(), "Unsent task with important context"),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      matchesText(
        await page.getByRole("list", { name: "Attached files", exact: true }).allTextContents(),
        "draft-context.txt",
        true,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: /^Another saved task for draft navigation/ }).click();
  await expect.poll(() => matchesValue(page.url(), new RegExp(task.id))).toBe(true);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.reload();
  await expect
    .poll(async () =>
      matchesValue(await composer(page).inputValue(), "Unsent task with important context"),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      matchesText(
        await page.getByRole("list", { name: "Attached files", exact: true }).allTextContents(),
        "draft-context.txt",
        true,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Discard task draft", exact: true }).click();
  await page.reload();
  await expect.poll(async () => matchesValue(await composer(page).inputValue(), "")).toBe(true);
  await expect
    .poll(() =>
      page.getByRole("list", { name: "Attached files", exact: true }).getByRole("listitem").count(),
    )
    .toBe(0);
});

test("failed submission preserves a draft and successful submission clears the submitted text and attachments", async ({
  page,
}) => {
  await page.goto("/");
  await composer(page).fill("Submit the preserved task draft");
  await attach(page);
  await page.route("**/api/tasks", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 503, json: { error: "Temporary task creation failure" } })
      : route.continue(),
  );
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect
    .poll(async () =>
      matchesText(
        await page.getByRole("alert").allTextContents(),
        "Temporary task creation failure",
        true,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      matchesValue(await composer(page).inputValue(), "Submit the preserved task draft"),
    )
    .toBe(true);
  await page.unroute("**/api/tasks");
  await page.reload();
  await expect
    .poll(async () =>
      matchesText(
        await page.getByRole("list", { name: "Attached files", exact: true }).allTextContents(),
        "draft-context.txt",
        true,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect
    .poll(async () =>
      matchesText(
        await page.locator(".task-request > p").allTextContents(),
        "Submit the preserved task draft",
        false,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      matchesText(
        await page.locator(".request-attachments").allTextContents(),
        "draft-context.txt",
        true,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.reload();
  await expect.poll(async () => matchesValue(await composer(page).inputValue(), "")).toBe(true);
  await expect
    .poll(() =>
      page.getByRole("list", { name: "Attached files", exact: true }).getByRole("listitem").count(),
    )
    .toBe(0);
});

test("a delayed successful submission cannot erase newer draft edits", async ({ page }) => {
  let pending: import("playwright").Route | undefined;
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() === "POST") pending = route;
    else return route.continue();
  });
  await page.goto("/");
  await composer(page).fill("Earlier task submitted before navigation");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect.poll(() => !!pending).toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await composer(page).fill("Newer draft must survive the earlier response");
  await attach(page);
  const response = page.waitForResponse(
    (response) => response.url().endsWith("/api/tasks") && response.request().method() === "POST",
  );
  await pending!.continue();
  await response;
  await expect
    .poll(() =>
      page.getByRole("button", { name: /^Earlier task submitted before navigation/ }).isVisible(),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      matchesValue(
        await composer(page).inputValue(),
        "Newer draft must survive the earlier response",
      ),
    )
    .toBe(true);
  await page.reload();
  await expect
    .poll(async () =>
      matchesValue(
        await composer(page).inputValue(),
        "Newer draft must survive the earlier response",
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      matchesText(
        await page.getByRole("list", { name: "Attached files", exact: true }).allTextContents(),
        "draft-context.txt",
        true,
      ),
    )
    .toBe(true);
});

async function completedEvidenceRun(page: Page) {
  await page.goto("/");
  await composer(page).fill("Inspect all recorded evidence [long-evidence-fixture]");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await expect
    .poll(
      async () =>
        matchesText(await page.locator(".status-pill").allTextContents(), "Completed", false),
      { timeout: 20000 },
    )
    .toBe(true);
}

test("Results show evidence older than 500 events after completion and browser reload", async ({
  page,
  request,
}) => {
  await completedEvidenceRun(page);
  const taskId = new URL(page.url()).searchParams.get("task");
  const task = await (await request.get(`/api/tasks/${taskId}`)).json();
  const recent = await (await request.get(`/api/runs/${task.runId}/events`)).json();
  expect(recent).toHaveLength(500);
  expect(recent.some((event: { kind: string }) => event.kind === "file_evidence")).toBe(false);
  const evidence = await (await request.get(`/api/runs/${task.runId}/report-evidence`)).json();
  expect(evidence.total).toBeGreaterThan(600);
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await page.getByRole("button", { name: "Results", exact: true }).click();
    const results = page.locator(".results-panel");
    await expect
      .poll(async () => matchesText(await results.allTextContents(), "fixture/early-model", true))
      .toBe(true);
    await expect
      .poll(async () => matchesText(await results.allTextContents(), "early-decision", true))
      .toBe(true);
    await expect
      .poll(async () =>
        matchesText(
          await results.allTextContents(),
          "Early capability warning retained in Results",
          true,
        ),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        matchesText(await results.allTextContents(), "17 protected files verified unchanged", true),
      )
      .toBe(true);
    await results.getByText("prepare · 1 files changed", { exact: true }).click();
    await expect
      .poll(async () => matchesText(await results.allTextContents(), "early-evidence.ts", true))
      .toBe(true);
    await expect
      .poll(async () =>
        matchesText(await results.allTextContents(), "No file-change snapshots recorded", true),
      )
      .not.toBe(true);
    await expect
      .poll(async () =>
        matchesText(await results.allTextContents(), "No detailed model-session records", true),
      )
      .not.toBe(true);
  }
});

test("loading failures never claim evidence is absent and can be retried", async ({ page }) => {
  await completedEvidenceRun(page);
  let pending: import("playwright").Route | undefined;
  await page.route("**/report-evidence", (route) => {
    pending = route;
  });
  await page.getByRole("button", { name: "Results", exact: true }).click();
  await expect.poll(() => !!pending).toBe(true);
  const results = page.locator(".results-panel");
  await expect
    .poll(async () =>
      matchesText(
        await results.getByRole("status").allTextContents(),
        "Loading complete saved evidence…",
        false,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      matchesText(await results.allTextContents(), "No file-change snapshots recorded", true),
    )
    .not.toBe(true);
  await pending!.fulfill({ status: 503, json: { error: "Evidence fixture unavailable" } });
  await expect
    .poll(async () =>
      matchesText(
        await results.getByRole("alert").allTextContents(),
        "Could not load complete execution evidence",
        true,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      matchesText(await results.allTextContents(), "No detailed model-session records", true),
    )
    .not.toBe(true);
  await page.unroute("**/report-evidence");
  await results.getByRole("button", { name: "Retry evidence loading", exact: true }).click();
  await expect
    .poll(async () => matchesText(await results.allTextContents(), "fixture/early-model", true))
    .toBe(true);
  await expect.poll(() => results.getByRole("alert").count()).toBe(0);
});
