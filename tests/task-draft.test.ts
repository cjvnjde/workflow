import test from "node:test";
import assert from "node:assert/strict";
import { createDraftStore } from "../web/features/tasks/use-task-draft.js";

function browserStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const attachment = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "notes.txt",
  mimeType: "text/plain",
  size: 12,
  sha256: "a".repeat(64),
  kind: "text" as const,
};

test("task text and uploaded references survive remounts and stay scoped to their project", () => {
  const storage = browserStorage();
  const draft = createDraftStore(undefined, () => storage);
  draft.selectProject("/project/one");
  draft.text("Unsent request");
  draft.files([attachment]);
  draft.selectProject("/project/two");
  assert.deepEqual(draft.getSnapshot(), { text: "", files: [] });
  draft.text("Other project");
  draft.selectProject("/project/one");
  assert.deepEqual(draft.getSnapshot(), { text: "Unsent request", files: [attachment] });
  const reloaded = createDraftStore("/project/one", () => storage);
  assert.deepEqual(reloaded.getSnapshot(), { text: "Unsent request", files: [attachment] });
  reloaded.clear();
  assert.equal(storage.getItem(`workflow:task-draft:${encodeURIComponent("/project/one")}`), null);
});

test("late task creation cannot clear a newer draft or another project's draft", () => {
  const storage = browserStorage();
  const draft = createDraftStore("/one", () => storage);
  draft.text("Submitted request");
  const submitted = draft.getSnapshot();
  draft.text("New request");
  draft.files([attachment]);
  draft.clearSubmitted(submitted);
  assert.equal(draft.getSnapshot().text, "New request");
  const current = draft.getSnapshot();
  draft.selectProject("/two");
  draft.text("Other project");
  draft.clearSubmitted(current);
  assert.equal(draft.getSnapshot().text, "Other project");
  draft.clearSubmitted(draft.getSnapshot());
  assert.deepEqual(draft.getSnapshot(), { text: "", files: [] });
});

test("malformed or unavailable browser storage does not break editing or navigation", () => {
  for (const storage of [
    () => ({ ...browserStorage(), getItem: () => '{"text":12}' }),
    () => {
      throw new Error("Storage disabled");
    },
  ]) {
    const draft = createDraftStore("/project", storage);
    assert.deepEqual(draft.getSnapshot(), { text: "", files: [] });
    draft.text("Still editable");
    draft.files([attachment]);
    assert.deepEqual(draft.getSnapshot(), { text: "Still editable", files: [attachment] });
  }
});
