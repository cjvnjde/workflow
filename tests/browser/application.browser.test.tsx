import { afterEach, beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { Attachment } from "../../src/contracts/index.js";
import { TaskComposerReact } from "../../web/features/tasks/TaskComposerReact.js";
import "../../web/theme.css";

const prompt =
  "Review the checkout total regression and add focused coverage before changing the implementation.";
const attachment: Attachment = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "checkout-acceptance-criteria.txt",
  mimeType: "text/plain",
  size: 2400,
  sha256: "a".repeat(64),
  kind: "text",
};

function ComposerFixture() {
  const [text, setText] = useState(prompt);
  const [files, setFiles] = useState<Attachment[]>([attachment]);
  const [settingsRequested, setSettingsRequested] = useState(false);
  return (
    <main className="workflow-workspace min-h-screen bg-background px-5 py-12 text-foreground">
      <section aria-label="Task workspace" className="mx-auto max-w-3xl">
        <TaskComposerReact
          text={text}
          files={files}
          automatic={false}
          onTextChange={setText}
          onFilesChange={setFiles}
          onDiscard={() => {
            setText("");
            setFiles([]);
          }}
          onSettings={() => setSettingsRequested(true)}
          onSubmit={async () => {
            throw new Error("Task creation is temporarily unavailable. Your draft has been kept.");
          }}
        />
        {settingsRequested && <p role="status">Settings requested</p>}
      </section>
    </main>
  );
}

let root: Root;
let container: HTMLDivElement;
let wasDark: boolean;
beforeEach(() => {
  wasDark = document.documentElement.classList.contains("dark");
  document.documentElement.classList.add("dark");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(<ComposerFixture />));
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  if (!wasDark) document.documentElement.classList.remove("dark");
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "narrow", width: 390, height: 844 },
]) {
  test(`task composer draft and empty suggestions at ${viewport.name} width`, async () => {
    await page.viewport(viewport.width, viewport.height);
    await document.fonts.ready;
    const composer = page.getByRole("textbox", { name: "What should we work on?" });
    const workspace = page.getByRole("main");
    await expect.element(composer).toHaveValue(prompt);
    await expect
      .element(page.getByRole("button", { name: `Remove ${attachment.name}`, exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Start task", exact: true }))
      .toBeEnabled();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await expect.element(workspace).toMatchScreenshot(`task-composer-draft-${viewport.name}`);

    await page.getByRole("button", { name: "Discard task draft", exact: true }).click();
    await expect.element(composer).toHaveValue("");
    await expect
      .element(page.getByRole("button", { name: "Start task", exact: true }))
      .toBeDisabled();
    await expect
      .element(
        page.getByRole("button", { name: "Find and fix a bug in this project", exact: true }),
      )
      .toBeVisible();
    await expect.element(workspace).toMatchScreenshot(`task-composer-empty-${viewport.name}`);

    await page
      .getByRole("button", { name: "Find and fix a bug in this project", exact: true })
      .click();
    await expect.element(composer).toHaveValue("Find and fix a bug in this project");
    await expect.element(composer).toHaveFocus();
  });
}

test("failed task submission preserves a readable narrow draft", async () => {
  await page.viewport(390, 844);
  await document.fonts.ready;
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Task creation is temporarily unavailable. Your draft has been kept.");
  await expect
    .element(page.getByRole("textbox", { name: "What should we work on?" }))
    .toHaveValue(prompt);
  await expect
    .element(page.getByRole("button", { name: `Remove ${attachment.name}`, exact: true }))
    .toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await expect
    .element(page.getByRole("main"))
    .toMatchScreenshot("task-composer-submission-error-narrow");
});
