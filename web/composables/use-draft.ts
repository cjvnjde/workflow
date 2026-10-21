import {
  computed,
  onScopeDispose,
  shallowRef,
  watch,
  type MaybeRefOrGetter,
  toValue,
} from "vue";
import type { WorkflowRun } from "../../src/domain.js";
import { isSourceWorkflow } from "../execution-label.js";
import { readPlanDraft } from "../plan-draft.js";
import {
  programSourceSchema,
  type ProgramSource,
} from "../../src/program-schema.js";

type Draft = {
  text: string;
  savedText: string;
  inputText: string;
  savedInput: string;
  revision: number;
};
const changed = (draft: Draft) =>
  draft.text !== draft.savedText || draft.inputText !== draft.savedInput;
const fromRun = (run: WorkflowRun): Draft => {
  const text = isSourceWorkflow(run) ? run.program!.source : JSON.stringify(run.plan, null, 2);
  const inputText = JSON.stringify(run.program?.input ?? {}, null, 2);
  return {
    text,
    savedText: text,
    inputText,
    savedInput: inputText,
    revision: run.revision,
  };
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
    return cached && changed(cached) ? cached : fromRun(run.value);
  });
  const hasUnsaved = computed(() => Object.values(drafts.value).some(changed));
  const parsed = computed<
    ReturnType<typeof readPlanDraft> & { validProgram?: ProgramSource }
  >(() => {
    if (!run.value || !draft.value) return {};
    if (!isSourceWorkflow(run.value)) return readPlanDraft(draft.value.text, run.value);
    try {
      return {
        validProgram: programSourceSchema.parse({
          source: draft.value.text,
          filename: run.value.program!.filename,
          input: JSON.parse(draft.value.inputText),
        }),
      };
    } catch {
      return {
        error:
          "Enter TypeScript source and a valid JSON object for inputs. Saving checks TypeScript before publication.",
      };
    }
  });
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
    inputText: draft.value?.inputText ?? "{}",
    revision: draft.value?.revision,
    dirty: !!draft.value && changed(draft.value),
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
    editInput(inputText: string) {
      if (run.value && draft.value)
        drafts.value = {
          ...drafts.value,
          [run.value.id]: { ...draft.value, inputText },
        };
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
