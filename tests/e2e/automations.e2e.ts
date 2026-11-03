import { expect, test } from "@playwright/test";
import { automationStateSchema } from "../../src/contracts/automation-schema.js";

const headers = { "x-workflow-client": "1" };
const source = `import { workflow, block, step, z } from "workflow";
const report = block({
  input: z.object({ message: z.string() }),
  run(ctx) { ctx.summary(ctx.input.message); return { message: ctx.input.message, verified: true }; }
});
export default workflow({ name: "Offline automation browser fixture", input: z.object({ message: z.string() }), flow: step("report", report, { inputs: ctx => ctx.input }) });`;

test("generic automation lifecycle persists jobs and preserves edits across refresh and conflicts", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/programs", {
    headers,
    data: {
      title: "Offline automation browser fixture",
      task: "Report a local fixture without model or network calls",
      source,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const workflow = await created.json();
  const name = `Browser automation ${workflow.id}`;
  await page.goto("/#settings");
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await page.getByLabel("Automation name", { exact: true }).fill(name);
  await page.getByLabel("Target kind", { exact: true }).selectOption("workflow");
  await page.getByLabel("Saved workflow", { exact: true }).selectOption(workflow.id);
  // The real browser server's temporary fixture deliberately has no Git repository.
  await page.getByLabel("Workspace", { exact: true }).selectOption("project");
  await page
    .getByLabel("Input JSON", { exact: true })
    .fill('{"message":"Browser durable automation result"}');
  await page.getByRole("button", { name: "Save automation", exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(`${name}.*disabled`) })).toBeVisible();
  const state = automationStateSchema.parse(await (await request.get("/api/automations")).json());
  const saved = state.automations.find((item) => item.config.name === name)!;
  expect(saved.config.execution.workspace).toBe("project");
  expect(saved.config.enabled).toBe(false);

  await page.getByLabel("Automation name", { exact: true }).fill(`${name} local edit`);
  await page.getByRole("button", { name: "Refresh automations", exact: true }).click();
  await expect(page.getByLabel("Automation name", { exact: true })).toHaveValue(
    `${name} local edit`,
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Execution", exact: true }).click();
  await expect(page.getByLabel("Automation name", { exact: true })).toHaveValue(
    `${name} local edit`,
  );

  const concurrent = await request.post("/api/automations", {
    headers,
    data: {
      id: saved.id,
      revision: saved.revision,
      config: { ...saved.config, description: "Concurrent API edit" },
    },
  });
  expect(concurrent.ok(), await concurrent.text()).toBeTruthy();
  await page.getByRole("button", { name: "Refresh automations", exact: true }).click();
  await page.getByRole("button", { name: "Save automation", exact: true }).click();
  await expect(page.locator(".automation-settings [role=alert]").first()).toBeVisible();
  await expect(page.getByLabel("Automation name", { exact: true })).toHaveValue(
    `${name} local edit`,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload saved automation", exact: true }).click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Concurrent API edit");

  await page.getByLabel("Routes and filters JSON", { exact: true }).fill('[{"id":"invalid"}]');
  await expect(page.locator(".automation-settings [role=alert]").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Save automation", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Discard automation changes", exact: true }).click();
  await page.getByRole("button", { name: "Test automation", exact: true }).click();
  await expect
    .poll(
      async () => {
        const current = automationStateSchema.parse(
          await (await request.get("/api/automations")).json(),
        );
        return current.jobs.find((item) => item.automationId === saved.id && item.test)?.runStatus;
      },
      { timeout: 30_000 },
    )
    .toBe("draft");
  await page.getByRole("button", { name: "Refresh automations", exact: true }).click();
  const card = page
    .locator(".automation-job")
    .filter({ has: page.getByRole("link", { name: "Open workflow", exact: true }) })
    .first();
  await expect(card.getByRole("button", { name: "Approve job", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Retry job", exact: true })).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Approve job", exact: true }).click();
  await card.getByRole("link", { name: "Open workflow", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Completed", { timeout: 30_000 });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`${name}.*disabled`) }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Enable automation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause automation", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pause automation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume automation", exact: true })).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Resume automation", exact: true }).click();
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  await expect
    .poll(
      async () => {
        const current = automationStateSchema.parse(
          await (await request.get("/api/automations")).json(),
        );
        return current.jobs.find((item) => item.automationId === saved.id && !item.test)?.status;
      },
      { timeout: 30_000 },
    )
    .toBe("completed");
  await page.getByRole("button", { name: "Disable automation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable automation", exact: true })).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`${name}.*disabled`) }).click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Concurrent API edit");
  await expect(
    page.getByRole("heading", { name: "Cases, events and audit", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});
