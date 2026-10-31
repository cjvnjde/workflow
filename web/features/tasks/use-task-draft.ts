import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { attachmentSchema, type Attachment } from "../../../src/contracts/index.js";

const taskDraftSchema = z.object({
  text: z.string().max(32_000),
  files: z.array(attachmentSchema).max(8),
});
export type TaskDraft = z.infer<typeof taskDraftSchema>;
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const emptyDraft = (): TaskDraft => ({ text: "", files: [] });
const browserStorage = () => localStorage;
const draftKey = (project: string | undefined) =>
  project ? `workflow:task-draft:${encodeURIComponent(project)}` : undefined;

export function createDraftStore(project: string | undefined, storage: () => DraftStorage) {
  let key = draftKey(project);
  function readSaved(): TaskDraft {
    if (key) {
      try {
        const saved = storage().getItem(key);
        if (saved) return taskDraftSchema.parse(JSON.parse(saved));
      } catch {
        // Storage can be disabled or contain an obsolete/malformed draft.
      }
    }
    return emptyDraft();
  }
  let draft = readSaved();
  const listeners = new Set<() => void>();
  function emit() {
    for (const listener of listeners) listener();
  }
  function set(value: TaskDraft) {
    draft = value;
    if (key) {
      try {
        if (!value.text && !value.files.length) storage().removeItem(key);
        else storage().setItem(key, JSON.stringify(value));
      } catch {
        // In-memory drafts still survive navigation when storage is unavailable.
      }
    }
    emit();
  }
  return {
    getSnapshot: () => draft,
    getKey: () => key,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    selectProject: (project: string | undefined) => {
      const nextKey = draftKey(project);
      if (nextKey === key) return;
      key = nextKey;
      draft = readSaved();
      emit();
    },
    text: (text: string) => {
      if (text !== draft.text) set({ ...draft, text });
    },
    files: (files: Attachment[]) => set({ ...draft, files }),
    clear: () => set(emptyDraft()),
    clearSubmitted: (submitted: TaskDraft) => {
      // A delayed response must not erase edits made after submission.
      if (draft === submitted) set(emptyDraft());
    },
  };
}

/** Persist attachment references, never file bytes, in each project's browser draft. */
export function useTaskDraft(
  project: string | undefined,
  storage: () => DraftStorage = browserStorage,
) {
  const [store] = useState(() => createDraftStore(project, storage));
  const draft = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => store.selectProject(project), [store, project]);
  return {
    draft,
    text: store.text,
    files: store.files,
    clear: store.clear,
    clearSubmitted: store.clearSubmitted,
  };
}
