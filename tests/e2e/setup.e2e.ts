import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  setupJobSchema,
  setupSchema,
  usageReportSchema,
  type SetupJob,
  type Setup,
  type CompletedSetup,
} from "../../src/contracts.js";

const model = {
  provider: "fixture",
  model: "balanced-model",
  thinking: "medium" as const,
};
const counts = { profiles: 3, cases: 5, blocks: 8 };
function job(overrides: Partial<SetupJob> = {}): SetupJob {
  const id = randomUUID();
  return setupJobSchema.parse({
    id,
    usageScopeId: id,
    revision: 3,
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:01:00.000Z",
    status: "running",
    stage: "blocks",
    model,
    instructions: "Keep costs low and use deterministic tests.",
    maxSetupCostUsd: 0.5,
    stages: [
      {
        id: "profiles",
        status: "completed",
        attempt: 1,
        summary: "Three model roles prepared.",
      },
      {
        id: "cases",
        status: "completed",
        attempt: 1,
        summary: "Review, fixes, features and documentation presets prepared.",
      },
      { id: "blocks", status: "running", attempt: 1 },
      { id: "validation", status: "pending", attempt: 0 },
      { id: "applying", status: "pending", attempt: 0 },
    ],
    activity: "Inspecting project test commands and reusable block contracts.",
    actions: { canResume: false, canCancel: true },
    ...overrides,
  });
}
function completion(id = randomUUID()): CompletedSetup {
  return {
    completedAt: "2026-10-30T09:30:00.000Z",
    model,
    jobId: id,
    generationId: id,
    libraryProposalId: randomUUID(),
    counts,
  };
}

/** UI-only host fixture: all model/setup calls are intercepted; core durability has separate integration coverage. */
async function fixture(context: BrowserContext, request: APIRequestContext) {
  const saved = await (await request.get("/api/setup")).json();
  const state = {
    setup: setupSchema.parse({
      ...saved,
      userAgent: model,
      projectAgent: {},
      providers: [
        {
          id: model.provider,
          name: "Fixture",
          method: "api_key",
          source: "stored",
        },
      ],
      completedSetup: null,
    }) as Setup,
    job: null as SetupJob | null,
    starts: [] as Record<string, unknown>[],
    resumes: [] as Record<string, unknown>[],
    cancels: 0,
  };
  await context.route("**/api/project", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), mode: "live" } });
  });
  await context.route("**/api/setup", (route) =>
    route.fulfill({ json: state.setup }),
  );
  await context.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        warnings: [],
        models: [
          {
            provider: model.provider,
            id: model.model,
            name: "Balanced model",
            reasoning: true,
            thinkingLevels: ["off", "medium", "high"],
            contextWindow: 128000,
            maxTokens: 8000,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    }),
  );
  await context.route(/\/api\/setup-jobs(?:\/.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/usage")) {
      const usage = {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.08,
        requests: 2,
        unpricedRequests: 0,
      };
      await route.fulfill({
        json: usageReportSchema.parse({
          scope: { kind: "setup", id: state.job!.id },
          total: usage,
          phases: [{ phase: "setup", usage, sessionCount: 2 }],
          models: [],
          sessions: [],
          sessionCount: 2,
          sessionsTruncated: true,
          legacyExecution: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            requests: 0,
            unpricedRequests: 0,
          },
          limits: {
            totalCostUsd: state.job!.maxSetupCostUsd,
            remainingCostUsd: null,
          },
          incomplete: state.job!.status === "running",
          warnings: [],
        }),
      });
    } else if (path.endsWith("/latest")) {
      await route.fulfill({ json: { job: state.job } });
    } else if (
      path === "/api/setup-jobs" &&
      route.request().method() === "POST"
    ) {
      const body = route.request().postDataJSON();
      state.starts.push(body);
      if (
        !state.job ||
        !["queued", "running", "cancelling"].includes(state.job.status)
      )
        state.job = job({ instructions: body.instructions ?? "" });
      await route.fulfill({ status: 202, json: state.job });
    } else if (path.endsWith("/resume")) {
      const body = route.request().postDataJSON();
      state.resumes.push(body);
      state.job = job({
        ...state.job!,
        revision: state.job!.revision + 1,
        status: "running",
        maxSetupCostUsd: body.maxSetupCostUsd ?? state.job!.maxSetupCostUsd,
        actions: { canResume: false, canCancel: true },
        stages: state.job!.stages.map((stage) =>
          stage.id === state.job!.stage
            ? { ...stage, status: "running", attempt: stage.attempt + 1 }
            : stage,
        ),
      });
      await route.fulfill({ status: 202, json: state.job });
    } else if (path.endsWith("/cancel")) {
      state.cancels++;
      state.job = job({
        ...state.job!,
        revision: state.job!.revision + 1,
        status: "cancelled",
        actions: { canResume: true, canCancel: false },
        stages: state.job!.stages.map((stage) =>
          stage.status === "running"
            ? { ...stage, status: "interrupted" }
            : stage,
        ),
      });
      await route.fulfill({ json: state.job });
    } else await route.fulfill({ json: state.job });
  });
  return state;
}

test("shared setup survives navigation and reload, and resumes saved stages only after an explicit action", async ({
  page,
  context,
  request,
}) => {
  const state = await fixture(context, request);
  await page.goto("/#settings");
  let panel = page.getByRole("region", { name: "Project setup", exact: true });
  await expect(
    panel.getByRole("button", { name: "Generate project setup", exact: true }),
  ).toBeEnabled();
  await panel
    .getByLabel("Setup preferences optional", { exact: true })
    .fill("Use the existing tests and keep publication manual.");
  await panel
    .getByRole("button", { name: "Generate project setup", exact: true })
    .click();
  await expect(panel).toContainText("2/5 stages complete");
  const id = state.job!.id;
  await expect(panel).toContainText(id);
  await expect(
    panel
      .getByRole("region", { name: "Setup cost", exact: true })
      .locator(".usage-total"),
  ).toContainText("At least $0.0800");
  expect(state.starts).toEqual([
    {
      instructions: "Use the existing tests and keep publication manual.",
      regenerate: false,
    },
  ]);
  await panel.screenshot({ path: "/tmp/workflow-feature3-setup.png" });

  await page.getByRole("button", { name: "New task", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Project setup", exact: true }),
  ).toContainText("Setup in progress");
  await page.getByRole("button", { name: "View setup", exact: true }).click();
  await page.reload();
  panel = page.getByRole("region", { name: "Project setup", exact: true });
  await expect(panel).toContainText(id);
  const second = await context.newPage();
  await second.goto("/#settings");
  const shared = second.getByRole("region", {
    name: "Project setup",
    exact: true,
  });
  await expect(shared).toContainText(id);
  await page.close();
  expect(state.cancels).toBe(0);
  expect(state.starts).toHaveLength(1);

  state.job = job({
    ...state.job!,
    status: "interrupted",
    revision: 4,
    actions: { canResume: true, canCancel: false },
    error: "Host restarted during block generation.",
    stages: state.job!.stages.map((stage) =>
      stage.id === "blocks" ? { ...stage, status: "interrupted" } : stage,
    ),
  });
  await shared
    .getByRole("button", { name: "Refresh setup", exact: true })
    .click();
  await expect(
    shared.getByRole("button", { name: "Resume setup", exact: true }),
  ).toBeEnabled();
  expect(state.resumes).toHaveLength(0);
  await shared
    .getByLabel("Increase setup limit (USD) optional", { exact: true })
    .fill("0.25");
  await expect(
    shared.getByRole("button", { name: "Resume setup", exact: true }),
  ).toBeDisabled();
  await shared
    .getByLabel("Increase setup limit (USD) optional", { exact: true })
    .fill("1");
  await shared
    .getByRole("button", { name: "Resume setup", exact: true })
    .click();
  await expect(shared).toContainText("attempt 2");
  expect(state.resumes).toEqual([{ revision: 4, maxSetupCostUsd: 1 }]);
  expect(state.job!.id).toBe(id);
  expect(
    state
      .job!.stages.slice(0, 2)
      .every((stage) => stage.status === "completed" && stage.attempt === 1),
  ).toBe(true);
  await shared
    .getByRole("button", { name: "Cancel setup", exact: true })
    .click();
  await expect(shared).toContainText("Setup stopped");
  expect(state.cancels).toBe(1);
});

test("failed regeneration retains authoritative last-success metadata on desktop and mobile", async ({
  page,
  context,
  request,
}) => {
  const state = await fixture(context, request);
  state.setup.completedSetup = completion();
  state.job = job({
    status: "failed",
    error: "Block validation failed. Existing project settings were kept.",
    actions: { canResume: true, canCancel: false },
    stages: job().stages.map(stage => stage.id === "blocks" ? { ...stage, status: "failed" } : stage),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#settings");
  const panel = page.getByRole("region", {
    name: "Project setup",
    exact: true,
  });
  await expect(
    panel.getByLabel("Last successful setup", { exact: true }),
  ).toContainText("3 model roles · 5 task presets · 8 blocks");
  await expect(panel).toContainText(
    "This saved setup remains available while the new setup is unfinished",
  );
  await expect(panel).toContainText("Block validation failed");
  expect(
    await panel.evaluate(
      (element) => element.getBoundingClientRect().right <= innerWidth,
    ),
  ).toBe(true);
  await panel.screenshot({ path: "/tmp/workflow-feature3-setup-mobile.png" });
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Project setup", exact: true }),
  ).toContainText("Your previous saved setup remains available");
});

test("conflicted setup requires a new generation and final publication cannot be cancelled", async ({
  page,
  context,
  request,
}) => {
  const state = await fixture(context, request);
  state.job = job({
    status: "conflicted",
    conflict: {
      message: "The review block changed after setup began.",
      paths: [".workflow/blocks/review/block.ts"],
      requiresRegeneration: true,
    },
    actions: { canResume: false, canCancel: false },
  });
  await page.goto("/#settings");
  const panel = page.getByRole("region", {
    name: "Project setup",
    exact: true,
  });
  await expect(panel).toContainText(
    "Start a new setup to use the current project settings",
  );
  await expect(
    panel.getByRole("button", { name: "Resume setup", exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "Start a new setup", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Generate project setup", exact: true })
    .click();
  await expect(panel).toContainText("Setup in progress");
  expect(state.starts[0]?.regenerate).toBe(true);
  state.job = job({
    ...state.job!,
    revision: 7,
    stage: "applying",
    actions: { canResume: false, canCancel: false },
    stages: state.job!.stages.map((stage) => ({
      ...stage,
      status: stage.id === "applying" ? "running" : "completed",
      attempt: 1,
    })),
  });
  await panel
    .getByRole("button", { name: "Refresh setup", exact: true })
    .click();
  await expect(panel).toContainText("This stage cannot be cancelled");
  await expect(
    panel.getByRole("button", { name: "Cancel setup", exact: true }),
  ).toHaveCount(0);
  state.setup.providers = [];
  state.job = job({
    ...state.job!,
    revision: 8,
    status: "interrupted",
    actions: { canResume: true, canCancel: false },
    stages: state.job!.stages.map((stage) =>
      stage.id === "applying" ? { ...stage, status: "interrupted" } : stage,
    ),
  });
  await panel
    .getByRole("button", { name: "Refresh setup", exact: true })
    .click();
  await expect(panel).toContainText("without new model calls");
  await expect(
    panel.getByRole("button", { name: "Resume setup", exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "Resume setup", exact: true })
    .click();
  await expect(panel).toContainText("Setup in progress");
  expect(state.resumes).toEqual([{ revision: 8 }]);
  expect(
    state
      .job!.stages.slice(0, 3)
      .every((stage) => stage.status === "completed"),
  ).toBe(true);
});

test("setup requires the selected provider and completion preserves unsaved settings", async ({
  page,
  context,
  request,
}) => {
  const state = await fixture(context, request);
  state.setup.providers = [
    {
      id: "other-provider",
      name: "Other",
      method: "api_key",
      source: "stored",
    },
  ];
  await page.goto("/#settings");
  const panel = page.getByRole("region", {
    name: "Project setup",
    exact: true,
  });
  await expect(
    panel.getByRole("button", { name: "Generate project setup", exact: true }),
  ).toBeDisabled();
  await expect(panel).toContainText(
    "Connect fixture or save a model from a connected provider",
  );
  state.setup.providers = [
    {
      id: model.provider,
      name: "Fixture",
      method: "api_key",
      source: "stored",
    },
  ];
  await panel
    .getByRole("button", { name: "Refresh setup", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Generate project setup", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Thinking level", { exact: true }).selectOption("high");
  await expect(
    panel.getByRole("button", { name: "Generate project setup", exact: true }),
  ).toBeDisabled();
  const completed = completion();
  state.setup.completedSetup = completed;
  state.job = job({
    id: completed.jobId!,
    status: "completed",
    stage: "applying",
    actions: { canResume: false, canCancel: false },
    result: {
      ...counts,
      completedAt: completed.completedAt,
      generationId: completed.generationId!,
    },
    stages: job().stages.map((stage) => ({
      ...stage,
      status: "completed",
      attempt: 1,
    })),
  });
  await panel
    .getByRole("button", { name: "Refresh setup", exact: true })
    .click();
  await expect(
    page.getByText(
      "Project settings changed while you were editing. Your unsaved edits are preserved.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Thinking level", { exact: true })).toHaveValue(
    "high",
  );
  await page
    .getByRole("button", { name: "Discard model changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reload saved settings", exact: true })
    .click();
  await expect(page.getByLabel("Thinking level", { exact: true })).toHaveValue(
    "medium",
  );
  await expect(
    page.getByRole("button", { name: "Reload saved settings", exact: true }),
  ).toHaveCount(0);
});
