import { useEffect, useMemo, useState } from "react";
import {
  programSourceSchema,
  type ProgramSource,
  type WorkflowPlan,
  type WorkflowRun,
} from "../../../src/contracts/index.js";
import { isSourceWorkflow } from "../execution/execution-label.js";
import { readPlanDraft } from "./plan-draft.js";

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

type ParsedDraft = {
  plan?: WorkflowPlan;
  validPlan?: WorkflowPlan;
  validProgram?: ProgramSource;
  error?: string;
};

export type PlanDraft = ParsedDraft & {
  text: string;
  inputText: string;
  revision: number | undefined;
  dirty: boolean;
  stale: boolean;
  edit: (text: string) => void;
  editInput: (inputText: string) => void;
  saved: (updated: WorkflowRun) => void;
  reset: () => void;
};

/** Keep local edits and their base revision when switching between runs. */
export function useDraft(run: WorkflowRun | undefined): PlanDraft {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draft = useMemo(() => {
    if (!run) return undefined;
    const cached = drafts[run.id];
    return cached && changed(cached) ? cached : fromRun(run);
  }, [drafts, run]);
  const hasUnsaved = Object.values(drafts).some(changed);
  const parsed = useMemo<ParsedDraft>(() => {
    if (!run || !draft) return {};
    if (!isSourceWorkflow(run)) return readPlanDraft(draft.text, run);
    try {
      return {
        validProgram: programSourceSchema.parse({
          source: draft.text,
          filename: run.program!.filename,
          input: JSON.parse(draft.inputText),
        }),
      };
    } catch {
      return {
        error:
          "Enter TypeScript source and a valid JSON object for inputs. Saving checks TypeScript before publication.",
      };
    }
  }, [draft, run]);

  useEffect(() => {
    if (!hasUnsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsaved]);

  function editFields(patch: Partial<Pick<Draft, "text" | "inputText">>) {
    if (!run) return;
    setDrafts((previous) => {
      const cached = previous[run.id];
      const current = cached && changed(cached) ? cached : fromRun(run);
      return { ...previous, [run.id]: { ...current, ...patch } };
    });
  }

  return {
    ...parsed,
    text: draft?.text ?? "",
    inputText: draft?.inputText ?? "{}",
    revision: draft?.revision,
    dirty: !!draft && changed(draft),
    stale: !!run && !!draft && draft.revision !== run.revision,
    edit(text: string) {
      editFields({ text });
    },
    editInput(inputText: string) {
      editFields({ inputText });
    },
    saved(updated: WorkflowRun) {
      setDrafts((previous) => ({ ...previous, [updated.id]: fromRun(updated) }));
    },
    reset() {
      if (run) setDrafts((previous) => ({ ...previous, [run.id]: fromRun(run) }));
    },
  };
}
