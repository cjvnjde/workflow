import {
  computed,
  onScopeDispose,
  shallowRef,
  watch,
  type MaybeRefOrGetter,
  toValue,
} from "vue";
import type { WorkflowRun } from "../../src/domain.js";
import { readPlanDraft } from "../plan-draft.js";

type Draft = { text: string; savedText: string; revision: number };
const fromRun = (run: WorkflowRun): Draft => {
  const text = JSON.stringify(run.plan, null, 2);
  return { text, savedText: text, revision: run.revision };
};

/** Keep local edits and their base revision when switching between runs. */
export function useDraft(source: MaybeRefOrGetter<WorkflowRun | undefined>) {
  const drafts = shallowRef<Record<string, Draft>>({});
  const run = computed(() => toValue(source));
  const draft = computed(() => {
    if (!run.value) {
      return undefined;
    }
    const cached = drafts.value[run.value.id];
    return cached && cached.text !== cached.savedText
      ? cached
      : fromRun(run.value);
  });
  const hasUnsaved = computed(() =>
    Object.values(drafts.value).some((item) => item.text !== item.savedText),
  );
  const parsed = computed(() =>
    run.value && draft.value ? readPlanDraft(draft.value.text, run.value) : {},
  );
  const warn = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = "";
  };
  watch(hasUnsaved, (dirty) => {
    window.removeEventListener("beforeunload", warn);
    if (dirty) {
      window.addEventListener("beforeunload", warn);
    }
  });
  onScopeDispose(() => window.removeEventListener("beforeunload", warn));

  // A computed snapshot is convenient to pass to the editor and execution controls.
  return computed(() => ({
    ...parsed.value,
    text: draft.value?.text ?? "",
    revision: draft.value?.revision,
    dirty: !!draft.value && draft.value.text !== draft.value.savedText,
    stale:
      !!run.value &&
      !!draft.value &&
      draft.value.revision !== run.value.revision,
    edit(text: string) {
      if (run.value && draft.value) {
        drafts.value = {
          ...drafts.value,
          [run.value.id]: { ...draft.value, text },
        };
      }
    },
    saved(updated: WorkflowRun) {
      drafts.value = { ...drafts.value, [updated.id]: fromRun(updated) };
    },
    reset() {
      if (run.value) {
        drafts.value = { ...drafts.value, [run.value.id]: fromRun(run.value) };
      }
    },
  }));
}

export type PlanDraft = ReturnType<typeof useDraft>["value"];
