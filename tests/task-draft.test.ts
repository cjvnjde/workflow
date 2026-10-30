import test from "node:test";
import assert from "node:assert/strict";
import { effectScope, ref } from "vue";
import { useTaskDraft } from "../web/composables/use-task-draft.js";

function browserStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}
const attachment = { id: "00000000-0000-4000-8000-000000000001", name: "notes.txt", mimeType: "text/plain", size: 12, sha256: "a".repeat(64), kind: "text" as const };

test("task text and uploaded references survive remounts and stay scoped to their project", () => {
  const storage = browserStorage();
  const project = ref<string | undefined>(undefined);
  const scope = effectScope();
  const draft = scope.run(() => useTaskDraft(() => project.value, () => storage))!;
  project.value = "/project/one";
  draft.text("Unsent request"); draft.files([attachment]);
  project.value = "/project/two";
  assert.deepEqual(draft.draft.value, { text: "", files: [] });
  draft.text("Other project");
  project.value = "/project/one";
  assert.deepEqual(draft.draft.value, { text: "Unsent request", files: [attachment] });
  scope.stop();
  const reloadedScope = effectScope();
  const reloaded = reloadedScope.run(() => useTaskDraft(() => "/project/one", () => storage))!;
  assert.deepEqual(reloaded.draft.value, { text: "Unsent request", files: [attachment] });
  reloaded.clear();
  assert.equal(storage.getItem(`workflow:task-draft:${encodeURIComponent("/project/one")}`), null);
  reloadedScope.stop();
});

test("late task creation cannot clear a newer draft or another project's draft", () => {
  const scope = effectScope();
  const project = ref("/one");
  const storage = browserStorage();
  const draft = scope.run(() => useTaskDraft(() => project.value, () => storage))!;
  draft.text("Submitted request"); const submitted = draft.draft.value;
  draft.text("New request"); draft.files([attachment]);
  draft.clearSubmitted(submitted);
  assert.equal(draft.draft.value.text, "New request");
  const current = draft.draft.value;
  project.value = "/two"; draft.text("Other project"); draft.clearSubmitted(current);
  assert.equal(draft.draft.value.text, "Other project");
  draft.clearSubmitted(draft.draft.value);
  assert.deepEqual(draft.draft.value, { text: "", files: [] });
  scope.stop();
});

test("malformed or unavailable browser storage does not break editing or navigation", () => {
  for (const storage of [
    () => ({ ...browserStorage(), getItem: () => '{"text":12}' }),
    () => { throw new Error("Storage disabled"); },
  ]) {
    const scope = effectScope();
    const draft = scope.run(() => useTaskDraft(() => "/project", storage))!;
    assert.deepEqual(draft.draft.value, { text: "", files: [] });
    draft.text("Still editable"); draft.files([attachment]);
    assert.deepEqual(draft.draft.value, { text: "Still editable", files: [attachment] });
    scope.stop();
  }
});
