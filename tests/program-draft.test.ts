import { test } from "vitest";
import assert from "node:assert/strict";
import {
  createProgramDraftStore,
  emptyProgramDraft,
} from "../web/features/programs/use-program-draft.js";

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

test("TypeScript source, inputs and names survive reload and remain project scoped", () => {
  const storage = browserStorage();
  const store = createProgramDraftStore("/first", () => storage);
  const saved = {
    title: "Review local changes",
    filename: "review.ts",
    source: "export default workflow({name: 'review'});",
    input: '{"base":"main"}',
  };
  store.set(saved);
  assert.deepEqual(createProgramDraftStore("/first", () => storage).getSnapshot(), saved);
  store.selectProject("/second");
  assert.deepEqual(store.getSnapshot(), emptyProgramDraft());
  store.selectProject("/first");
  assert.deepEqual(store.getSnapshot(), saved);
  store.clear();
  assert.deepEqual(
    createProgramDraftStore("/first", () => storage).getSnapshot(),
    emptyProgramDraft(),
  );
});

test("a delayed workflow submission cannot erase newer edits or another project's draft", () => {
  const store = createProgramDraftStore("/first", browserStorage);
  const submitted = { ...emptyProgramDraft(), source: "submitted source" };
  store.set(submitted);
  const newer = { ...submitted, source: "newer source", input: '{"revision":2}' };
  store.set(newer);
  store.clearSubmitted(submitted);
  assert.deepEqual(store.getSnapshot(), newer);
  store.selectProject("/second");
  store.set({ ...emptyProgramDraft(), title: "Another project" });
  store.clearSubmitted(newer);
  assert.equal(store.getSnapshot().title, "Another project");
});

test("disabled browser storage still retains each project's in-memory program draft", () => {
  const store = createProgramDraftStore("/first", () => {
    throw new Error("Storage disabled");
  });
  const draft = { ...emptyProgramDraft(), source: "unsaved source" };
  store.set(draft);
  store.selectProject("/second");
  store.selectProject("/first");
  assert.deepEqual(store.getSnapshot(), draft);
});
