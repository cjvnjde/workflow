import { expect, test } from "@playwright/test";

test("a task honors the review policy shown before another client enables automatic execution", async ({
  page,
  request,
  context,
}) => {
  const headers = { "x-workflow-client": "1" };
  const original = await (await request.get("/api/settings/orchestration")).json();
  const latest = await (await request.get("/api/settings/orchestration")).json();
  await request.put("/api/settings/orchestration", {
    headers,
    data: { ...latest, settings: { ...latest.settings, approval: "review" } },
  });
  const settingsPage = await context.newPage();
  try {
    await page.goto("/");
    await expect(
      page.getByText("You review the workflow before it runs", { exact: true }),
    ).toBeVisible();
    await settingsPage.goto("/?view=settings&section=execution");
    await settingsPage.getByLabel("Workflow approval", { exact: true }).selectOption("automatic");
    await settingsPage.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(settingsPage.getByText("All changes saved", { exact: true })).toBeVisible();
    await expect(
      page.getByText("You review the workflow before it runs", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("What should we work on?", { exact: true })
      .fill("Review policy must remain an explicit task decision");
    await page.getByRole("button", { name: "Start task", exact: true }).click();
    await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
    await expect(page.getByRole("button", { name: "Approve & start", exact: true })).toBeVisible();
    const id = new URL(page.url()).searchParams.get("task");
    expect((await (await request.get(`/api/tasks/${id}`)).json()).approval).toBe("review");
  } finally {
    const current = await (await request.get("/api/settings/orchestration")).json();
    await request.put("/api/settings/orchestration", {
      headers,
      data: { ...current, settings: { ...current.settings, approval: original.settings.approval } },
    });
    await settingsPage.close();
  }
});

test("TypeScript composer restores source, JSON and name across navigation and reload, then clears submitted work", async ({
  page,
}) => {
  const source =
    'import { workflow } from "workflow";\nexport default workflow({name:"Preserved review",async run(){return "saved draft evidence";}});';
  await page.goto("/");
  await page.getByText("Use a TypeScript workflow", { exact: true }).click();
  await page.getByLabel("Workflow name", { exact: true }).fill("Preserved TypeScript review");
  await page.getByLabel("Import TypeScript file", { exact: true }).setInputFiles({
    name: "preserved-review.ts",
    mimeType: "text/plain",
    buffer: Buffer.from(source),
  });
  const inputs = page.getByLabel("New workflow inputs (JSON)", { exact: true });
  await inputs.press("ControlOrMeta+a");
  await inputs.press("Backspace");
  await page.keyboard.insertText('{"request":"Preserved JSON request","limit":2}');
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.reload();
  await page.getByText("Use a TypeScript workflow", { exact: true }).click();
  await expect(page.getByLabel("Workflow name", { exact: true })).toHaveValue(
    "Preserved TypeScript review",
  );
  await expect(page.getByLabel("New workflow TypeScript", { exact: true })).toContainText(
    "saved draft evidence",
  );
  await expect(inputs).toContainText("Preserved JSON request");
  await page.getByRole("button", { name: "Create workflow draft", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByText("Use a TypeScript workflow", { exact: true }).click();
  await expect(page.getByLabel("Workflow name", { exact: true })).not.toHaveValue(
    "Preserved TypeScript review",
  );
  await expect(page.getByLabel("New workflow TypeScript", { exact: true })).not.toContainText(
    "saved draft evidence",
  );
});
