import { expect, test } from "@playwright/test";

test("React task composer preserves typing position", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByLabel("What should we work on?", { exact: true });
  await composer.pressSequentially("Fix this bug");
  await composer.press("Home");
  await composer.pressSequentially("Please ");
  await expect(composer).toHaveValue("Please Fix this bug");
  await expect(page.getByRole("button", { name: "Start task", exact: true })).toBeEnabled();
});

test("TypeScript imports can select the same file again without an unhandled error", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByText("Use a TypeScript workflow", { exact: true }).click();
  const picker = page.getByLabel("Import TypeScript file", { exact: true });
  const editor = page.getByLabel("New workflow TypeScript", { exact: true });
  for (const value of [1, 2]) {
    await picker.setInputFiles({
      name: "imported.ts",
      mimeType: "text/plain",
      buffer: Buffer.from(`export default ${value};`),
    });
    await expect(editor).toContainText(`export default ${value};`);
    await expect(picker).toHaveValue("");
  }
  expect(errors).toEqual([]);
  const editors = page.getByRole("textbox", { name: /^New workflow / });
  await expect(editors).toHaveCount(2);
  const ids = await editors.evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) {
    expect(
      await page
        .locator("[id]")
        .evaluateAll(
          (elements, expected) => elements.filter((element) => element.id === expected).length,
          id,
        ),
    ).toBe(1);
  }
});

test("composer validation errors stay readable without horizontal overflow on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const name = `${"context".repeat(30)}.txt`;
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.alloc(6_000_001),
  });
  const attachmentError = page.getByRole("alert").filter({ hasText: name });
  await expect(attachmentError).toContainText("exceeds 6 MB");
  expect(
    await attachmentError.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);

  await page.getByText("Use a TypeScript workflow", { exact: true }).click();
  const input = page.getByRole("textbox", { name: "New workflow inputs (JSON)", exact: true });
  await input.press("ControlOrMeta+a");
  await input.press("Backspace");
  await page.keyboard.insertText("not valid JSON");
  await page.getByRole("button", { name: "Create workflow draft", exact: true }).click();
  const inputError = page.getByRole("alert").filter({ hasText: "JSON" });
  await expect(inputError).toBeVisible();
  expect(await inputError.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
