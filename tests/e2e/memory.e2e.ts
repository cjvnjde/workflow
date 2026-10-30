import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  memoryEntrySchema,
  memoryStateSchema,
  createMemoryEntrySchema,
  updateMemoryEntrySchema,
  type MemoryEntry,
} from "../../src/contracts/memory-schema.js";

const at = "2026-10-30T12:00:00.000Z";
const note = (title: string, kind: "note" | "preference" = "note") =>
  memoryEntrySchema.parse({
    id: randomUUID(),
    kind,
    title,
    description: `When working on ${title.toLowerCase()}.`,
    details: `Private detail for ${title}.`,
    tags: ["review"],
    createdAt: at,
    updatedAt: at,
    edited: true,
  });
function observation() {
  return memoryEntrySchema.parse({
    id: randomUUID(),
    kind: "observation",
    title: "Review · independent reviewer",
    description: "Two recorded review runs with the selected model.",
    details: "Recorded outcomes describe execution, not model quality.",
    tags: ["review"],
    createdAt: at,
    updatedAt: at,
    edited: false,
    observation: {
      taskCaseId: "review",
      taskCaseName: "Code review",
      blockId: "review",
      model: {
        provider: "fixture",
        model: "independent-reviewer",
        thinking: "high",
      },
      runs: 2,
      runStatuses: { completed: 1, failed: 1, cancelled: 0 },
      visits: 3,
      outcomes: { pass: 1, retry: 1, fail: 1, interrupted: 0 },
      sessions: 3,
      sessionStatuses: {
        running: 0,
        completed: 2,
        failed: 1,
        cancelled: 0,
        interrupted: 0,
      },
      checks: { total: 4, matched: 3, unmatched: 1 },
      dispositions: {
        workCompleted: 1,
        accepted: 0,
        changesRequested: 1,
        blocked: 1,
      },
      usageIncomplete: true,
      usage: {
        inputTokens: 1000,
        outputTokens: 400,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requests: 3,
        costUsd: 0.003,
        unpricedRequests: 1,
      },
      sources: [{ runId: randomUUID(), nodeId: "review", visit: 1, at }],
      firstObservedAt: at,
      lastObservedAt: at,
    },
  });
}
async function fixture(context: BrowserContext, seeded: MemoryEntry[] = []) {
  const store = {
    enabled: false,
    revision: 1,
    entries: new Map(seeded.map((entry) => [entry.id, entry])),
    reads: [] as string[],
    writes: [] as { method: string; body: Record<string, unknown> }[],
    loadFailure: false,
  };
  const state = () =>
    memoryStateSchema.parse({
      enabled: store.enabled,
      revision: String(store.revision),
      limit: 100,
      entries: [...store.entries.values()].map(
        ({ details: _details, observation: _observation, edited: _edited, ...entry }) => entry,
      ),
    });
  await context.route(/\/api\/memory(?:\/entries(?:\/[^/?]+)?)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const id = path.startsWith("/api/memory/entries/") ? path.split("/").at(-1)! : undefined;
    if (method === "GET") {
      if (store.loadFailure && !id)
        return route.fulfill({
          status: 503,
          json: { error: "Memory storage temporarily unavailable" },
        });
      if (id) {
        store.reads.push(id);
        return store.entries.has(id)
          ? route.fulfill({ json: store.entries.get(id) })
          : route.fulfill({
              status: 404,
              json: { error: "Memory entry no longer exists" },
            });
      }
      return route.fulfill({ json: state() });
    }
    const body = route.request().postDataJSON();
    store.writes.push({ method, body });
    if (body.revision !== String(store.revision))
      return route.fulfill({
        status: 409,
        json: {
          error: "Memory changed in another client. Reload before saving.",
        },
      });
    if (method === "PUT") {
      store.enabled = body.enabled;
      store.revision++;
      return route.fulfill({ json: state() });
    }
    if (method === "DELETE") {
      store.entries.delete(id!);
      store.revision++;
      return route.fulfill({ json: state() });
    }
    const fields =
      method === "POST" ? createMemoryEntrySchema.parse(body) : updateMemoryEntrySchema.parse(body);
    const { revision: _revision, ...values } = fields;
    const previous = id ? store.entries.get(id) : undefined;
    if (id && !previous)
      return route.fulfill({
        status: 404,
        json: { error: "Memory entry no longer exists" },
      });
    const entry = memoryEntrySchema.parse({
      ...previous,
      ...values,
      id: id ?? randomUUID(),
      createdAt: previous?.createdAt ?? at,
      updatedAt: `2026-10-30T12:00:${String(++store.revision).padStart(2, "0")}.000Z`,
      edited: true,
    });
    store.entries.set(entry.id, entry);
    return route.fulfill({ json: { state: state(), entry } });
  });
  return store;
}
async function open(page: Page) {
  await page.goto("/#settings");
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Memory", exact: true })
    .click();
  return page.getByRole("region", { name: "Project memory", exact: true });
}

test("memory starts off and notes and explicit preferences save independently of project settings", async ({
  page,
  context,
}) => {
  const store = await fixture(context);
  const panel = await open(page);
  await expect(panel).toContainText("Project memory is off");
  await expect(panel).toContainText("No saved entries yet");
  await expect(panel.getByRole("button", { name: "Save settings", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "New note", exact: true }).click();
  await panel.getByLabel("Memory title", { exact: true }).fill("Repository checks");
  await panel
    .getByLabel("Short description", { exact: true })
    .fill("Use before finalizing TypeScript changes.");
  await panel
    .getByLabel("Memory details", { exact: true })
    .fill("Run the focused unit test and the project typecheck.");
  await panel.getByLabel("Memory tags", { exact: true }).fill("checks, typescript");
  await panel.getByRole("button", { name: "Save memory entry", exact: true }).click();
  await expect(panel).toContainText("Memory entry saved. Project memory remains disabled.");
  expect(store.enabled).toBe(false);
  expect([...store.entries.values()][0]?.kind).toBe("note");
  await panel.getByRole("button", { name: "New preference", exact: true }).click();
  await expect(panel).toContainText("Workflow does not infer preferences");
  await panel.getByLabel("Memory title", { exact: true }).fill("Review preference");
  await panel.getByLabel("Short description", { exact: true }).fill("How I want code reviewed.");
  await panel
    .getByLabel("Memory details", { exact: true })
    .fill("Start with correctness issues, then readability.");
  await panel.getByRole("button", { name: "Save memory entry", exact: true }).click();
  await expect.poll(() => store.entries.size).toBe(2);
  expect([...store.entries.values()][1]?.kind).toBe("preference");
  await panel.getByRole("button", { name: "Enable project memory", exact: true }).click();
  await expect(panel).toContainText("Project memory is on");
  await panel.getByRole("button", { name: "Disable project memory", exact: true }).click();
  await expect(panel).toContainText("Saved entries are retained");
  await page.reload();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Memory", exact: true })
    .click();
  await expect(panel).toContainText("Repository checks");
  await expect(panel).toContainText("Review preference");
  expect(store.enabled).toBe(false);
  expect(store.reads).toEqual([]);
});

test("memory loads selected details only and preserves a draft across revision conflicts", async ({
  page,
  context,
}) => {
  const first = note("Frontend review"),
    second = note("Backend review");
  const store = await fixture(context, [first, second]);
  const panel = await open(page);
  await expect(panel).toContainText(first.description);
  expect(store.reads).toEqual([]);
  await expect(panel).not.toContainText(first.details);
  await panel.getByRole("button", { name: new RegExp(first.title) }).click();
  await expect(panel.getByLabel("Memory details", { exact: true })).toHaveValue(first.details);
  expect(store.reads).toEqual([first.id]);
  await panel
    .getByLabel("Memory details", { exact: true })
    .fill("My unsaved guidance remains visible.");
  const remote = {
    ...first,
    details: "A collaborator saved another version.",
    updatedAt: "2026-10-30T12:01:00.000Z",
  };
  store.entries.set(first.id, remote);
  store.revision++;
  await panel.getByRole("button", { name: "Save memory entry", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Memory changed in another client");
  await expect(panel.getByLabel("Memory details", { exact: true })).toHaveValue(
    "My unsaved guidance remains visible.",
  );
  await panel.getByRole("button", { name: "Review latest saved entry", exact: true }).click();
  await expect(panel.locator(".memory-latest")).toContainText(remote.details);
  await expect(panel.getByLabel("Memory details", { exact: true })).toHaveValue(
    "My unsaved guidance remains visible.",
  );
  await panel
    .getByRole("button", {
      name: "Save my edits over this version",
      exact: true,
    })
    .click();
  await expect(panel).toContainText("Memory entry saved");
  expect(store.entries.get(first.id)?.details).toBe("My unsaved guidance remains visible.");
  expect(store.entries.get(second.id)?.details).toBe(second.details);
  await panel.getByLabel("Search memory descriptions", { exact: true }).fill("Backend");
  await expect(panel.locator(".memory-entry")).toHaveCount(1);
  await expect(panel.locator(".memory-entry")).toContainText(second.title);
  await panel.getByLabel("Search memory descriptions", { exact: true }).fill("");
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "Delete entry", exact: true }).click();
  await expect(panel).toContainText("Memory entry deleted");
  expect(store.entries.has(first.id)).toBe(false);
});

test("observation annotations keep recorded facts separate and fit mobile screens", async ({
  page,
  context,
}) => {
  const observed = observation();
  const store = await fixture(context, [observed, note("Preferred review order", "preference")]);
  store.enabled = true;
  await page.setViewportSize({ width: 1440, height: 1100 });
  const panel = await open(page);
  await panel.getByRole("button", { name: new RegExp(observed.title) }).click();
  const facts = panel.getByRole("region", {
    name: "Recorded observation facts",
    exact: true,
  });
  await expect(facts).toContainText("not a quality score");
  await expect(facts).toContainText("3 matched · 1 unmatched · 4 recorded");
  await expect(facts).toContainText("At least $0.0030");
  await expect(facts).toContainText("fixture/independent-reviewer");
  await expect(facts.getByRole("link")).toHaveAttribute(
    "href",
    `#run=${observed.observation!.sources[0]!.runId}`,
  );
  await panel
    .getByLabel("Your annotation", { exact: true })
    .fill("This sample is too small to judge quality. Keep independent checks.");
  await panel.getByRole("button", { name: "Save memory entry", exact: true }).click();
  await expect(panel).toContainText("Your annotation: you can edit this guidance");
  expect(store.entries.get(observed.id)?.observation).toEqual(observed.observation);
  expect(store.writes.at(-1)?.body).not.toHaveProperty("observation");
  await panel.screenshot({ path: "/tmp/workflow-feature5-memory.png" });
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await panel.evaluate((element) => element.getBoundingClientRect().right <= innerWidth),
  ).toBe(true);
  await panel.screenshot({ path: "/tmp/workflow-feature5-memory-mobile.png" });
});

test("memory loading errors recover and late detail responses cannot replace the chosen entry", async ({
  page,
  context,
}) => {
  const first = note("Delayed entry"),
    second = note("Current entry");
  const store = await fixture(context, [first, second]);
  store.loadFailure = true;
  const panel = await open(page);
  await expect(panel.getByRole("alert")).toContainText("Memory storage temporarily unavailable");
  store.loadFailure = false;
  await panel.getByRole("button", { name: "Retry loading memory", exact: true }).click();
  await expect(panel).toContainText(first.title);
  let delayed: import("@playwright/test").Route | undefined;
  await page.route(`**/api/memory/entries/${first.id}`, (route) => {
    delayed = route;
  });
  await panel.getByRole("button", { name: new RegExp(first.title) }).click();
  await expect.poll(() => !!delayed).toBe(true);
  await panel.getByRole("button", { name: new RegExp(second.title) }).click();
  await expect(panel.getByLabel("Memory details", { exact: true })).toHaveValue(second.details);
  await delayed!.fulfill({ json: first }).catch(() => {});
  await expect(panel.getByLabel("Memory title", { exact: true })).toHaveValue(second.title);
  await panel
    .getByLabel("Memory details", { exact: true })
    .fill("A draft that must survive leaving the section.");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Execution", exact: true })
    .click();
  await expect(panel.getByLabel("Memory details", { exact: true })).toHaveValue(
    "A draft that must survive leaving the section.",
  );
});
