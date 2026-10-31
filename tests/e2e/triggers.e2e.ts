import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { test } from "./fixtures.js";
import { matchesText } from "./text.js";

test("configure a disabled trigger, inspect and run its test draft, then enable it", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/programs", {
    headers: { "x-workflow-client": "1" },
    data: {
      title: "GitHub event report",
      task: "Report each GitHub event",
      source: await readFile("examples/github-event-report.ts", "utf8"),
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const run = await response.json();
  await page.goto("/#settings");
  await page.getByRole("button", { name: "Triggers", exact: true }).click();
  await page.getByLabel("Trigger name", { exact: true }).fill("Browser issue trigger");
  await page.getByLabel("GitHub repository", { exact: true }).fill("owner/repository");
  await page.getByLabel("Event", { exact: true }).selectOption("issue.opened");
  await page.getByLabel("Saved workflow", { exact: true }).selectOption(run.id);
  await page.getByRole("button", { name: "Save trigger", exact: true }).click();
  await expect
    .poll(() =>
      page.getByRole("status").filter({ hasText: "Trigger saved and disabled" }).isVisible(),
    )
    .toBe(true);
  await page.getByLabel("Issue or pull request number", { exact: true }).fill("42");
  await page.getByRole("button", { name: "Create test draft", exact: true }).click();
  await expect
    .poll(() => page.getByText("Trigger browser fixture", { exact: true }).isVisible())
    .toBe(true);
  await page.getByRole("link", { name: "Open workflow", exact: true }).click();
  await expect
    .poll(async () =>
      matchesText(await page.locator(".status-pill").allTextContents(), "Awaiting approval", false),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await expect
    .poll(
      async () =>
        matchesText(await page.locator(".status-pill").allTextContents(), "Completed", false),
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Triggers", exact: true }).click();
  await page.getByRole("button", { name: /Browser issue trigger.*Disabled/ }).click();
  await page.getByLabel("Enable automatic execution", { exact: true }).check();
  await page.getByRole("button", { name: "Save trigger", exact: true }).click();
  await expect
    .poll(() => page.getByRole("status").filter({ hasText: "Trigger enabled" }).isVisible())
    .toBe(true);
  await expect
    .poll(() => page.getByRole("button", { name: /Browser issue trigger.*Enabled/ }).isVisible())
    .toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: "/tmp/workflow-triggers-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.screenshot({ path: "/tmp/workflow-triggers-desktop.png", fullPage: true });
});
