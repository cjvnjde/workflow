import { shallowRef, watch } from "vue";
import { z } from "zod";
import { attachmentSchema, type Attachment } from "../../../src/contracts/index.js";

const taskDraftSchema = z.object({
  text: z.string().max(32_000),
  files: z.array(attachmentSchema).max(8),
});
export type TaskDraft = z.infer<typeof taskDraftSchema>;
const emptyDraft = (): TaskDraft => ({ text: "", files: [] });

/** Keep uploaded attachment references, never file bytes, in the browser draft. */
export function useTaskDraft(
  project: () => string | undefined,
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> = () => localStorage,
) {
  const draft = shallowRef<TaskDraft>(emptyDraft());
  let key: string | undefined;
  watch(
    project,
    (id) => {
      key = id ? `workflow:task-draft:${encodeURIComponent(id)}` : undefined;
      draft.value = emptyDraft();
      if (!key) return;
      try {
        const saved = storage().getItem(key);
        if (saved) draft.value = taskDraftSchema.parse(JSON.parse(saved));
      } catch {
        // Storage can be disabled or contain an obsolete/malformed draft.
      }
    },
    { immediate: true, flush: "sync" },
  );
  function set(value: TaskDraft) {
    draft.value = value;
    if (!key) return;
    try {
      if (!value.text && !value.files.length) storage().removeItem(key);
      else storage().setItem(key, JSON.stringify(value));
    } catch {
      // In-memory drafts still survive navigation when browser storage is unavailable.
    }
  }
  return {
    draft,
    text: (text: string) => {
      if (text !== draft.value.text) set({ ...draft.value, text });
    },
    files: (files: Attachment[]) => set({ ...draft.value, files }),
    clear: () => set(emptyDraft()),
    clearSubmitted: (submitted: TaskDraft) => {
      // A delayed response must not erase edits made after submission.
      if (draft.value === submitted) set(emptyDraft());
    },
  };
}
