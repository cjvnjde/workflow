import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";

const programDraftSchema = z.object({
  title: z.string(),
  filename: z.string(),
  source: z.string(),
  input: z.string(),
});
export type ProgramDraft = z.infer<typeof programDraftSchema>;
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserStorage = () => localStorage;
const draftKey = (project: string | undefined) =>
  project ? `workflow:program-draft:${encodeURIComponent(project)}` : undefined;

export const emptyProgramDraft = (): ProgramDraft => ({
  title: "My workflow",
  filename: "workflow.ts",
  source: `import { workflow, block, z } from "workflow";

const inspect = block({
  output: z.object({ output: z.string(), exitCode: z.number().nullable() }),
  async run(ctx) {
    const result = await ctx.exec("git status --short");
    ctx.summary(result.output || "Working tree is clean.");
    return { output: result.output, exitCode: result.exitCode };
  },
});

export default workflow({
  name: "Project check",
  async run(ctx) {
    const result = await ctx.step("inspect", inspect);
    if (result.exitCode !== 0) throw new Error(result.output);
    return result.output || "Working tree is clean.";
  },
});
`,
  input: '{\n  "request": "Inspect the working tree"\n}',
});

export function createProgramDraftStore(project: string | undefined, storage: () => DraftStorage) {
  let key = draftKey(project);
  const drafts = new Map<string | undefined, ProgramDraft>();
  function readSaved(): ProgramDraft {
    const cached = drafts.get(key);
    if (cached) return cached;
    if (key) {
      try {
        const saved = storage().getItem(key);
        if (saved) return programDraftSchema.parse(JSON.parse(saved));
      } catch {
        // Keep editing available when browser storage is disabled or malformed.
      }
    }
    return emptyProgramDraft();
  }
  let draft = readSaved();
  const listeners = new Set<() => void>();
  function emit() {
    for (const listener of listeners) listener();
  }
  function set(value: ProgramDraft) {
    draft = value;
    drafts.set(key, value);
    if (key) {
      try {
        if (JSON.stringify(value) === JSON.stringify(emptyProgramDraft()))
          storage().removeItem(key);
        else storage().setItem(key, JSON.stringify(value));
      } catch {
        // Parent-owned memory also retains drafts across workspace navigation.
      }
    }
    emit();
  }
  return {
    getSnapshot: () => draft,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selectProject: (project: string | undefined) => {
      const nextKey = draftKey(project);
      if (nextKey === key) return;
      drafts.set(key, draft);
      key = nextKey;
      draft = readSaved();
      emit();
    },
    set,
    clear: () => set(emptyProgramDraft()),
    clearSubmitted: (submitted: ProgramDraft) => {
      if (draft === submitted) set(emptyProgramDraft());
    },
  };
}

export function useProgramDraft(
  project: string | undefined,
  storage: () => DraftStorage = browserStorage,
) {
  const [store] = useState(() => createProgramDraftStore(project, storage));
  const draft = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => store.selectProject(project), [store, project]);
  return { draft, set: store.set, clear: store.clear, clearSubmitted: store.clearSubmitted };
}
