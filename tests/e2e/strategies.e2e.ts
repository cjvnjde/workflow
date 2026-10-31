import { expect } from "vitest";
import { test } from "./fixtures.js";
import { matchesText, matchesValue } from "./text.js";
import { type APIRequestContext, type Page } from "playwright";
import { strategyPreviewSchema } from "../../src/contracts/memory-schema.js";

const source = `import { workflow, block, step, sequence } from "workflow";
const inspect = step("inspect", block({ run(){ return {summary:"ARTIFACT_CONTENT_SENTINEL", private:"SOURCE_CODE_SENTINEL"}; } }), {label:"Inspect the current state"});
const verify = step("verify", block({ run(ctx){ ctx.summary("Checks complete"); return {verified:true}; } }), {label:"Verify focused checks",inputs:ctx=>({inspection:ctx.output(inspect)})});
export default workflow({name:"Focused inspection and verification",flow:sequence(inspect,verify)});`;
const headers = { "x-workflow-client": "1" };
async function completed(page: Page, request: APIRequestContext) {
  const response = await request.post("/api/programs", {
    headers,
    data: {
      title: "Focused inspection and verification",
      task: "Check the project with a small deterministic workflow",
      source,
      input: {},
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const run = await response.json();
  await page.goto(`/#run=${run.id}`);
  await expect
    .poll(() => page.getByRole("button", { name: "Remember this approach", exact: true }).count())
    .toBe(0);
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await expect
    .poll(
      async () =>
        matchesText(await page.locator(".status-pill").allTextContents(), "Completed", false),
      {
        timeout: 20000,
      },
    )
    .toBe(true);
  return run;
}
function dialog(page: Page) {
  return page.getByRole("dialog", {
    name: "Remember this approach",
    exact: true,
  });
}
async function open(page: Page) {
  await page
    .getByRole("button", {
      name: /^(Remember this approach|Approach remembered)$/,
    })
    .click();
  await expect
    .poll(() => dialog(page).getByLabel("Strategy title", { exact: true }).isVisible())
    .toBe(true);
  return dialog(page);
}

test("remembering requires explicit save, keeps memory off, and reopens the existing strategy", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const run = await completed(page, request);
  const before = await (await request.get("/api/memory")).json();
  expect(before.enabled).toBe(false);
  const previewResponse = await request.get(`/api/runs/${run.id}/strategy-preview`);
  expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
  const preview = strategyPreviewSchema.parse(await previewResponse.json());
  expect(JSON.stringify(preview)).not.toContain("SOURCE_CODE_SENTINEL");
  expect(JSON.stringify(preview)).not.toContain("ARTIFACT_CONTENT_SENTINEL");
  expect(preview.metadata.roles.map((role) => role.nodeId)).toEqual(["inspect", "verify"]);
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/api/runs/${run.id}/remember`))
      posts++;
  });
  let panel = await open(page);
  await expect
    .poll(async () =>
      matchesText(await panel.allTextContents(), "Saving this strategy will keep it off", true),
    )
    .toBe(true);
  await expect
    .poll(async () => matchesText(await panel.allTextContents(), "Demo source", true))
    .toBe(true);
  await panel
    .getByLabel("Reusable guidance", { exact: true })
    .fill(
      "Inspect the current state, then run focused deterministic checks. Keep independent validation.",
    );
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => panel.isVisible()).not.toBe(true);
  expect(posts).toBe(0);
  expect((await (await request.get("/api/memory")).json()).entries.length).toBe(
    before.entries.length,
  );
  panel = await open(page);
  await panel.getByLabel("Strategy title", { exact: true }).fill("Focused evidence before changes");
  await panel
    .getByLabel("When this is useful", { exact: true })
    .fill("Small code changes that need clear evidence without a broad investigation.");
  await panel
    .getByLabel("Reusable guidance", { exact: true })
    .fill(
      "Inspect the current state, then run focused deterministic checks. Keep independent validation.",
    );
  await panel.getByLabel("Strategy tags", { exact: true }).fill("review, checks");
  await panel.evaluate((element) => {
    element.scrollTop = 0;
  });
  await panel.screenshot({ path: "/tmp/workflow-feature6-strategy.png" });
  await panel.getByRole("button", { name: "Save strategy", exact: true }).click({ clickCount: 2 });
  await expect
    .poll(async () =>
      matchesText(
        await panel.allTextContents(),
        "Approach saved. Project memory remains off",
        true,
      ),
    )
    .toBe(true);
  expect(posts).toBe(1);
  const saved = await (await request.get("/api/memory")).json();
  expect(saved.enabled).toBe(false);
  const description = saved.entries.find(
    (entry: { title: string }) => entry.title === "Focused evidence before changes",
  );
  expect(description.kind).toBe("strategy");
  const entry = await (await request.get(`/api/memory/entries/${description.id}`)).json();
  expect(entry.strategy.sourceRunId).toBe(run.id);
  expect(entry.details).toBe(
    "Inspect the current state, then run focused deterministic checks. Keep independent validation.",
  );
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  panel = await open(page);
  await expect
    .poll(async () => matchesText(await panel.allTextContents(), "Already remembered", true))
    .toBe(true);
  await expect
    .poll(async () =>
      matchesValue(
        await panel.getByLabel("Strategy title", { exact: true }).inputValue(),
        entry.title,
      ),
    )
    .toBe(true);
  await expect
    .poll(() => panel.getByRole("button", { name: "Save strategy", exact: true }).count())
    .toBe(0);
  expect(posts).toBe(1);
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await page.goto("/#settings");
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Memory", exact: true })
    .click();
  const memory = page.getByRole("region", {
    name: "Project memory",
    exact: true,
  });
  await memory.getByLabel("Entry type", { exact: true }).selectOption("strategy");
  await memory.getByRole("button", { name: new RegExp(entry.title) }).click();
  await expect
    .poll(async () =>
      matchesValue(
        await memory.getByLabel("Reusable guidance", { exact: true }).inputValue(),
        entry.details,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      matchesText(
        await memory
          .getByRole("region", { name: "Strategy source facts", exact: true })
          .allTextContents(),
        "Demo source",
        true,
      ),
    )
    .toBe(true);
  await memory
    .getByLabel("Reusable guidance", { exact: true })
    .fill("Preserve focused checks and explicitly review their evidence.");
  await memory.getByRole("button", { name: "Save memory entry", exact: true }).click();
  await expect
    .poll(async () =>
      matchesText(
        await memory.allTextContents(),
        "Memory entry saved. Project memory remains disabled.",
        true,
      ),
    )
    .toBe(true);
  const updated = await (await request.get(`/api/memory/entries/${entry.id}`)).json();
  expect(updated.strategy).toEqual(entry.strategy);
  expect(updated.details).toBe("Preserve focused checks and explicitly review their evidence.");
});

test("stale memory revisions preserve strategy edits until latest facts are reviewed", async ({
  page,
  request,
}) => {
  const run = await completed(page, request);
  const panel = await open(page);
  await panel.getByLabel("Strategy title", { exact: true }).fill("My reusable approach");
  await panel
    .getByLabel("Reusable guidance", { exact: true })
    .fill("Keep this unsaved guidance while reviewing a conflict.");
  const state = await (await request.get("/api/memory")).json();
  const other = await request.post("/api/memory/entries", {
    headers,
    data: {
      revision: state.revision,
      kind: "note",
      title: "Concurrent project note",
      description: "Another client updates memory.",
      details: "Independent content",
      tags: [],
    },
  });
  expect(other.ok(), await other.text()).toBe(true);
  await panel.getByRole("button", { name: "Save strategy", exact: true }).click();
  await expect.poll(() => panel.getByRole("alert").isVisible()).toBe(true);
  await expect
    .poll(async () => matchesText(await panel.allTextContents(), "Your draft is preserved", true))
    .toBe(true);
  await expect
    .poll(async () =>
      matchesValue(
        await panel.getByLabel("Reusable guidance", { exact: true }).inputValue(),
        "Keep this unsaved guidance while reviewing a conflict.",
      ),
    )
    .toBe(true);
  await expect
    .poll(() => panel.getByRole("button", { name: "Save strategy", exact: true }).isDisabled())
    .toBe(true);
  await panel.getByRole("button", { name: "Review latest source & memory", exact: true }).click();
  await expect
    .poll(async () => matchesText(await panel.allTextContents(), "Your draft is unchanged", true))
    .toBe(true);
  await expect
    .poll(async () =>
      matchesValue(
        await panel.getByLabel("Strategy title", { exact: true }).inputValue(),
        "My reusable approach",
      ),
    )
    .toBe(true);
  await panel.getByRole("button", { name: "Save strategy", exact: true }).click();
  await expect
    .poll(async () =>
      matchesText(
        await panel.allTextContents(),
        "Approach saved. Project memory remains off",
        true,
      ),
    )
    .toBe(true);
  const saved = await (await request.get(`/api/runs/${run.id}/strategy-preview`)).json();
  expect(saved.existingEntry.details).toBe(
    "Keep this unsaved guidance while reviewing a conflict.",
  );
});

test("cancelled and delayed previews never write or replace a later preview", async ({
  page,
  request,
}) => {
  const run = await completed(page, request);
  const payload = strategyPreviewSchema.parse(
    await (await request.get(`/api/runs/${run.id}/strategy-preview`)).json(),
  );
  let delayed: import("playwright").Route | undefined;
  let reads = 0;
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/api/runs/${run.id}/remember`))
      posts++;
  });
  await page.route(`**/api/runs/${run.id}/strategy-preview`, (route) => {
    if (++reads === 1) {
      delayed = route;
      return;
    }
    return route.fulfill({
      json: {
        ...payload,
        entry: { ...payload.entry, title: "Current preview" },
      },
    });
  });
  await page.getByRole("button", { name: "Remember this approach", exact: true }).click();
  await expect
    .poll(async () =>
      matchesText(await dialog(page).allTextContents(), "Loading strategy preview", true),
    )
    .toBe(true);
  await expect.poll(() => !!delayed).toBe(true);
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => dialog(page).isVisible()).not.toBe(true);
  const panel = await open(page);
  await expect
    .poll(async () =>
      matchesValue(
        await panel.getByLabel("Strategy title", { exact: true }).inputValue(),
        "Current preview",
      ),
    )
    .toBe(true);
  await delayed!
    .fulfill({
      json: {
        ...payload,
        entry: { ...payload.entry, title: "Obsolete preview" },
      },
    })
    .catch(() => {});
  await expect
    .poll(async () =>
      matchesValue(
        await panel.getByLabel("Strategy title", { exact: true }).inputValue(),
        "Current preview",
      ),
    )
    .toBe(true);
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await panel.evaluate((element) => element.getBoundingClientRect().right <= innerWidth),
  ).toBe(true);
  await panel.evaluate((element) => {
    element.scrollTop = 0;
  });
  await panel.screenshot({
    path: "/tmp/workflow-feature6-strategy-mobile.png",
  });
  await page.keyboard.press("Escape");
  await expect.poll(() => panel.isVisible()).not.toBe(true);
  expect(posts).toBe(0);
});
