import { expect, test, type Locator, type Page } from "@playwright/test";

async function fillCode(editor: Locator, source: string) {
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");
  await editor.page().keyboard.insertText(source);
}

const composition = `import { workflow, block, step, sequence, parallel, when, repeatUntil } from "workflow";

const prepare = step("prepare", block({ run() { return "Ready to implement"; } }), { label: "Prepare requirements" });
const implement = block({
  async run(ctx) {
    // Multiple demo calls keep both branches observable without external services.
    await ctx.ai({ prompt: "Inspect this independent change" });
    await ctx.ai({ prompt: "Implement this independent change" });
    await ctx.ai({ prompt: "Check this independent change" });
    return { ready: true };
  },
});
const frontend = step("frontend", implement, { label: "Implement interface", maxVisits: 2 });
const backend = step("backend", implement, { label: "Implement service", maxVisits: 2 });
const review = step("review", block({
  run(ctx) {
    const approved = ctx.visit === 2;
    ctx.outcome(approved ? "pass" : "retry");
    ctx.summary(approved ? "Both independent changes are approved." : "Please make another revision.");
    return { approved };
  },
}), { label: "Review changes", maxVisits: 2, on: { retry: "continue" } });
const publish = step("publish", block({ run(ctx) { ctx.artifact("release", "## Ready to publish\\n\\nBoth changes passed review."); return "Changes are ready to publish."; } }), { label: "Publish result" });
const blocked = step("blocked", block({ run() { throw new Error("The rejected branch must not execute"); } }), { label: "Request intervention" });

export default workflow({
  name: "Reviewed parallel composition",
  flow: sequence(
    prepare,
    repeatUntil("review-cycle", {
      body: sequence(parallel([frontend, backend], { concurrency: 2, label: "Independent changes" }), review),
      until: ctx => ctx.output(review)?.approved === true,
      maxIterations: 2,
    }),
    when("publish-approved", ctx => ctx.output(review)?.approved === true, publish, blocked),
  ),
});
`;

async function createComposition(
  page: Page,
  source = composition,
  request = "Inspect the working tree",
) {
  await page.goto("/");
  await page.getByText("Use a TypeScript workflow", { exact: true }).click();
  await page.getByLabel("Workflow name", { exact: true }).fill("Reviewed parallel composition");
  await fillCode(page.getByLabel("New workflow TypeScript", { exact: true }), source);
  await fillCode(
    page.getByLabel("New workflow inputs (JSON)", { exact: true }),
    JSON.stringify({ request }),
  );
  await page.getByRole("button", { name: "Create workflow draft", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
}

test("composition previews loop and parallel boundaries, exposes conditions, and preserves dragged layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await createComposition(page);
  await expect(page.getByRole("button", { name: "Workflow", exact: true })).toHaveClass(/active/);
  await expect(page.locator(".workflow-node")).toHaveCount(6);
  await expect(page.locator(".composition-group")).toHaveCount(3);
  await expect(page.locator(".composition-group")).toContainText([
    "Repeat until",
    "Independent changes",
    "Condition",
  ]);

  await page.locator('.composition-group[data-id="review-cycle"] .composition-heading').click();
  await expect(page.locator(".step-inspector")).toContainText("at most 2 iterations");
  await expect(page.locator(".step-inspector")).toContainText("approved");
  await page.getByRole("button", { name: "Close group details", exact: true }).click();
  await page.locator('.composition-group[data-id="publish-approved"] .composition-heading').click();
  await expect(page.locator(".step-inspector")).toContainText("approved");
  await page.getByRole("button", { name: "Close group details", exact: true }).click();

  const frontend = page.locator('.workflow-node[data-id="frontend"]');
  const transform = () => frontend.evaluate((node) => (node as HTMLElement).style.transform);
  const originalTransform = await transform();
  const box = await frontend.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 18, box!.y + box!.height / 2 + 8, { steps: 8 });
  await page.mouse.up();
  await expect.poll(transform).not.toBe(originalTransform);
  const movedTransform = await transform();
  await page.reload();
  await expect.poll(transform).toBe(movedTransform);
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await expect.poll(transform).toBe(originalTransform);
  await page.screenshot({
    path: "/tmp/workflow-composition-preview.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("parallel steps highlight together, loops show rounds, and final results are visible", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await createComposition(page);
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await expect(page.locator(".workflow-node.active")).toHaveCount(2);
  await expect(page.locator(".workflow-counts")).toContainText("2 steps running in parallel");
  await expect(page.locator('.workflow-node[data-id="frontend"]')).toHaveClass(/active/);
  await expect(page.locator('.workflow-node[data-id="backend"]')).toHaveClass(/active/);
  await expect(page.locator(".working-card")).toContainText("Implement interface");
  await expect(page.locator(".working-card")).toContainText("Implement service");
  await page.screenshot({
    path: "/tmp/workflow-composition-running.png",
    fullPage: true,
  });
  await expect(page.locator(".status-pill")).toHaveText("Completed", {
    timeout: 20_000,
  });
  await expect(page.locator(".workflow-counts")).not.toContainText("running in parallel");
  await expect(page.locator('.workflow-node[data-id="review"]')).toContainText("2/2 visits");
  await expect(page.locator('.composition-group[data-id="review-cycle"]')).toContainText("round 2");
  await expect(page.locator('.composition-group[data-id="review-cycle"]')).toContainText(
    "exit (true)",
  );
  await expect(page.locator('.workflow-node[data-id="blocked"]')).toContainText("skipped");
  await expect(page.locator(".result-banner")).toContainText("Changes are ready to publish.");
  await page.getByRole("button", { name: "View full results", exact: false }).click();
  await expect(page.locator(".results-panel")).toContainText("Exit predicate evaluated");
  await expect(page.locator(".results-panel")).toContainText("false → repeat");
  await expect(page.getByRole("heading", { name: "Ready to publish", exact: true })).toBeVisible();
  await expect(page.locator(".results-panel")).toContainText("Both changes passed review.");
  expect(errors).toEqual([]);
});

test("saving composition source refreshes the reviewed graph before approval", async ({ page }) => {
  await createComposition(page);
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  const revised = composition.replace(
    'concurrency: 2, label: "Independent changes"',
    'concurrency: 1, label: "Limited concurrency"',
  );
  await fillCode(page.getByLabel("Workflow TypeScript", { exact: true }), revised);
  await expect(page.getByRole("button", { name: "Approve & start", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Typecheck & save draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve & start", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect(
    page.locator(".composition-group").filter({ hasText: "Limited concurrency" }),
  ).toBeVisible();
  await page
    .locator(".composition-group")
    .filter({ hasText: "Limited concurrency" })
    .locator(".composition-heading")
    .click();
  await expect(page.locator(".step-inspector")).toContainText("up to 1 independent branch");
  await expect(page.locator(".workflow-counts")).toContainText("0/30 step visits");
  await expect(page.locator(".status-pill")).toHaveText("Awaiting approval");
});

test("parallel live responses stay with their own step when a sibling finishes", async ({
  page,
}) => {
  const source = `import { workflow, block, step, parallel } from "workflow";
    const worker = block({ run: ctx => ctx.ai({ prompt: ctx.prompt }) });
    export default workflow({ name: "Parallel responses", flow: parallel([
      step("stream-frontend", worker, { label: "Frontend stream" }),
      step("stream-backend", worker, { label: "Backend stream" }),
    ]) });`;
  await createComposition(page, source, "[parallel-stream-fixture] Keep responses separate");
  await page.getByRole("button", { name: "Approve & start", exact: true }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const streams = page.locator(".live-output");
  await expect(streams).toHaveCount(2);
  await expect(streams.filter({ hasText: "Frontend stream" })).toContainText(
    "Inspecting frontend. Frontend notes stay here.",
  );
  await expect(streams.filter({ hasText: "Frontend stream" })).not.toContainText("Backend notes");
  await expect(streams.filter({ hasText: "Backend stream" })).toContainText(
    "Inspecting backend. Backend notes stay here.",
  );
  await page.getByLabel("Activity step", { exact: true }).selectOption("stream-frontend");
  await expect(streams).toHaveCount(1);
  await expect(streams).not.toContainText("Inspecting backend");
  await page.getByLabel("Activity step", { exact: true }).selectOption("");
  await expect(
    page.locator(".activity-feed .event.node_end").filter({ hasText: "Backend finished." }),
  ).toBeVisible();
  await expect(streams).toHaveCount(1);
  await expect(streams).toContainText("Frontend notes stay here.");
  await expect(page.locator(".status-pill")).toHaveText("Completed", {
    timeout: 15_000,
  });
  await expect(streams).toHaveCount(0);
});
