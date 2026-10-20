import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

async function newTask(page: Page, prompt: string) {
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("What should we work on?", { exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
}
async function settings(page: Page, section = "Providers & models") {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: section, exact: true }).click();
}

test("a user reviews a bug graph, approves it and sees review feedback return to the fix step", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  await page.goto("/");
  await expect(
    page.getByText("DEMO", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("What should we work on?").fill("Fix the empty-input bug");
  await page
    .getByRole("button", { name: "Start task", exact: true })
    .click();
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
  await expect(page.locator(".vue-flow__node")).toHaveCount(5);
  await page.locator(".vue-flow__node[data-id='work']").click();
  await page.getByText("Instructions & tools", { exact: true }).click();
  await expect(page.locator(".step-inspector")).toContainText("Full file access, Bash, Git");
  await page
    .getByRole("button", { name: "Approve & start", exact: true })
    .click();
  await expect(page.locator(".status-pill")).toHaveText("Completed", {
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Show all steps", exact: true }).click();
  await expect(page.locator(".activity")).toContainText("RETRY → work");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect(page.locator(".vue-flow__node[data-id='work']")).toContainText(
    "2/3 visits",
  );
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await page.getByText("review / feedback", { exact: true }).click();
  await expect(page.locator(".artifact-list")).toContainText(
    "demonstration data",
  );
  expect(pageErrors).toEqual([]);
});

test("a user can edit a draft model and reject a graph without execution", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("What should we work on?").fill("Add a dark mode switch");
  await page
    .getByRole("button", { name: "Start task", exact: true })
    .click();
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
  await page
    .getByRole("button", { name: "Edit workflow", exact: true })
    .click();
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  const editor = page.getByLabel("Workflow graph JSON");
  const plan: unknown = JSON.parse(await editor.inputValue());
  // The browser edit boundary remains schema-validated by the server.
  const { planSchema } = await import("../../src/domain.js");
  const edited = planSchema.parse(plan);
  edited.title = "Human-reviewed feature workflow";
  const first = edited.nodes[0];
  if (!first) {
    throw new Error("Expected preparation node");
  }
  first.agent = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    thinking: "high",
  };
  await editor.fill(JSON.stringify(edited, null, 2));
  await page
    .getByRole("button", { name: "Validate & save draft", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: edited.title })).toBeVisible();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Rejected");
  await expect(page.getByText("0/30 step visits", { exact: false })).toBeVisible();
});

test("a user pauses a Temporal workflow, reloads the page, and resumes the remaining graph", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("What should we work on?").fill("Pause and resume a feature safely");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await page.getByRole("button", { name: "Pause after step", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Paused", { timeout: 10_000 });
  const budget = page.locator(".workflow-counts");
  const checkpoint = await budget.textContent();
  await page.reload();
  await expect(page.locator(".status-pill")).toHaveText("Paused");
  await expect(budget).toHaveText(checkpoint ?? "");
  await page.getByRole("button", { name: "Resume workflow", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Completed", { timeout: 15_000 });
  await expect(page.locator(".vue-flow__node[data-id='prepare']")).toContainText(/1\/\d+ visits/);
});

test("a delayed approval response cannot replace a completed workflow with old state", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("What should we work on?").fill("Delayed approval response regression");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/runs/*/approve", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "Approve & start", exact: true }).click();
    await expect(page.locator(".status-pill")).toHaveText("Completed", { timeout: 15_000 });
  } finally {
    release();
  }
  await expect(page.getByRole("button", { name: "Use in a new task", exact: true })).toBeEnabled();
  await expect(page.locator(".status-pill")).toHaveText("Completed");
});

test("an action response cannot switch the UI back to a previously selected run", async ({ page }) => {
  await page.goto("/");
  for (const task of ["Selection regression first", "Selection regression second"]) {
    await newTask(page, task);
    await expect(page.locator(".task-request > p")).toHaveText(task);
  }
  await page.locator(".task-item").filter({ hasText: "Selection regression first" }).click();
  await expect(page.locator(".task-request > p")).toHaveText("Selection regression first");
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const responseReady = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/api/runs/*/reject", async (route) => {
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await responseReady;
    await page.locator(".task-item").filter({ hasText: "Selection regression second" }).click();
    await expect(page.locator(".task-request > p")).toHaveText("Selection regression second");
  } finally {
    release();
  }
  await expect(page.getByRole("button", { name: "Use in a new task", exact: true })).toBeEnabled();
  await expect(page.locator(".task-request > p")).toHaveText("Selection regression second");
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
});

test("the UI shows a draft budget estimate, execution version and configured spending limit", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("What should we work on?").fill("Budget display regression");
  const config = await (await request.get("/api/settings/execution")).json();
  await request.put("/api/settings/execution", { headers: { "x-workflow-client": "1" }, data: { ...config, budget: { maxCostUsd: 2.5 } } });
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
  await page.locator(".run-metrics > summary").click();
  const budget = page.locator(".run-metrics");
  await expect(budget).toContainText("ESTIMATED COST$0.0000");
  await expect(budget).toContainText("SPENDING LIMIT$2.5");
  await expect(budget).toContainText(/Version [a-f0-9]{12}/);
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Completed", { timeout: 15_000 });
  await expect(budget).toContainText("REPORTED COST$0.0000");
});

test("manual block editing is reviewed before applying and preserves existing workflow snapshots", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("What should we work on?").fill("Library snapshot protection");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
  const runs = await (await request.get("/api/runs")).json();
  const id = runs.find((run: { task: string }) => run.task === "Library snapshot protection").id;
  const oldRun = await (await request.get(`/api/runs/${id}`)).json();
  const originalPrompt = oldRun.blocks.review.prompt;
  await settings(page, "Blocks");
  await page.getByRole("button", { name: /Independent review/ }).click();
  const instructions = "Read each acceptance criterion and inspect independent evidence. Report concrete defects.";
  await page.getByLabel("Block instructions", { exact: true }).fill(instructions);
  expect((await (await request.get("/api/project")).json()).blocks.review.prompt).toBe(originalPrompt);
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(page.getByText(/Block saved. New workflows/)).toBeVisible();
  expect((await (await request.get("/api/project")).json()).blocks.review.prompt).toBe(instructions);
  expect((await (await request.get(`/api/runs/${id}`)).json()).blocks.review.prompt).toBe(originalPrompt);
  await page.reload();
  await newTask(page, "Updated library consumer");
  await expect(page.locator(".task-request > p")).toHaveText("Updated library consumer");
  const updatedRuns = await (await request.get("/api/runs")).json();
  const newId = updatedRuns.find((run: { task: string }) => run.task === "Updated library consumer").id;
  expect((await (await request.get(`/api/runs/${newId}`)).json()).blocks.review.prompt).toBe(instructions);
});

test("unsaved graph edits block approval and survive switching between runs", async ({ page }) => {
  let streams = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/stream") { streams++; } });
  await page.goto("/");
  for (const task of ["Preserve edits first", "Preserve edits second"]) {
    await newTask(page, task);
    await expect(page.locator(".task-request > p")).toHaveText(task);
  }
  await page.getByRole("button", { name: "Edit workflow", exact: true }).click();
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  const editor = page.getByLabel("Workflow graph JSON");
  const plan = JSON.parse(await editor.inputValue());
  plan.title = "Unsaved title that must survive";
  await editor.fill(JSON.stringify(plan, null, 2));
  await expect(page.getByRole("button", { name: "Approve & start", exact: true })).toBeDisabled();
  await page.locator(".task-item").filter({ hasText: "Preserve edits first" }).click();
  await expect(page.locator(".task-request > p")).toHaveText("Preserve edits first");
  await expect(page.getByRole("button", { name: "Approve & start", exact: true })).toBeEnabled();
  await page.locator(".task-item").filter({ hasText: "Preserve edits second" }).click();
  await expect(page.locator(".task-request > p")).toHaveText("Preserve edits second");
  await page.getByRole("button", { name: "Edit workflow", exact: true }).click();
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await expect(editor).toHaveValue(/Unsaved title that must survive/);
  await expect(page.getByRole("button", { name: "Approve & start", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Validate & save draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: plan.title })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve & start", exact: true })).toBeEnabled();
  expect(streams).toBe(1);
});

test("step controls validate edits, preview the graph and save model and handoff choices", async ({ page, request }) => {
  await page.route("**/api/models", (route) => route.fulfill({ json: { warnings: [], models: [{
    provider: "openai", id: "test-step-model", name: "Test step model", reasoning: true,
    thinkingLevels: ["off", "high"], contextWindow: 128000, maxTokens: 8000, cost: null,
  }] } }));
  await page.goto("/");
  await page.getByLabel("What should we work on?").fill("Structured workflow editor regression");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
  await page.getByRole("button", { name: "Edit workflow", exact: true }).click();
  const title = page.getByLabel("Workflow title", { exact: true });
  await title.fill("");
  await expect(title).toBeVisible();
  await expect(page.locator(".validation-error")).toContainText("title");
  await expect(page.getByRole("button", { name: "Validate & save draft", exact: true })).toBeDisabled();
  await title.fill("Reviewed with step controls");
  await page.getByLabel("Step name", { exact: true }).fill("Prepare a focused change");
  await page.getByLabel("Step goal", { exact: true }).fill("Identify the smallest safe implementation.");
  await page.getByLabel("Maximum visits", { exact: true }).fill("2");
  await page.getByLabel("Step model", { exact: true }).selectOption("openai/test-step-model");
  await expect(page.getByLabel("Step thinking", { exact: true })).toHaveValue("off");
  await page.getByLabel("Step thinking", { exact: true }).selectOption("high");
  await page.getByLabel("On retry", { exact: true }).selectOption("prepare");
  await page.getByRole("button", { name: "Add handoff", exact: true }).click();
  await page.getByLabel("Source step 1", { exact: true }).selectOption("review");
  await page.getByLabel("Artifact 1", { exact: true }).selectOption("feedback");
  await page.getByLabel("Input alias 1", { exact: true }).fill("previous-feedback");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect(page.locator(".vue-flow__node[data-id='prepare']")).toContainText("Prepare a focused change");
  await expect(page.locator(".graph-legend")).toContainText("Unsaved preview");
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve & start", exact: true })).toBeDisabled();
  await page.getByLabel("On pass", { exact: true }).selectOption("$complete");
  await expect(page.locator(".validation-error")).toContainText("reachable");
  await expect(page.getByRole("button", { name: "Validate & save draft", exact: true })).toBeDisabled();
  await page.getByLabel("On pass", { exact: true }).selectOption("work");
  await expect(page.locator(".validation-error")).toHaveCount(0);
  await page.getByRole("button", { name: "Validate & save draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reviewed with step controls", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve & start", exact: true })).toBeEnabled();

  const runs = await (await request.get("/api/runs")).json();
  const id = runs.find((run: { title: string }) => run.title === "Reviewed with step controls").id;
  const saved = await (await request.get(`/api/runs/${id}`)).json();
  expect(saved.plan.nodes[0]).toMatchObject({ label: "Prepare a focused change", maxVisits: 2,
    agent: { provider: "openai", model: "test-step-model", thinking: "high" },
    inputs: [{ node: "review", artifact: "feedback", as: "previous-feedback", required: false }],
  });
  await page.locator(".details-panel").screenshot({ path: "/tmp/workflow-step-editor-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".details-panel").screenshot({ path: "/tmp/workflow-step-editor-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  const json = page.getByLabel("Workflow graph JSON");
  await expect(json).toHaveValue(/previous-feedback/);
  await json.fill("{");
  await page.getByRole("button", { name: "Step controls", exact: true }).click();
  await expect(json).toHaveValue("{");
  await expect(page.locator(".validation-error")).toContainText("JSON");
  await page.getByRole("button", { name: "Discard graph edits", exact: true }).click();
  await expect(title).toHaveValue("Reviewed with step controls");
});

test("a stale list response cannot undo a saved title in the run list", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("What should we work on?").fill("Run list revision regression");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.locator(".task-request > p")).toHaveText("Run list revision regression");
  const staleList = await (await request.get("/api/runs")).json();
  let staleResponses = 0;
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() === "GET") { staleResponses++; await route.fulfill({ json: staleList }); }
    else { await route.continue(); }
  });
  await page.getByRole("button", { name: "Edit workflow", exact: true }).click();
  await page.getByLabel("Workflow title", { exact: true }).fill("Saved title must survive");
  await page.getByRole("button", { name: "Validate & save draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Saved title must survive", exact: true })).toBeVisible();
  await expect.poll(() => staleResponses).toBeGreaterThan(0);
  await expect(page.locator(".task-item.selected strong")).toHaveText("Saved title must survive");
});

test("a remote draft edit preserves local text and requires reviewing the latest version", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("What should we work on?").fill("Concurrent browser graph review");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.locator(".task-request > p")).toHaveText("Concurrent browser graph review");
  await page.getByRole("button", { name: "Edit workflow", exact: true }).click();
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  const editor = page.getByLabel("Workflow graph JSON");
  const plan = JSON.parse(await editor.inputValue());
  const runs = await (await request.get("/api/runs")).json();
  const id = runs.find((run: { task: string }) => run.task === plan.task).id;
  await editor.fill(JSON.stringify({ ...plan, title: "Local unsaved change" }, null, 2));
  const remote = await request.put(`/api/runs/${id}/plan`, { headers: { "x-workflow-client": "1" }, data: { ...plan, title: "Remote saved change" } });
  expect(remote.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Remote saved change" })).toBeVisible();
  await expect(editor).toHaveValue(/Local unsaved change/);
  await expect(page.getByRole("button", { name: "Validate & save draft", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Discard edits & load latest draft", exact: true }).click();
  await expect(editor).toHaveValue(/Remote saved change/);
  await expect(page.getByRole("button", { name: "Approve & start", exact: true })).toBeEnabled();
});

test("browser setup completes ChatGPT sign-in, saves a project model, and supports API-key cancellation", async ({ page, request }) => {
  await page.goto("/");
  await settings(page);
  await expect(page.getByRole("heading", { name: "Providers & models", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
  const link = page.getByRole("link", { name: "Open ChatGPT sign-in" });
  await expect(link).toHaveAttribute("href", "https://auth.openai.com/test-sign-in");
  await page.reload();
  await settings(page);
  await expect(link).toBeVisible();
  await page.getByLabel("Paste test callback", { exact: true }).fill("test-callback");
  await page.getByRole("button", { name: "Continue sign-in", exact: true }).click();
  await expect(page.getByText("ChatGPT connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with ChatGPT", exact: true })).toHaveCount(0);
  await expect(link).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("ChatGPT connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with ChatGPT", exact: true })).toHaveCount(0);
  await expect(page.locator(".provider-list")).toContainText("OpenAI");
  await page.getByLabel("Model", { exact: true }).selectOption("openai/test-model");
  await page.getByLabel("Thinking level", { exact: true }).selectOption("high");
  await page.getByRole("button", { name: "Save project model", exact: true }).click();
  await expect(page.locator(".setup-notice")).toContainText("Project defaults saved");
  const project = await (await request.get("/api/project")).json();
  expect(project.config.agent).toMatchObject({ provider: "openai", model: "test-model", thinking: "high" });
  await page.getByText("Use an API key", { exact: true }).click();
  await page.getByLabel("API-key provider", { exact: true }).selectOption("test");
  await page.getByRole("button", { name: "Connect with API key", exact: true }).click();
  const key = page.getByLabel("Enter test API key", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("test-value-not-submitted");
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(page.getByLabel("Provider sign-in")).toContainText("cancelled");
  await expect(key).toHaveCount(0);
  await page.getByRole("button", { name: "Connect with API key", exact: true }).click();
  await key.fill("test-only-submitted-key");
  await page.getByRole("button", { name: "Continue sign-in", exact: true }).click();
  await expect(page.locator(".provider-list")).toContainText("Test provider");
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await page.getByRole("button", { name: "Disconnect Test provider", exact: true }).click();
  await expect(page.locator(".provider-list")).not.toContainText("Test provider");
  await expect(page.getByLabel("Provider sign-in")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/workflow-setup-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".task-sidebar")).toBeHidden();
  await page.screenshot({ path: "/tmp/workflow-setup-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Use shared defaults", exact: true }).click();
});

test("the central composer accepts attachments, runs automatically, and works on mobile", async ({ page, request }) => {
  const original = await (await request.get("/api/settings/orchestration")).json();
  const automatic = await request.put("/api/settings/orchestration", { headers: { "x-workflow-client": "1" }, data: { ...original, settings: { ...original.settings, approval: "automatic" } } });
  expect(automatic.ok()).toBe(true);
  try {
    await page.goto("/");
    await page.screenshot({ path: "/tmp/workflow-redesign-home-desktop.png", fullPage: true });
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/workflow-redesign-home-mobile.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close navigation", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel("Attach files", { exact: true }).setInputFiles({ name: "requirements.md", mimeType: "text/markdown", buffer: Buffer.from("Keep the task interface simple.") });
    await expect(page.locator(".attachment-tray")).toContainText("requirements.md");
    const composer = page.getByLabel("What should we work on?", { exact: true });
    await composer.fill("Implement the attached requirements");
    await composer.press("Enter");
    await expect(page.locator(".working-card")).toBeVisible();
    await page.screenshot({ path: "/tmp/workflow-redesign-working.png", fullPage: true });
    await expect(page.locator(".status-pill")).toHaveText("Completed", { timeout: 15000 });
    await expect(page.locator(".request-attachments")).toContainText("requirements.md");
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(page.locator(".activity")).toContainText("DEMO simulation");
    const taskId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("task");
    const detail = await (await request.get(`/api/tasks/${taskId}`)).json();
    expect(detail.attachments[0].name).toBe("requirements.md");
    await page.reload();
    await expect(page.locator(".status-pill")).toHaveText("Completed");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Search tasks", { exact: true }).fill("attached requirements");
    await expect(page.locator(".task-item")).toHaveCount(1);
  } finally {
    const current = await (await request.get("/api/settings/orchestration")).json();
    await request.put("/api/settings/orchestration", { headers: { "x-workflow-client": "1" }, data: { ...current, settings: original.settings } });
  }
});

test("settings manages described models, task cases, skills and enabled MCP connections", async ({ page, request }) => {
  await page.goto("/");
  await settings(page, "Task instructions");
  await page.getByRole("button", { name: "Add task case", exact: true }).click();
  await page.getByLabel("Case name", { exact: true }).last().fill("Release check");
  await page.getByLabel("When does this case apply?", { exact: true }).last().fill("The user asks to prepare a release.");
  await page.getByLabel("Instructions for this case", { exact: true }).last().fill("Inspect changelog and test evidence. Do not publish automatically.");
  page.once("dialog", (dialog) => { void dialog.dismiss(); });
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Model profiles", exact: true }).click();
  await page.getByRole("button", { name: "Add model profile", exact: true }).click();
  await page.getByLabel("Profile name", { exact: true }).fill("Careful reviewer");
  await page.getByLabel("When should this model be used?", { exact: true }).fill("Use for complex changes, diagnosis and independent review.");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/workflow-redesign-profiles.png", fullPage: true });
  await page.getByRole("button", { name: "Skills & MCP", exact: true }).click();
  await page.getByRole("button", { name: "Add skill", exact: true }).click();
  await page.getByLabel("Skill name", { exact: true }).fill("Project conventions");
  await page.getByLabel("Skill instructions", { exact: true }).fill("Follow the existing project patterns and explain material changes.");
  await page.getByRole("button", { name: "Add MCP server", exact: true }).click();
  await page.getByLabel("MCP server name", { exact: true }).fill("Project tools");
  await page.route("**/api/settings/mcp/inspect", (route) => route.fulfill({ json: { tools: [{ name: "inspect", description: "Inspect project context", readOnly: true }, { name: "publish", description: "Publish a release", readOnly: false }] } }));
  await page.getByRole("button", { name: "Connect & discover tools", exact: true }).click();
  await expect(page.locator(".mcp-tools")).toContainText("inspect");
  await expect(page.locator(".mcp-tools")).toContainText("publish");
  await page.getByLabel("Enable Project tools", { exact: true }).check();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
  const stored = (await (await request.get("/api/settings/orchestration")).json()).settings;
  expect(stored.profiles[0].description).toContain("independent review");
  expect(stored.cases.at(-1).name).toBe("Release check");
  expect(stored.capabilities.mcpServers[0].tools).toEqual(["inspect", "publish"]);
  expect(stored.capabilities.mcpServers[0].enabled).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/workflow-redesign-capabilities-mobile.png", fullPage: true });
});

test("block form preserves multiline edits and warns before discarding them", async ({ page, request }) => {
  await page.goto("/");
  await settings(page, "Blocks");
  await page.getByRole("button", { name: "Add block", exact: true }).click();
  await page.getByLabel("Block name", { exact: true }).fill("Read-only audit");
  const outputs = page.getByLabel("Output artifacts", { exact: true });
  await outputs.fill("findings,");
  await outputs.pressSequentially("evidence");
  await expect(outputs).toHaveValue("findings, evidence");
  page.once("dialog", (dialog) => { void dialog.dismiss(); });
  await page.getByRole("button", { name: "Execution", exact: true }).click();
  await expect(page.getByLabel("Block name", { exact: true })).toHaveValue("Read-only audit");
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(page.getByText(/Block saved. New workflows/)).toBeVisible();
  // Vue's mutable edit buffer must stay separate from the saved baseline.
  const blockId = await page.getByLabel("Block ID", { exact: true }).inputValue();
  const instructions = page.getByLabel("Block instructions", { exact: true });
  const savedInstructions = await instructions.inputValue();
  await instructions.fill("A second edit after saving");
  await expect(page.getByRole("button", { name: "Save block", exact: true })).toBeEnabled();
  expect((await (await request.get("/api/library")).json()).blocks[blockId].prompt).toBe(savedInstructions);
  page.once("dialog", (dialog) => { void dialog.dismiss(); });
  await page.getByRole("button", { name: "Execution", exact: true }).click();
  await expect(instructions).toHaveValue("A second edit after saving");
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  // The button is also disabled while saving; wait for the persisted result.
  await expect.poll(async () => (await (await request.get("/api/library")).json()).blocks[blockId].prompt).toBe("A second edit after saving");
  await expect(page.getByRole("button", { name: "Save block", exact: true })).toBeDisabled();
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await page.getByRole("button", { name: "Remove block", exact: true }).click();
  await expect(page.locator(".block-catalog")).not.toContainText("Read-only audit");
});

test("an essential follow-up stays inside the task workspace and resumes planning", async ({ page }) => {
  const now = new Date().toISOString();
  let task = { id: "2d8a79b8-a718-47b4-8496-a9827f221de5", createdAt: now, updatedAt: now, revision: 1, status: "needs_input", prompt: "Integrate the service", attachments: [], answers: [] as { question: string; answer: string }[], approval: "review", suggestedBlocks: [], events: [], question: { question: "Which service should be integrated?", options: ["Internal service", "Public service"] } };
  await page.route("**/api/tasks", async (route) => { await route.fulfill({ status: route.request().method() === "POST" ? 202 : 200, json: route.request().method() === "POST" ? task : [task] }); });
  await page.route(`**/api/tasks/${task.id}`, (route) => route.fulfill({ json: task }));
  await page.route(`**/api/tasks/${task.id}/answer`, async (route) => {
    const answer = route.request().postDataJSON();
    expect(answer).toEqual({ answer: "Internal service", revision: 1 });
    task = { ...task, revision: 2, status: "planning", answers: [{ question: task.question.question, answer: answer.answer }] };
    await route.fulfill({ json: task });
  });
  await page.goto("/");
  await page.getByLabel("What should we work on?", { exact: true }).fill(task.prompt);
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.getByRole("heading", { name: "One detail before we start", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Internal service", exact: true }).click();
  await page.getByRole("button", { name: "Continue planning", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Building your workflow", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue planning", exact: true })).toHaveCount(0);
});

async function ensureDesignConnection(request: APIRequestContext) {
  if ((await (await request.get("/api/models")).json()).models.some((model: { provider: string }) => model.provider === "openai")) { return; }
  const headers = { "x-workflow-client": "1" };
  let session = (await (await request.post("/api/auth/session", { headers, data: { provider: "openai", method: "oauth" } })).json());
  for (let count = 0; count < 30 && !session.prompt; count++) { session = await (await request.get("/api/auth/session", { headers })).json(); }
  expect(session.prompt).toBeTruthy();
  expect((await request.post(`/api/auth/session/${session.id}/respond`, { headers, data: { promptId: session.prompt.id, value: "test-only-callback" } })).ok()).toBe(true);
  await expect.poll(async () => (await (await request.get("/api/models")).json()).models.length).toBeGreaterThan(0);
}

test("changing and clearing a block model profile preserves its saved execution limits", async ({ page, request }) => {
  await ensureDesignConnection(request);
  const headers = { "x-workflow-client": "1" };
  const original = await (await request.get("/api/settings/orchestration")).json();
  const profiles = [
    { id: "limits-reviewer", name: "Limits reviewer", description: "Independent review", enabled: true, agent: { provider: "openai", model: "test-model", thinking: "high" } },
    { id: "limits-helper", name: "Limits helper", description: "Routine inspection", enabled: true, agent: { provider: "openai", model: "test-model", thinking: "off" } },
  ];
  const allProfiles = [...original.settings.profiles, ...profiles];
  expect((await request.put("/api/settings/orchestration", { headers, data: {
    ...original, settings: { ...original.settings, profiles: allProfiles, coordinatorProfile: profiles[0]!.id },
  } })).ok()).toBe(true);
  const library = await (await request.get("/api/library")).json();
  const bundle = structuredClone(library.blocks.review);
  bundle.definition.id = "profile-limits";
  bundle.definition.name = "Profile limits regression";
  bundle.definition.agent = { ...profiles[0]!.agent, timeoutMs: 10000, maxToolCalls: 2 };
  const proposal = await request.post("/api/library/proposals", { headers, data: {
    kind: "manual", baseHash: library.revision,
    changes: { summary: "Exercise block limits", blocks: [{ bundle, rationale: "Regression fixture" }] },
  } });
  expect(proposal.ok()).toBe(true);
  const id = (await proposal.json()).id;
  expect((await request.post(`/api/library/proposals/${id}/apply`, { headers })).ok()).toBe(true);
  try {
    await page.goto("/");
    await settings(page, "Blocks");
    await page.getByRole("button", { name: /Profile limits regression/ }).click();
    const selector = page.getByLabel("Preferred model profile", { exact: true });
    // Limits must not prevent recognizing the current model profile.
    await expect(selector).toHaveValue("limits-reviewer");
    await selector.selectOption("limits-helper");
    await page.getByRole("button", { name: "Save block", exact: true }).click();
    await expect(page.getByText(/Block saved. New workflows/)).toBeVisible();
    expect((await (await request.get("/api/library")).json()).blocks["profile-limits"].definition.agent).toEqual({
      ...profiles[1]!.agent, timeoutMs: 10000, maxToolCalls: 2,
    });
    await selector.selectOption("");
    await page.getByRole("button", { name: "Save block", exact: true }).click();
    await expect.poll(async () => (await (await request.get("/api/library")).json()).blocks["profile-limits"].definition.agent).toEqual({
      timeoutMs: 10000, maxToolCalls: 2,
    });
    await expect(page.getByRole("button", { name: "Save block", exact: true })).toBeDisabled();
    expect((await (await request.get("/api/settings/orchestration")).json()).settings.profiles).toEqual(allProfiles);
    await page.reload();
    await settings(page, "Blocks");
    await page.getByRole("button", { name: /Profile limits regression/ }).click();
    await expect(selector).toHaveValue("");
  } finally {
    const current = await (await request.get("/api/settings/orchestration")).json();
    expect((await request.put("/api/settings/orchestration", { headers, data: { ...current, settings: original.settings } })).ok()).toBe(true);
    const currentLibrary = await (await request.get("/api/library")).json();
    expect((await request.delete("/api/library/blocks/profile-limits", { headers, data: { revision: currentLibrary.revision } })).ok()).toBe(true);
  }
});

test("AI settings chat generates profiles, refines with context, reviews before applying and resumes after reload", async ({ page, request }) => {
  await ensureDesignConnection(request);
  const original = await (await request.get("/api/settings/orchestration")).json();
  const pageErrors: string[] = []; page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await settings(page, "Model profiles");
  await page.getByRole("button", { name: /^(Generate|Regenerate) with AI$/ }).click();
  const chat = page.getByRole("dialog", { name: "Design model profiles with AI", exact: true });
  await expect(chat).toBeVisible();
  const input = chat.getByLabel("Message AI designer", { exact: true });
  await expect(input).toHaveValue(/model profiles for this project/);
  await input.press("Enter");
  await expect(chat.getByText("Designing model profiles…", { exact: true })).toBeVisible();
  await expect(chat.getByRole("button", { name: "Apply changes", exact: true })).toBeEnabled();
  expect((await (await request.get("/api/settings/orchestration")).json()).settings.profiles).toEqual(original.settings.profiles);
  await input.fill("Use one profile and call it Project lead."); await input.press("Enter");
  await expect(chat.getByText("Refined the earlier proposal into one project lead profile.", { exact: true })).toBeVisible();
  await chat.getByText("Review proposed settings", { exact: true }).click();
  await expect(chat.getByText("Project lead", { exact: true })).toBeVisible();
  await expect(chat.locator(".design-preview small")).toContainText("planning model");
  await page.screenshot({ path: "/tmp/workflow-mocha-design-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(chat).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/workflow-mocha-design-mobile.png", fullPage: true });
  await chat.getByRole("button", { name: "Minimize design chat", exact: true }).click();
  await expect(chat).toHaveCount(0);
  const saveBounds = await page.getByRole("button", { name: "Save settings", exact: true }).boundingBox();
  const launcherBounds = await page.getByLabel("Design chats").boundingBox();
  expect(saveBounds && launcherBounds && saveBounds.y + saveBounds.height < launcherBounds.y).toBe(true);
  await page.screenshot({ path: "/tmp/workflow-mocha-design-minimized-mobile.png", fullPage: true });
  await page.getByLabel("Design chats").getByRole("button", { name: "Model profiles", exact: true }).click();
  await expect(chat).toContainText("Use one profile and call it Project lead.");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Model profiles", exact: true }).click();
  await page.getByRole("button", { name: "Design with AI", exact: true }).click();
  await expect(chat.getByText("One profile for project leadership", { exact: true })).toBeVisible();
  let release!: () => void; let received!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/api/design/*/apply", async (route) => { const response = await route.fetch(); received(); await gate; await route.fulfill({ response }); });
  try {
    await chat.getByRole("button", { name: "Apply changes", exact: true }).click();
    await started;
    await expect(page.getByLabel("Planning model", { exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(chat.getByText("Changes applied", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Profile name", { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("Profile name", { exact: true })).toHaveValue("Project lead");
  await expect(page.getByLabel("Planning model", { exact: true })).toHaveValue("project-lead");
  const saved = (await (await request.get("/api/settings/orchestration")).json()).settings;
  expect(saved.profiles).toHaveLength(1); expect(saved.cases).toEqual(original.settings.cases);
  expect(pageErrors).toEqual([]);
});

test("AI blocks chat applies reviewed instructions and blocks applying over unsaved form edits", async ({ page, request }) => {
  await ensureDesignConnection(request);
  const before = await (await request.get("/api/project")).json();
  await page.goto("/"); await settings(page, "Blocks");
  await page.getByRole("button", { name: "Design with AI", exact: true }).click();
  const chat = page.getByRole("dialog", { name: "Design blocks with AI", exact: true });
  const instructions = "Review acceptance criteria and cite exact files for every finding. Keep review separate from implementation.";
  await chat.getByLabel("Message AI designer", { exact: true }).fill(instructions);
  await chat.getByRole("button", { name: "Send to AI designer", exact: true }).click();
  const apply = chat.getByRole("button", { name: "Apply changes", exact: true });
  await expect(apply).toBeEnabled();
  expect((await (await request.get("/api/project")).json()).blocks.review.prompt).toBe(before.blocks.review.prompt);
  await chat.getByText("Review proposed settings", { exact: true }).click();
  await expect(chat.getByText("Review should cite independent acceptance evidence", { exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "Minimize design chat", exact: true }).click();
  await page.getByRole("button", { name: /Independent review/ }).click();
  await page.getByLabel("Block instructions", { exact: true }).fill("Unsaved manual review instructions");
  await page.getByLabel("Design chats").getByRole("button", { name: "Blocks", exact: true }).click();
  await expect(apply).toBeDisabled();
  await expect(chat.getByText(/Save or discard your form edits/)).toBeVisible();
  await chat.getByRole("button", { name: "Minimize design chat", exact: true }).click();
  await page.getByLabel("Block instructions", { exact: true }).fill(before.blocks.review.prompt);
  await page.getByLabel("Design chats").getByRole("button", { name: "Blocks", exact: true }).click();
  await expect(apply).toBeEnabled(); await apply.click();
  await expect(chat.getByText("Changes applied", { exact: true })).toBeVisible();
  expect((await (await request.get("/api/project")).json()).blocks.review.prompt).toBe(instructions);
  await chat.getByRole("button", { name: "Minimize design chat", exact: true }).click();
  await page.getByRole("button", { name: /Independent review/ }).click();
  await expect(page.getByLabel("Block instructions", { exact: true })).toHaveValue(instructions);
});

test("AI design scopes keep distinct conversations and can configure cases, skills and execution", async ({ page, request }) => {
  await ensureDesignConnection(request);
  await page.goto("/"); await settings(page, "Task instructions");
  for (const [tab, label, prompt] of [
    ["Task instructions", "task instructions", "For release readiness, inspect tests and changelog. Do not publish."],
    ["Skills & MCP", "skills & mcp", "Prefer existing TypeScript conventions and focused changes."],
    ["Execution", "execution settings", "Limit each workflow to 15 steps."],
  ]) {
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: tab, exact: true }).click();
    await page.getByRole("button", { name: "Design with AI", exact: true }).click();
    const chat = page.getByRole("dialog", { name: `Design ${label} with AI`, exact: true });
    await chat.getByLabel("Message AI designer", { exact: true }).fill(prompt!);
    await chat.getByRole("button", { name: "Send to AI designer", exact: true }).click();
    await expect(chat.getByRole("button", { name: "Apply changes", exact: true })).toBeEnabled();
    await chat.getByRole("button", { name: "Apply changes", exact: true }).click();
    await expect(chat.getByText("Changes applied", { exact: true })).toBeVisible();
    await chat.getByRole("button", { name: "Minimize design chat", exact: true }).click();
  }
  const saved = (await (await request.get("/api/settings/orchestration")).json()).settings;
  expect(saved.cases.find((item: { id: string }) => item.id === "release-ai").instructions).toContain("Do not publish");
  expect(saved.capabilities.skills.find((item: { id: string }) => item.id === "conventions-ai").content).toContain("TypeScript");
  expect((await (await request.get("/api/settings/execution")).json()).maxSteps).toBe(15);
  await page.getByLabel("Design chats").getByRole("button", { name: "Task instructions", exact: true }).click();
  const chat = page.getByRole("dialog", { name: "Design task instructions with AI", exact: true });
  await expect(chat).toContainText("For release readiness, inspect tests and changelog.");
  await expect(chat).not.toContainText("Prefer existing TypeScript conventions");
  await chat.getByLabel("Message AI designer", { exact: true }).fill("Explain what the proposal changed.");
  await chat.getByRole("button", { name: "Send to AI designer", exact: true }).click();
  await expect(chat.getByText("The proposal uses your connected catalog and preserves the other settings sections.", { exact: true })).toBeVisible();
  await expect(chat.getByRole("button", { name: "Apply changes", exact: true })).toHaveCount(0);
});

test("graph blocks can be arranged and keep their positions through execution and reload", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/"); await newTask(page, "Drag the graph for this bug review");
  const node = page.locator(".vue-flow__node[data-id='work']");
  await expect(node).toBeVisible();
  const before = await node.evaluate(element => (element as HTMLElement).style.transform);
  const box = await node.boundingBox(); expect(box).toBeTruthy();
  await page.mouse.move(box!.x + 90, box!.y + 35); await page.mouse.down();
  await page.mouse.move(box!.x + 230, box!.y - 30, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => node.evaluate(element => (element as HTMLElement).style.transform)).not.toBe(before);
  const arranged = await node.evaluate(element => (element as HTMLElement).style.transform);
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await expect(page.locator(".vue-flow__node.active")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Focus active step", exact: true })).toBeVisible();
  await expect(page.locator(".status-pill")).toHaveText("Completed", { timeout: 15_000 });
  await expect.poll(() => node.evaluate(element => (element as HTMLElement).style.transform)).toBe(arranged);
  await page.reload(); await expect(page.locator(".status-pill")).toHaveText("Completed");
  await expect.poll(() => node.evaluate(element => (element as HTMLElement).style.transform)).toBe(arranged);
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await expect.poll(() => node.evaluate(element => (element as HTMLElement).style.transform)).not.toBe(arranged);
});

test("failed results are prominent, safely render Markdown and support copying and artifact downloads", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const remoteImages: string[] = [];
  page.on("request", request => { if (request.url().includes("example.invalid")) remoteImages.push(request.url()); });
  await page.goto("/"); await newTask(page, "Review this bug [result-fixture]");
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Failed", { timeout: 15_000 });
  await expect(page.locator(".result-banner")).toContainText("Branch review blocked");
  await expect(page.locator(".notification-toast")).toContainText("FAILED");
  await page.getByRole("button", { name: /View full results/ }).click();
  const result = page.locator(".result-artifact").first();
  await expect(result.getByRole("heading", { name: "Review status: blocked", exact: true })).toBeVisible();
  await expect(result.locator("table th")).toHaveText(["Check", "Result"]);
  await expect(result.locator("pre code")).toHaveText("const reviewed = false;\n");
  await expect(result.locator("script, img, iframe, a[href^='javascript:']")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).markdownInjected)).toBeUndefined();
  expect(remoteImages).toEqual([]);
  await result.getByRole("button", { name: "Copy Markdown", exact: true }).click();
  await expect(result.getByText("Markdown copied", { exact: true })).toHaveCount(1);
  const markdown = await page.evaluate(() => navigator.clipboard.readText());
  expect(markdown).toContain("## Review status: blocked"); expect(markdown).toContain("| Check | Result |");
  const downloadPromise = page.waitForEvent("download");
  await result.getByRole("button", { name: "Download Markdown", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("review-feedback.md");
  const { readFile } = await import("node:fs/promises");
  expect(await readFile((await download.path())!, "utf8")).toBe(markdown);
  const width = (await page.locator(".task-content").boundingBox())!.width;
  expect(width).toBeGreaterThan(1400);
  await page.screenshot({ path: "/tmp/workflow-results-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/workflow-results-mobile.png", fullPage: true });
});

test("same-scope AI chats stay independent, draggable and restorable", async ({ page, request }) => {
  await ensureDesignConnection(request);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto("/"); await settings(page, "Blocks");
  await page.getByRole("button", { name: "Design with AI", exact: true }).click();
  const dialogs = page.getByRole("dialog", { name: "Design blocks with AI", exact: true });
  await expect(dialogs).toHaveCount(1);
  const firstId = await dialogs.first().getAttribute("id");
  const first = page.locator(`#${firstId}`);
  const start = (await first.boundingBox())!;
  const header = (await first.locator("header").boundingBox())!;
  await page.mouse.move(header.x + 100, header.y + 20); await page.mouse.down();
  await page.mouse.move(350, header.y + 40, { steps: 10 }); await page.mouse.up();
  expect((await first.boundingBox())!.x).toBeLessThan(start.x - 200);
  await first.getByLabel("Message AI designer", { exact: true }).fill("Independent conversation A: review carefully.");
  await first.getByRole("button", { name: "Send to AI designer", exact: true }).click();
  await first.getByRole("button", { name: "New design conversation", exact: true }).click();
  await expect(dialogs).toHaveCount(2);
  const second = dialogs.filter({ hasNot: page.locator(`#${firstId}`) }).last();
  const secondId = await second.getAttribute("id"); expect(secondId).not.toBe(firstId);
  await second.getByLabel("Message AI designer", { exact: true }).fill("Independent conversation B: summarize changes.");
  await second.getByRole("button", { name: "Send to AI designer", exact: true }).click();
  await expect(first.getByRole("button", { name: "Apply changes", exact: true })).toBeEnabled();
  await expect(second.getByRole("button", { name: "Apply changes", exact: true })).toBeEnabled();
  await expect(first).toContainText("Independent conversation A"); await expect(first).not.toContainText("Independent conversation B");
  await expect(second).toContainText("Independent conversation B"); await expect(second).not.toContainText("Independent conversation A");
  await first.getByLabel("Message AI designer", { exact: true }).fill("Unsent follow-up A");
  await first.getByRole("button", { name: "Minimize design chat", exact: true }).click();
  await expect(first).toBeHidden(); await expect(second).toBeVisible();
  await page.getByLabel("Design chats").getByRole("button", { name: "Blocks", exact: true }).click();
  await expect(first.getByLabel("Message AI designer", { exact: true })).toHaveValue("Unsent follow-up A");
  const position = (await first.boundingBox())!;
  await page.reload();
  await expect(page.locator(`#${firstId}`)).toBeVisible(); await expect(page.locator(`#${secondId}`)).toBeVisible();
  await expect(first.getByLabel("Message AI designer", { exact: true })).toHaveValue("Unsent follow-up A");
  expect((await first.boundingBox())!.x).toBeCloseTo(position.x, 0);
  await page.screenshot({ path: "/tmp/workflow-multiple-chats.png", fullPage: true });
});

test("activity is searchable, filters tools and checks, and retains raw failure evidence", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/"); await newTask(page, "Fix the regression [activity-fixture]");
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Completed", { timeout: 15_000 });
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("region", { name: "Workflow activity", exact: true });
  await activity.getByRole("button", { name: /^Tools/ }).click();
  await expect(activity.locator(".event")).toHaveCount(4);
  const command = activity.locator(".event.tool_start").filter({ hasText: "Run command" });
  await expect(command).toContainText("bun test --filter regression");
  await expect(command.locator("pre")).not.toBeVisible();
  await command.getByText("View details", { exact: true }).click();
  await expect(command.locator("pre")).toContainText('"timeout": 60');
  await expect(activity.locator(".event.tool_end.error")).toContainText("expected 5, received 4");
  await activity.getByLabel("Search activity", { exact: true }).fill("REGRESSION");
  await expect(activity.locator(".event")).toHaveCount(2);
  await activity.getByRole("button", { name: /^Checks/ }).click();
  await expect(activity.locator(".event")).toHaveCount(1);
  await activity.getByText("View details", { exact: true }).click();
  await expect(activity.locator("pre")).toContainText("Detailed diagnostic for regression");
  await activity.getByLabel("Search activity", { exact: true }).fill("");
  await activity.getByRole("button", { name: /^Usage/ }).click();
  await expect(activity).toContainText("2 requests · 1,500 tokens · $0.0123 reported");
  await activity.getByLabel("Activity step", { exact: true }).selectOption("review");
  await expect(activity).toContainText("No activity matches these filters.");
  await activity.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(activity.locator(".event")).not.toHaveCount(0);
  await activity.getByRole("button", { name: "Show all steps", exact: true }).click();
  await page.screenshot({ path: "/tmp/workflow-activity-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await activity.getByLabel("Search activity", { exact: true }).fill("src/example.ts");
  await expect(activity.locator(".event")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/workflow-activity-mobile.png", fullPage: true });
});

test("expanded workspaces keep graph context, search and draft edits with keyboard and mobile support", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/"); await newTask(page, "Fix the expanded workspace fixture bug");
  const normalGraph = page.locator(".graph-panel");
  await expect(normalGraph.locator(".vue-flow__node[data-id='work']")).toBeVisible();
  const originalHeight = (await normalGraph.boundingBox())!.height;
  await page.getByRole("button", { name: "Expand workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Expanded workflow workspace", exact: true });
  await expect(dialog).toBeVisible();
  expect((await dialog.boundingBox())!.width).toBeGreaterThan(1380);
  expect((await dialog.locator(".graph-panel").boundingBox())!.height).toBeGreaterThan(originalHeight + 150);
  await dialog.getByRole("button", { name: "Fit workflow", exact: true }).click();
  await dialog.locator(".vue-flow__node[data-id='work']").click();
  await expect(dialog.locator(".step-inspector")).toBeVisible();
  await expect.poll(async () => {
    const panel = (await dialog.locator(".graph-panel").boundingBox())!;
    const terminal = (await dialog.locator(".vue-flow__node[data-id='$failed']").boundingBox())!;
    return terminal.x >= panel.x && terminal.x + terminal.width <= panel.x + panel.width;
  }).toBe(true);
  await page.screenshot({ path: "/tmp/workflow-expanded-desktop.png", fullPage: true });
  await dialog.getByRole("button", { name: "Activity", exact: true }).click();
  await dialog.getByLabel("Search activity", { exact: true }).fill("Keep my search");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel("Search activity", { exact: true })).toHaveValue("Keep my search");
  await expect(page.getByLabel("Activity step", { exact: true })).toHaveValue("work");
  await expect(page.getByRole("button", { name: "Expand workspace", exact: true })).toBeFocused();

  await page.getByRole("button", { name: "Expand workspace", exact: true }).click();
  await expect(dialog.getByLabel("Search activity", { exact: true })).toHaveValue("Keep my search");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await dialog.getByRole("button", { name: "Editor", exact: true }).click();
  await dialog.getByRole("button", { name: "JSON", exact: true }).click();
  const editor = dialog.getByLabel("Workflow graph JSON", { exact: true });
  const edited = JSON.parse(await editor.inputValue()) as { title: string };
  edited.title = "Retained expanded graph edit";
  await editor.fill(JSON.stringify(edited, null, 2));
  await dialog.getByRole("button", { name: "Close expanded view", exact: true }).click();
  await expect(page.getByLabel("Workflow graph JSON", { exact: true })).toHaveValue(JSON.stringify(edited, null, 2));
  await page.getByRole("button", { name: "Discard graph edits", exact: true }).click();

  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileExpand = (await page.getByRole("button", { name: "Expand workspace", exact: true }).boundingBox())!;
  expect(mobileExpand.x + mobileExpand.width).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Expand workspace", exact: true }).click();
  await expect(dialog.locator(".step-inspector")).toBeVisible();
  await dialog.getByRole("button", { name: "Fit workflow", exact: true }).click();
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect((await dialog.getByRole("button", { name: "Results", exact: true }).boundingBox())!.x).toBeGreaterThan(0);
  await page.screenshot({ path: "/tmp/workflow-expanded-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
});

test("deleting a workflow removes its task from history and stale responses cannot restore it", async ({ page }) => {
  await page.goto("/"); await newTask(page, "Delete this draft from history");
  const originalHash = new URL(page.url()).hash;
  const before = await (await page.request.get("/api/tasks")).json();
  let waiting!: () => void;
  const received = new Promise<void>(resolve => { waiting = resolve; });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete workflow", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What should we work on?", exact: true })).toBeVisible();
  // Return the old snapshot on a later poll. Changing selection deliberately
  // aborts the old request, so holding that aborted route cannot exercise merging.
  await page.route("**/api/tasks", async route => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: before }); waiting();
  });
  await received;
  await expect(page.locator(".task-item").filter({ hasText: "Delete this draft from history" })).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
  await page.reload();
  await expect(page.locator(".task-item").filter({ hasText: "Delete this draft from history" })).toHaveCount(0);
  await page.goto(`/${originalHash}`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "What should we work on?", exact: true })).toBeVisible();
});

test("discard controls restore blocks, model defaults and settings without saving", async ({ page, request }) => {
  await ensureDesignConnection(request);
  await page.goto("/");
  await settings(page, "Blocks");
  const originalLibrary = await (await request.get("/api/library")).json();
  await page.getByRole("button", { name: "Add block", exact: true }).click();
  await page.getByLabel("Block name", { exact: true }).fill("Discard this new block");
  await page.getByRole("button", { name: "Design with AI", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Save or discard");
  await page.getByRole("button", { name: "Cancel new block", exact: true }).click();
  await expect(page.getByLabel("Block name", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Design with AI", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Design blocks with AI", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close design chat", exact: true }).click();
  await page.locator(".block-catalog button").filter({ hasText: "Independent review" }).click();
  const instructions = page.getByLabel("Block instructions", { exact: true });
  const before = await instructions.inputValue();
  await instructions.fill("Temporary instructions");
  await page.getByRole("button", { name: "Discard block changes", exact: true }).click();
  await expect(instructions).toHaveValue(before);
  expect(await (await request.get("/api/library")).json()).toEqual(originalLibrary);
  await page.getByRole("button", { name: "Providers & models", exact: true }).click();
  const model = page.getByLabel("Model", { exact: true });
  await expect(model).toBeEnabled();
  const savedModel = await model.inputValue();
  const thinking = page.getByLabel("Thinking level", { exact: true });
  const savedThinking = await thinking.inputValue();
  if (savedModel === "openai/test-model") await thinking.selectOption(savedThinking === "high" ? "off" : "high");
  else await model.selectOption("openai/test-model");
  await expect(page.getByRole("button", { name: "Discard all edits", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard model changes", exact: true }).click();
  await expect(model).toHaveValue(savedModel);
  await expect(thinking).toHaveValue(savedThinking);
  const originalSettings = await (await request.get("/api/settings/orchestration")).json();
  const originalExecution = await (await request.get("/api/settings/execution")).json();
  await page.getByRole("button", { name: "Task instructions", exact: true }).click();
  const name = page.getByLabel("Case name", { exact: true }).first();
  const savedName = await name.inputValue();
  await name.fill("Unsaved case");
  await page.getByRole("button", { name: "Model profiles", exact: true }).click();
  await page.getByRole("button", { name: "Add model profile", exact: true }).click();
  await page.getByRole("button", { name: "Discard settings changes", exact: true }).click();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Task instructions", exact: true }).click();
  await expect(name).toHaveValue(savedName);
  expect(await (await request.get("/api/settings/orchestration")).json()).toEqual(originalSettings);
  expect(await (await request.get("/api/settings/execution")).json()).toEqual(originalExecution);
});

test("a function block is configurable without a model or named command", async ({ page, request }) => {
  await page.goto("/"); await settings(page, "Blocks");
  await page.getByRole("button", { name: "Add block", exact: true }).click();
  await page.getByLabel("Execution", { exact: true }).selectOption("function");
  await expect(page.getByLabel("Function", { exact: true })).toHaveValue("git-push");
  await expect(page.getByLabel("Preferred model profile", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Command", { exact: true })).toHaveCount(0);
  await page.getByLabel("Block name", { exact: true }).fill("Publish without AI");
  await page.getByLabel("Git remote (optional)", { exact: true }).fill("origin");
  const id = await page.getByLabel("Block ID", { exact: true }).inputValue();
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(page.getByText(/Block saved. New workflows/)).toBeVisible();
  const saved = (await (await request.get("/api/library")).json()).blocks[id];
  expect(saved.definition.executor).toEqual({ kind: "function", function: "git-push", remote: "origin" });
  expect(saved.definition.agent).toBeUndefined();
  expect(saved.definition.outputs).toEqual(["publication"]);
  await page.screenshot({ path: "/tmp/workflow-function-block.png", fullPage: true });
});

test("multiline fields grow for typing and pasted text, cap height, and shrink after discard", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/"); await settings(page, "Blocks");
  await page.getByRole("button", { name: "Add block", exact: true }).click();
  const description = page.getByLabel("When should this block be used?", { exact: true });
  await description.fill("First line\nSecond line");
  const height = (await description.boundingBox())!.height;
  await description.press("End");
  await description.press("Enter");
  await description.pressSequentially("Third line");
  await expect.poll(async () => (await description.boundingBox())!.height).toBeGreaterThan(height + 10);
  const manyLines = Array.from({ length: 70 }, (_, index) => `Pasted line ${index}`).join("\n");
  await description.focus();
  await description.press("ControlOrMeta+A");
  await page.keyboard.insertText(manyLines);
  await expect.poll(() => description.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  expect((await description.boundingBox())!.height).toBeLessThan(400);
  expect(await description.evaluate(el => getComputedStyle(el).overflowY)).toBe("auto");
  await page.getByRole("button", { name: "Cancel new block", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const task = page.getByLabel("What should we work on?", { exact: true });
  const emptyHeight = (await task.boundingBox())!.height;
  await task.fill(manyLines);
  await expect.poll(async () => (await task.boundingBox())!.height).toBeGreaterThan(emptyHeight);
  await page.getByRole("button", { name: "Discard task draft", exact: true }).click();
  await expect(task).toHaveValue("");
  await expect.poll(async () => (await task.boundingBox())!.height).toBe(emptyHeight);
  expect(await page.evaluate(() => document.querySelectorAll("textarea:not([style*=height])").length)).toBe(0);
});

test("floating chats resize independently, retain dimensions and stay usable on small screens", async ({ page, request }) => {
  await ensureDesignConnection(request);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto("/"); await settings(page, "Blocks");
  await page.getByRole("button", { name: "Design with AI", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Design blocks with AI", exact: true });
  await expect(dialog).toBeVisible();
  const id = await dialog.getAttribute("id");
  const header = (await dialog.locator("header").boundingBox())!;
  await page.mouse.move(header.x + 80, header.y + 20); await page.mouse.down();
  await page.mouse.move(300, 70, { steps: 8 }); await page.mouse.up();
  const before = (await dialog.boundingBox())!;
  const corner = (await dialog.getByLabel("Resize chat from bottom right", { exact: true }).boundingBox())!;
  await page.mouse.move(corner.x + 10, corner.y + 10); await page.mouse.down();
  await page.mouse.move(corner.x + 210, corner.y + 90, { steps: 8 }); await page.mouse.up();
  const resized = (await dialog.boundingBox())!;
  expect(resized.width).toBeCloseTo(before.width + 200, 0);
  expect(resized.height).toBeCloseTo(before.height + 80, 0);
  await dialog.getByRole("button", { name: "New design conversation", exact: true }).click();
  const first = page.locator(`#${id}`);
  const all = page.getByRole("dialog", { name: "Design blocks with AI", exact: true });
  await expect(all).toHaveCount(2);
  expect((await all.last().boundingBox())!.width).toBe(440);
  await page.reload();
  await expect(first).toBeVisible();
  await expect.poll(async () => (await first.boundingBox())!.width).toBe(resized.width);
  expect((await first.boundingBox())!.height).toBe(resized.height);
  await all.last().getByRole("button", { name: "Close design chat", exact: true }).click();
  await first.getByLabel("Resize chat from bottom right", { exact: true }).press("ArrowRight");
  expect((await first.boundingBox())!.width).toBe(resized.width + 20);
  await page.setViewportSize({ width: 390, height: 700 });
  await expect.poll(async () => (await first.boundingBox())!.width).toBeLessThanOrEqual(366);
  const message = first.getByLabel("Message AI designer", { exact: true });
  await message.fill(Array.from({ length: 50 }, () => "A long design request").join("\n"));
  await expect.poll(() => message.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(first.getByRole("button", { name: "Send to AI designer", exact: true })).toBeInViewport();
  await first.getByRole("button", { name: "Discard message", exact: true }).click();
  await expect(message).toHaveValue("");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/workflow-resized-chat-mobile.png", fullPage: true });
});

test("chat resizing keeps the opposite edges fixed at minimum and viewport limits", async ({ page, request }) => {
  await ensureDesignConnection(request);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/"); await settings(page, "Blocks");
  await page.getByRole("button", { name: "Design with AI", exact: true }).click();
  const chat = page.getByRole("dialog", { name: "Design blocks with AI", exact: true });
  const header = (await chat.locator("header").boundingBox())!;
  await page.mouse.move(header.x + 80, header.y + 20); await page.mouse.down();
  await page.mouse.move(400, 70, { steps: 8 }); await page.mouse.up();
  const before = (await chat.boundingBox())!;
  const corner = (await chat.getByLabel("Resize chat from bottom left", { exact: true }).boundingBox())!;
  await page.mouse.move(corner.x + 8, corner.y + 8); await page.mouse.down();
  await page.mouse.move(corner.x + 320, corner.y + 8, { steps: 8 }); await page.mouse.up();
  const minimum = (await chat.boundingBox())!;
  expect(minimum.width).toBe(320);
  expect(minimum.x + minimum.width).toBeCloseTo(before.x + before.width, 0);
  expect(minimum.y).toBe(before.y);

  // Keyboard movement of the left edge follows the same direction as dragging.
  await chat.getByLabel("Resize chat from bottom left", { exact: true }).press("ArrowLeft");
  const wider = (await chat.boundingBox())!;
  expect(wider.width).toBe(340);
  expect(wider.x + wider.width).toBeCloseTo(before.x + before.width, 0);

  const right = (await chat.getByLabel("Resize chat from bottom right", { exact: true }).boundingBox())!;
  await page.mouse.move(right.x + 8, right.y + 8); await page.mouse.down();
  await page.mouse.move(1398, 998, { steps: 8 }); await page.mouse.up();
  const maximum = (await chat.boundingBox())!;
  expect(maximum.x).toBe(wider.x);
  expect(maximum.y).toBe(wider.y);
  expect(maximum.x + maximum.width).toBeLessThanOrEqual(1388);
  expect(maximum.y + maximum.height).toBeLessThanOrEqual(928);
});

test("an AI proposal can be discarded without applying and its conversation stays open", async ({ page, request }) => {
  await ensureDesignConnection(request);
  const before = await (await request.get("/api/library")).json();
  await page.goto("/"); await settings(page, "Blocks");
  await page.getByRole("button", { name: "Design with AI", exact: true }).click();
  const chat = page.getByRole("dialog", { name: "Design blocks with AI", exact: true });
  await chat.getByRole("button", { name: "New design conversation", exact: true }).click();
  // Creation is asynchronous: filling .last() before the new window exists
  // writes to the previous chat and then tries to send the new empty one.
  await expect(chat).toHaveCount(2);
  const current = chat.last();
  await current.getByLabel("Message AI designer", { exact: true }).fill("Inspect error cases in review");
  await current.getByRole("button", { name: "Send to AI designer", exact: true }).click();
  await current.getByRole("button", { name: "Discard proposal", exact: true }).click();
  await expect(current.getByRole("button", { name: "Apply changes", exact: true })).toHaveCount(0);
  await expect(current).toContainText("Inspect error cases in review");
  expect(await (await request.get("/api/library")).json()).toEqual(before);
  const id = await current.getAttribute("id");
  await page.reload();
  await expect(page.locator(`#${id}`)).toBeVisible();
  await expect(page.locator(`#${id}`).getByRole("button", { name: "Apply changes", exact: true })).toHaveCount(0);
});

test("uploads and MCP discovery can be cancelled without late results or clearing the task", async ({ page }) => {
  await page.goto("/");
  const task = page.getByLabel("What should we work on?", { exact: true });
  await task.fill("Keep this task while cancelling its attachment");
  let upload: import("@playwright/test").Route | undefined;
  await page.route("**/api/attachments", route => { upload = route; });
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({ name: "cancel.txt", mimeType: "text/plain", buffer: Buffer.from("Cancelled upload") });
  await expect.poll(() => !!upload).toBe(true);
  await page.getByRole("button", { name: "Cancel upload", exact: true }).click();
  await expect(page.getByRole("button", { name: "Attach files", exact: true })).toBeEnabled();
  await upload!.abort().catch(() => {});
  await expect(page.locator(".attachment-chip")).toHaveCount(0);
  await expect(task).toHaveValue("Keep this task while cancelling its attachment");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Discard task draft", exact: true }).click();
  await settings(page, "Skills & MCP");
  await page.getByRole("button", { name: "Add MCP server", exact: true }).click();
  const name = page.getByLabel("MCP server name", { exact: true }).last();
  await name.fill("Cancellable discovery");
  const card = page.locator("article").filter({ has: page.getByLabel("Enable Cancellable discovery", { exact: true }) });
  let discovery: import("@playwright/test").Route | undefined;
  await page.route("**/api/settings/mcp/inspect", route => { discovery = route; });
  await card.getByRole("button", { name: "Connect & discover tools", exact: true }).click();
  await expect.poll(() => !!discovery).toBe(true);
  await card.getByRole("button", { name: "Cancel discovery", exact: true }).click();
  await expect(card.getByRole("button", { name: "Connect & discover tools", exact: true })).toBeEnabled();
  await discovery!.abort().catch(() => {});
  await expect(card.locator(".mcp-tools")).toHaveCount(0);
  await expect(card.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Discard settings changes", exact: true }).click();
  await expect(card).toHaveCount(0);
});
