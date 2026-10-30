import { expect, test } from "@playwright/test";

test("a terminal-created session opens by ID, shares links, and survives browser reload", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/tasks", {
    headers: { "x-workflow-client": "1" },
    data: { prompt: "Review shared session navigation", attachments: [] },
  });
  expect(response.ok()).toBe(true);
  const task = await response.json();
  await page.goto("/");
  await page.getByRole("button", { name: "Open session by ID", exact: true }).click();
  await page.getByLabel("Session ID or Workflow link", { exact: true }).fill(task.id);
  await page.getByRole("button", { name: "Open session", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#task=${task.id}$`));
  await expect(page.getByLabel("Shared session", { exact: true })).toContainText(task.id);
  await expect(page.locator(".task-request > p")).toHaveText(task.prompt);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(`#task=${task.id}`);
  await page.getByRole("button", { name: "Continue in terminal", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`workflow attach ${task.id} --server http://127.0.0.1:4311`);
  await page.reload();
  await expect(page.locator(".task-request > p")).toHaveText(task.prompt);
  await page.goto(`/?session=${task.id}`);
  await expect(page).toHaveURL(new RegExp(`#task=${task.id}$`));
  await expect(page.getByLabel("Shared session", { exact: true })).toContainText(task.id);
});

test("invalid and missing session IDs stay in the dialog without replacing the workspace", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open session by ID", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Continue in this workspace" });
  await dialog.getByLabel("Session ID or Workflow link").fill("not-an-id");
  await dialog.getByRole("button", { name: "Open session", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("full task or run ID");
  await dialog
    .getByLabel("Session ID or Workflow link")
    .fill("task:00000000-0000-4000-8000-000000000000");
  await dialog.getByRole("button", { name: "Open session", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Session not found in this project");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("What should we work on?", { exact: true })).toBeVisible();
});

test("dismissing a delayed session lookup cancels navigation and preserves a newer task draft", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/tasks", {
    headers: { "x-workflow-client": "1" },
    data: { prompt: "Session lookup cancellation fixture", attachments: [] },
  });
  expect(response.ok()).toBe(true);
  const task = await response.json();
  const tasks = await (await request.get("/api/tasks")).json();
  const runs = await (await request.get("/api/runs")).json();
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /Session lookup cancellation fixture/ }).first(),
  ).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Continue in this workspace" });
  const composer = page.getByLabel("What should we work on?", { exact: true });
  let delayed: import("@playwright/test").Route[] | undefined;
  await page.route(/\/api\/(tasks|runs)$/, async (route) => {
    if (delayed) delayed.push(route);
    else await route.continue();
  });

  for (const dismissal of ["Cancel", "Close session dialog", "Escape"]) {
    await page.getByRole("button", { name: "Open session by ID", exact: true }).click();
    await dialog.getByLabel("Session ID or Workflow link").fill(task.id);
    delayed = [];
    await dialog.getByRole("button", { name: "Open session", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Opening…", exact: true })).toBeDisabled();
    await expect.poll(() => delayed!.length).toBeGreaterThanOrEqual(2);
    const pending = delayed;
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (req) => pending.some((route) => route.request() === req),
    });
    if (dismissal === "Escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: dismissal, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await aborted;
    delayed = undefined;
    const draft = `Keep this unsent request after ${dismissal}.`;
    await composer.fill(draft);
    // Even a late server response must not select the cancelled session.
    await Promise.all(
      pending.map((route) =>
        route
          .fulfill({
            json: route.request().url().endsWith("/tasks") ? tasks : runs,
          })
          .catch(() => {
            /* Chromium may already have discarded the aborted request. */
          }),
      ),
    );
    await expect(page).toHaveURL(/\/$/);
    await expect(composer).toHaveValue(draft);
    await expect(page.getByLabel("Shared session", { exact: true })).toHaveCount(0);
  }
});
