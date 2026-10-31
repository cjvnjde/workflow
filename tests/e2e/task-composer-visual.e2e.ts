import { expect, test, type Page } from "@playwright/test";

const prompt =
  "Review the checkout total regression and add focused coverage before changing the implementation.";
const attachmentName = "checkout-acceptance-criteria.txt";
const submissionError = "Task creation is temporarily unavailable. Your draft has been kept.";

async function openDraft(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  // Keep screenshots independent of settings changed by other browser journeys.
  await page.route("**/api/settings/orchestration", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    await route.fulfill({
      response,
      json: { ...state, settings: { ...state.settings, approval: "review" } },
    });
  });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "What should we work on?", exact: true });
  const form = page.locator("form").filter({ has: composer });
  await composer.fill(prompt);
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: attachmentName,
    mimeType: "text/plain",
    buffer: Buffer.alloc(2400, "a"),
  });
  await expect(
    form.getByRole("button", { name: `Remove ${attachmentName}`, exact: true }),
  ).toBeVisible();
  await expect(form.getByRole("button", { name: "Start task", exact: true })).toBeEnabled();
  await expect(form).toContainText("You review the workflow before it runs");
  await page.evaluate(() => document.fonts.ready);
  return { composer, form };
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "narrow", width: 390, height: 844 },
]) {
  test(
    `task composer draft and empty suggestions at ${viewport.name} width`,
    { tag: "@visual" },
    async ({ page }) => {
      const { composer, form } = await openDraft(page, viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      await expect(form).toHaveScreenshot(`task-composer-draft-${viewport.name}.png`);

      await form.getByRole("button", { name: "Discard task draft", exact: true }).click();
      await expect(composer).toHaveValue("");
      await expect(form.getByRole("button", { name: "Start task", exact: true })).toBeDisabled();
      const suggestion = form.getByRole("button", {
        name: "Find and fix a bug in this project",
        exact: true,
      });
      await expect(suggestion).toBeVisible();
      await expect(form).toHaveScreenshot(`task-composer-empty-${viewport.name}.png`);

      await suggestion.click();
      await expect(composer).toHaveValue("Find and fix a bug in this project");
      await expect(composer).toBeFocused();
    },
  );
}

test(
  "failed task submission preserves a readable narrow draft",
  { tag: "@visual" },
  async ({ page }) => {
    const { composer, form } = await openDraft(page, { width: 390, height: 844 });
    await page.route("**/api/tasks", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 503, json: { error: submissionError } });
      } else {
        await route.continue();
      }
    });
    await form.getByRole("button", { name: "Start task", exact: true }).click();
    await expect(form.getByRole("alert")).toHaveText(submissionError);
    await expect(composer).toHaveValue(prompt);
    await expect(
      form.getByRole("button", { name: `Remove ${attachmentName}`, exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await expect(form).toHaveScreenshot("task-composer-submission-error-narrow.png");
  },
);
