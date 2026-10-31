import { expect, test } from "@playwright/test";

test("React composers have isolated control styles and preserve typing position", async ({
  page,
}) => {
  await page.goto("/");
  const attach = page.getByRole("button", { name: "Attach files", exact: true });
  const styles = await attach.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, height: style.height, border: style.borderStyle };
  });
  expect(styles).toEqual({ background: "rgba(0, 0, 0, 0)", height: "32px", border: "solid" });
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
  // Embedded Vue editors retain their own controls and theme inside React.
  await expect(
    page.getByRole("button", { name: "Format New workflow TypeScript", exact: true }),
  ).toBeVisible();
  expect(
    await editor.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--ctp-text").trim(),
    ),
  ).toBe("#cdd6f4");
});
