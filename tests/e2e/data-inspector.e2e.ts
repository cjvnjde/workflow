import { expect } from "vitest";
import { test } from "./fixtures.js";
import { matchesText, matchesValue } from "./text.js";
import { type APIRequestContext, type Page } from "playwright";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  attemptEvidenceSchema,
  type AttemptEvidence,
  type EvidenceContentRef,
  type StoredEvidenceValue,
} from "../../src/contracts/index.js";

const source = `import { workflow, block, step, sequence, parallel, repeatUntil, z } from "workflow";
const producer = block({run(ctx) { const name = String(ctx.input.kind); return {files:[name+".ts"],tests:name === "frontend" ? 2 : 3}; }});
const frontend = step("frontend", producer, {label:"Frontend", inputs:{kind:"frontend"}});
const backend = step("backend", producer, {label:"Backend", inputs:{kind:"backend"}});
const shape = z.object({files:z.array(z.string()),tests:z.number()});
const report = step("report", block({input:z.object({frontend:shape,backend:shape,round:z.number(),format:z.string().default("compact")}),run(ctx) {return {tests:ctx.input.frontend.tests+ctx.input.backend.tests,round:ctx.input.round,format:ctx.input.format};}}), {
  label:"Compare both branches", maxVisits:2,
  inputs: ctx => ({frontend:ctx.output(frontend),backend:ctx.output(backend),round:ctx.iteration("rounds")} as any)
});
export default workflow({name:"Parallel handoff comparison",flow:sequence(parallel([frontend,backend],{concurrency:2}),repeatUntil("rounds",{body:report,until:ctx=>ctx.output(report)?.round===2,maxIterations:2}))});`;

async function create(request: APIRequestContext, prompt?: string) {
  const response = await request.post("/api/programs", {
    headers: { "x-workflow-client": "1" },
    data: {
      title: "Parallel handoff comparison",
      task: "Compare exact values from two parallel branches",
      source: prompt
        ? source.replace(
            "run(ctx) {return {tests:",
            `run(ctx) {ctx.artifact("large-context",${JSON.stringify(prompt)});return {tests:`,
          )
        : source,
      input: {},
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json();
}
async function completed(page: Page, request: APIRequestContext, prompt?: string) {
  const run = await create(request, prompt);
  await page.goto(`/#run=${run.id}`);
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
  await page
    .getByRole("navigation", { name: "Workflow views" })
    .getByRole("button", { name: "Data", exact: true })
    .click();
  const inspector = page.getByRole("region", {
    name: "Step data inspector",
    exact: true,
  });
  await inspector.getByRole("combobox", { name: "Step", exact: true }).selectOption("report");
  return { run, inspector };
}
function value(panel: ReturnType<Page["getByRole"]>, label: string) {
  return panel.locator("details.evidence-value").filter({
    has: panel.page().locator("summary > strong", {
      hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    }),
  });
}

test("data inspector shows planned sources, parallel named inputs and exact historical visits", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1500, height: 1200 });
  const run = await create(request);
  let contentRequests = 0;
  page.on("request", (request) => {
    if (/\/attempts\/[^/]+\/\d+\/content\//.test(request.url())) contentRequests++;
  });
  await page.goto(`/#run=${run.id}`);
  await page.locator('.workflow-node[data-id="report"]').click();
  await page.getByRole("button", { name: "Inspect step data", exact: true }).click();
  const inspector = page.getByRole("region", {
    name: "Step data inspector",
    exact: true,
  });
  await expect
    .poll(() => inspector.getByRole("combobox", { name: "Visit", exact: true }).isDisabled())
    .toBe(true);
  await expect
    .poll(async () =>
      matchesText(
        await inspector.allTextContents(),
        "Deferred · resolved when this step starts",
        true,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () => matchesText(await inspector.allTextContents(), "ctx.output(frontend)", true))
    .toBe(true);
  await inspector.getByRole("combobox", { name: "Step", exact: true }).selectOption("frontend");
  await expect
    .poll(async () => matchesText(await inspector.allTextContents(), "Literal value", true))
    .toBe(true);
  await expect
    .poll(async () => matchesText(await inspector.allTextContents(), '"kind": "frontend"', true))
    .toBe(true);
  expect(contentRequests).toBe(0);
  await inspector.getByRole("combobox", { name: "Step", exact: true }).selectOption("report");
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
  await expect
    .poll(async () =>
      matchesValue(
        await inspector.getByRole("combobox", { name: "Visit", exact: true }).inputValue(),
        "2",
      ),
    )
    .toBe(true);
  await inspector.getByRole("combobox", { name: "Visit", exact: true }).selectOption("1");
  await expect
    .poll(() =>
      inspector
        .getByRole("heading", {
          name: "Compare both branches · visit 1",
          exact: true,
        })
        .isVisible(),
    )
    .toBe(true);
  expect(contentRequests).toBe(0);
  const raw = value(inspector, "Raw inputs"),
    effective = value(inspector, "Effective inputs");
  await raw.locator("summary").click();
  await effective.locator("summary").click();
  await expect
    .poll(async () => matchesText(await raw.allTextContents(), "frontend.ts", true))
    .toBe(true);
  await expect
    .poll(async () => matchesText(await raw.allTextContents(), "backend.ts", true))
    .toBe(true);
  await expect
    .poll(() => raw.getByRole("heading", { name: /frontend\s*object/ }).isVisible())
    .toBe(true);
  await expect
    .poll(() => raw.getByRole("heading", { name: /backend\s*object/ }).isVisible())
    .toBe(true);
  await expect
    .poll(async () => matchesText(await raw.allTextContents(), "compact", true))
    .not.toBe(true);
  await expect
    .poll(async () => matchesText(await effective.allTextContents(), "compact", true))
    .toBe(true);
  const output = value(inspector, "Typed output");
  await output.locator("summary").click();
  await expect
    .poll(async () =>
      matchesText(
        await output
          .locator(".evidence-fields > section")
          .filter({ hasText: /round\s*number/ })
          .allTextContents(),
        "1",
        true,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () => matchesText(await inspector.allTextContents(), "Inputs computed from", true))
    .toBe(true);
  const toast = page.getByRole("button", {
    name: "Dismiss notification",
    exact: true,
  });
  if (await toast.isVisible()) await toast.click();
  await inspector.screenshot({ path: "/tmp/workflow-feature4-data.png" });
  await inspector.getByRole("button", { name: "Frontend · visit 1", exact: true }).click();
  await expect
    .poll(async () =>
      matchesValue(
        await inspector.getByRole("combobox", { name: "Step", exact: true }).inputValue(),
        "frontend",
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      matchesValue(
        await inspector.getByRole("combobox", { name: "Visit", exact: true }).inputValue(),
        "1",
      ),
    )
    .toBe(true);
  await value(inspector, "Typed output").locator("summary").click();
  await expect
    .poll(async () =>
      matchesText(await value(inspector, "Typed output").allTextContents(), "frontend.ts", true),
    )
    .toBe(true);
  await inspector.getByRole("combobox", { name: "Step", exact: true }).selectOption("report");
  await expect
    .poll(async () =>
      matchesValue(
        await inspector.getByRole("combobox", { name: "Visit", exact: true }).inputValue(),
        "2",
      ),
    )
    .toBe(true);
  await value(inspector, "Typed output").locator("summary").click();
  await expect
    .poll(async () =>
      matchesText(
        await value(inspector, "Typed output")
          .locator(".evidence-fields > section")
          .filter({ hasText: /round\s*number/ })
          .allTextContents(),
        "2",
        true,
      ),
    )
    .toBe(true);
});

test("AI session context loads lazily and full search, copy and download survive preview limits", async ({
  page,
  request,
}) => {
  const long =
    "Explicit context only.\n" + "selected evidence\n".repeat(2000) + "FINAL_SEARCH_TARGET";
  const { run, inspector } = await completed(page, request, long);
  const contents = new Map<string, { text: string; mediaType: string }>();
  const ref = (text: string, mediaType = "text/plain"): EvidenceContentRef => {
    const id = createHash("sha256").update(text).digest("hex");
    contents.set(id, { text, mediaType });
    return { id, bytes: Buffer.byteLength(text), mediaType, exact: true };
  };
  const stored = (text: string, mediaType?: string): StoredEvidenceValue => ({
    state: "captured",
    ref: ref(text, mediaType),
  });
  const sessionId = randomUUID();
  const payload: AttemptEvidence = attemptEvidenceSchema.parse({
    version: 1,
    runId: run.id,
    nodeId: "report",
    visit: 2,
    inputs: {
      state: "available",
      value: {
        raw: stored('{"selected":"only this"}', "application/json"),
        effective: stored('{"selected":"only this"}', "application/json"),
        prompt: stored("Compare selected evidence"),
        dependencies: [],
      },
    },
    output: {
      state: "available",
      value: {
        data: stored('{"approved":true}', "application/json"),
        artifacts: {},
        summary: ref("Review result"),
        outcome: "pass",
      },
    },
    sessions: [
      {
        sessionId,
        operationId: "report/ai-1",
        activityAttempt: 1,
        usage: {
          id: sessionId,
          scopeId: randomUUID(),
          phase: "execution",
          operationId: "report/ai-1",
          runId: run.id,
          nodeId: "report",
          visit: 2,
          provider: "fixture",
          model: "independent-reviewer",
          thinking: "high",
          pricing: {
            source: "catalog",
            rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
          usage: {
            inputTokens: 300,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            requests: 1,
            costUsd: 0.0005,
            unpricedRequests: 0,
          },
          status: "completed",
          startedAt: "2026-10-30T10:00:00Z",
          updatedAt: "2026-10-30T10:00:02Z",
          endedAt: "2026-10-30T10:00:02Z",
        },
        context: {
          state: "available",
          value: {
            systemPrompt: ref("Inspect only the explicit selected evidence."),
            tools: ref(
              '[{"name":"submit_result","description":"Return the review","parameters":{"type":"object"}}]',
              "application/json",
            ),
            contextMode: "none",
            settings: {
              provider: "fixture",
              model: "independent-reviewer",
              thinking: "high",
              maxToolCalls: 5,
              timeoutMs: 60000,
            },
          },
        },
        call: {
          state: "available",
          value: {
            prompt: stored(long),
            instructions: { state: "undefined" },
            contextMode: "none",
          },
        },
        prompts: [
          {
            index: 0,
            kind: "initial",
            text: stored("Supplied session prompt"),
            images: [],
          },
          {
            index: 1,
            kind: "continuation",
            text: stored("Submit the existing review without repeating the inspection."),
            images: [
              {
                state: "unavailable",
                reasonCode: "oversized",
                reason: "Image evidence exceeded the capture limit.",
              },
            ],
          },
        ],
        tools: [
          {
            callId: "submit_result-1",
            state: "completed",
            input: stored('{"approved":true}', "application/json"),
            output: stored("Review accepted"),
          },
        ],
      },
    ],
  });
  await page.route(`**/api/runs/${run.id}/attempts/report/2/evidence`, (route) =>
    route.fulfill({ json: payload }),
  );
  let fetched = 0;
  const realPromptId = createHash("sha256").update(long).digest("hex");
  page.on("request", (request) => {
    if (request.url().includes(`/api/runs/${run.id}/attempts/report/2/content/`)) fetched++;
  });
  // The large text is a real captured artifact: exercise the actual content/download route.
  // Other session fields use deterministic metadata without making a paid model call.
  await page.route(
    new RegExp(`/api/runs/${run.id}/attempts/report/2/content/(?!${realPromptId})`),
    (route) => {
      const url = new URL(route.request().url());
      const item = contents.get(url.pathname.split("/").at(-1)!)!;
      return route.fulfill({
        body: item.text,
        contentType: item.mediaType,
        headers: url.searchParams.has("download")
          ? { "content-disposition": 'attachment; filename="evidence.txt"' }
          : {},
      });
    },
  );
  await inspector.getByRole("button", { name: "Refresh data", exact: true }).click();
  await expect
    .poll(async () =>
      matchesText(await inspector.allTextContents(), "fixture/independent-reviewer", true),
    )
    .toBe(true);
  expect(fetched).toBe(0);
  const session = inspector.getByLabel(`AI session ${sessionId}`, {
    exact: true,
  });
  await session.locator(":scope > summary").click();
  await expect
    .poll(async () => matchesText(await session.allTextContents(), "explicit context only", true))
    .toBe(true);
  await expect
    .poll(async () =>
      matchesText(await session.allTextContents(), "high thinking · 1 request · 400 tokens", true),
    )
    .toBe(true);
  expect(fetched).toBe(0);
  const original = value(session, "Original call prompt");
  await original.locator("summary").click();
  await expect
    .poll(async () => matchesText(await original.allTextContents(), "Preview: characters", true))
    .toBe(true);
  await original
    .getByLabel("Search Original call prompt", { exact: true })
    .fill("FINAL_SEARCH_TARGET");
  await expect
    .poll(async () =>
      matchesText(await original.locator("mark").allTextContents(), "FINAL_SEARCH_TARGET", false),
    )
    .toBe(true);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await original.getByRole("button", { name: "Copy Original call prompt", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(long);
  const download = page.waitForEvent("download");
  await original.getByRole("link", { name: "Download", exact: true }).click();
  expect(await readFile((await (await download).path())!, "utf8")).toBe(long);
  await value(session, "System instructions").locator("summary").click();
  await expect
    .poll(async () =>
      matchesText(
        await value(session, "System instructions").allTextContents(),
        "Inspect only the explicit selected evidence",
        true,
      ),
    )
    .toBe(true);
  await value(session, "Available tool definitions").locator("summary").click();
  await expect
    .poll(async () =>
      matchesText(
        await value(session, "Available tool definitions").allTextContents(),
        '"submit_result"',
        true,
      ),
    )
    .toBe(true);
  await value(session, "Session prompt 2 (continuation)").locator("summary").click();
  await expect
    .poll(async () =>
      matchesText(await session.allTextContents(), "without repeating the inspection", true),
    )
    .toBe(true);
  await value(session, "Prompt 2 image 1").locator("summary").click();
  await expect
    .poll(async () =>
      matchesText(
        await session.allTextContents(),
        "Image evidence exceeded the capture limit",
        true,
      ),
    )
    .toBe(true);
  const toast = page.getByRole("button", {
    name: "Dismiss notification",
    exact: true,
  });
  if (await toast.isVisible()) await toast.click();
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await inspector.evaluate((element) => element.getBoundingClientRect().right <= innerWidth),
  ).toBe(true);
  await inspector.screenshot({
    path: "/tmp/workflow-feature4-data-mobile.png",
  });
  payload.inputs = {
    state: "unavailable",
    reason: "This historical visit did not capture exact inputs.",
  };
  payload.sessions = [];
  await inspector.getByRole("button", { name: "Refresh data", exact: true }).click();
  await expect
    .poll(async () =>
      matchesText(
        await inspector.allTextContents(),
        "This historical visit did not capture exact inputs",
        true,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () => matchesText(await inspector.allTextContents(), "shortened previews", true))
    .toBe(true);
  await expect.poll(() => value(inspector, "Raw inputs").count()).toBe(0);
});

test("a delayed historical lookup cannot replace the newly selected visit", async ({
  page,
  request,
}) => {
  const { run, inspector } = await completed(page, request);
  const first = await (await request.get(`/api/runs/${run.id}/attempts/report/1/evidence`)).json();
  let delayed: import("playwright").Route | undefined;
  await page.route(`**/api/runs/${run.id}/attempts/report/1/evidence`, (route) => {
    delayed = route;
  });
  await inspector.getByRole("combobox", { name: "Visit", exact: true }).selectOption("1");
  await expect.poll(() => !!delayed).toBe(true);
  await inspector.getByRole("combobox", { name: "Visit", exact: true }).selectOption("2");
  await expect
    .poll(() =>
      inspector
        .getByRole("heading", {
          name: "Compare both branches · visit 2",
          exact: true,
        })
        .isVisible(),
    )
    .toBe(true);
  await delayed!.fulfill({ json: first }).catch(() => {});
  await value(inspector, "Typed output").locator("summary").click();
  await expect
    .poll(async () =>
      matchesText(
        await value(inspector, "Typed output")
          .locator(".evidence-fields > section")
          .filter({ hasText: /round\s*number/ })
          .allTextContents(),
        "2",
        true,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      matchesValue(
        await inspector.getByRole("combobox", { name: "Visit", exact: true }).inputValue(),
        "2",
      ),
    )
    .toBe(true);
});
