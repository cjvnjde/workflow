import { expect, test, type Page } from "@playwright/test";

const composer = (page: Page) => page.getByLabel("What should we work on?", { exact: true });
async function attach(page: Page) {
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "draft-context.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Preserve this context"),
  });
  await expect(page.getByRole("list", { name: "Attached files", exact: true })).toContainText(
    "draft-context.txt",
  );
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
  await expect(composer(page)).toHaveValue("Unsent task with important context");
  await expect(page.getByRole("list", { name: "Attached files", exact: true })).toContainText(
    "draft-context.txt",
  );
  await page.getByRole("button", { name: /^Another saved task for draft navigation/ }).click();
  await expect(page).toHaveURL(new RegExp(task.id));
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.reload();
  await expect(composer(page)).toHaveValue("Unsent task with important context");
  await expect(page.getByRole("list", { name: "Attached files", exact: true })).toContainText(
    "draft-context.txt",
  );
  await page.getByRole("button", { name: "Discard task draft", exact: true }).click();
  await page.reload();
  await expect(composer(page)).toHaveValue("");
  await expect(
    page.getByRole("list", { name: "Attached files", exact: true }).getByRole("listitem"),
  ).toHaveCount(0);
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
  await expect(page.getByRole("alert")).toContainText("Temporary task creation failure");
  await expect(composer(page)).toHaveValue("Submit the preserved task draft");
  await page.unroute("**/api/tasks");
  await page.reload();
  await expect(page.getByRole("list", { name: "Attached files", exact: true })).toContainText(
    "draft-context.txt",
  );
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.locator(".task-request > p")).toHaveText("Submit the preserved task draft");
  await expect(page.locator(".request-attachments")).toContainText("draft-context.txt");
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.reload();
  await expect(composer(page)).toHaveValue("");
  await expect(
    page.getByRole("list", { name: "Attached files", exact: true }).getByRole("listitem"),
  ).toHaveCount(0);
});

test("a delayed successful submission cannot erase newer draft edits", async ({ page }) => {
  let pending: import("@playwright/test").Route | undefined;
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
  await expect(
    page.getByRole("button", { name: /^Earlier task submitted before navigation/ }),
  ).toBeVisible();
  await expect(composer(page)).toHaveValue("Newer draft must survive the earlier response");
  await page.reload();
  await expect(composer(page)).toHaveValue("Newer draft must survive the earlier response");
  await expect(page.getByRole("list", { name: "Attached files", exact: true })).toContainText(
    "draft-context.txt",
  );
});

async function completedEvidenceRun(page: Page) {
  await page.goto("/");
  await composer(page).fill("Inspect all recorded evidence [long-evidence-fixture]");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Completed", { timeout: 20000 });
}

test("Results show evidence older than 500 events after completion and browser reload", async ({
  page,
  request,
}) => {
  await completedEvidenceRun(page);
  const taskId = new URL(page.url()).hash.slice("#task=".length);
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
    await expect(results).toContainText("fixture/early-model");
    await expect(results).toContainText("early-decision");
    await expect(results).toContainText("Early capability warning retained in Results");
    await expect(results).toContainText("17 protected files verified unchanged");
    await results.getByText("prepare · 1 files changed", { exact: true }).click();
    await expect(results).toContainText("early-evidence.ts");
    await expect(results).not.toContainText("No file-change snapshots recorded");
    await expect(results).not.toContainText("No detailed model-session records");
  }
});

test("loading failures never claim evidence is absent and can be retried", async ({ page }) => {
  await completedEvidenceRun(page);
  let pending: import("@playwright/test").Route | undefined;
  await page.route("**/report-evidence", (route) => {
    pending = route;
  });
  await page.getByRole("button", { name: "Results", exact: true }).click();
  await expect.poll(() => !!pending).toBe(true);
  const results = page.locator(".results-panel");
  await expect(results.getByRole("status")).toHaveText("Loading complete saved evidence…");
  await expect(results).not.toContainText("No file-change snapshots recorded");
  await pending!.fulfill({ status: 503, json: { error: "Evidence fixture unavailable" } });
  await expect(results.getByRole("alert")).toContainText(
    "Could not load complete execution evidence",
  );
  await expect(results).not.toContainText("No detailed model-session records");
  await page.unroute("**/report-evidence");
  await results.getByRole("button", { name: "Retry evidence loading", exact: true }).click();
  await expect(results).toContainText("fixture/early-model");
  await expect(results.getByRole("alert")).toHaveCount(0);
});
