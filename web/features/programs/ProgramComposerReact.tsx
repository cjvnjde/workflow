import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { programSourceSchema, type ProgramSource } from "../../../src/contracts/index.js";
import { emptyProgramDraft, type ProgramDraft } from "./use-program-draft.js";

type ProgramComposerProps = {
  draft: ProgramDraft;
  onChange: (draft: ProgramDraft) => void;
  onDiscard: () => void;
  onSubmit: (
    value: ProgramSource & { title: string; task: string },
    signal: AbortSignal,
  ) => Promise<void>;
};

const CodeEditor = lazy(() => import("../../shared/CodeEditor.js"));

export function ProgramComposerReact({
  draft,
  onChange,
  onDiscard,
  onSubmit,
}: ProgramComposerProps) {
  const editorId = useId();
  const form = useForm({
    defaultValues: draft,
    onSubmit: ({ value }) => submit(value),
  });
  const { title, filename, source, input } = useStore(form.store, (state) => state.values);
  const busy = useStore(form.store, (state) => state.isSubmitting);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const panel = useRef<HTMLDetailsElement | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  useLayoutEffect(() => {
    const current = form.state.values;
    if (
      current.title !== draft.title ||
      current.filename !== draft.filename ||
      current.source !== draft.source ||
      current.input !== draft.input
    ) {
      form.reset(draft);
    }
  }, [draft, form]);

  function edit(field: keyof ProgramDraft, value: string) {
    form.setFieldValue(field, value);
    onChange({ ...form.state.values, [field]: value });
  }

  function discard() {
    form.reset(emptyProgramDraft());
    onDiscard();
    setError("");
    if (panel.current) panel.current.open = false;
    setOpen(false);
  }

  async function load(event: React.ChangeEvent<HTMLInputElement>) {
    const element = event.currentTarget;
    const file = element.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".ts") || file.size > 256_000) {
      setError("Choose a TypeScript file below 256 KB.");
      element.value = "";
      return;
    }
    try {
      form.setFieldValue("source", await file.text());
      form.setFieldValue("filename", file.name);
      onChange(form.state.values);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      element.value = "";
    }
  }

  async function submit({
    title,
    filename,
    source,
    input,
  }: {
    title: string;
    filename: string;
    source: string;
    input: string;
  }) {
    setError("");
    const current = new AbortController();
    controller.current = current;
    try {
      const program = programSourceSchema.parse({
        source,
        filename,
        input: JSON.parse(input),
      });
      await onSubmit(
        {
          ...program,
          title,
          task: typeof program.input.request === "string" ? program.input.request : title,
        },
        current.signal,
      );
    } catch (failure) {
      setError(
        current.signal.aborted
          ? "Workflow creation cancelled."
          : failure instanceof Error
            ? failure.message
            : String(failure),
      );
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }

  return (
    <details
      ref={panel}
      className="mt-8 rounded-xl border border-border bg-card p-4 text-left text-card-foreground shadow-sm sm:p-5"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">Use a TypeScript workflow</summary>
      <p className="mt-2 text-sm text-muted-foreground">
        Paste or import a workflow, then review its source before starting it.
      </p>
      {open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <fieldset className="mt-5 space-y-4" disabled={busy}>
            <label className="grid gap-2 text-sm font-medium">
              Workflow name
              <Input
                value={title}
                maxLength={200}
                onChange={(event) => edit("title", event.currentTarget.value)}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={picker}
                type="file"
                accept=".ts"
                hidden
                aria-label="Import TypeScript file"
                onChange={(event) => void load(event)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => picker.current?.click()}
              >
                Import .ts file
              </Button>
              <small className="text-muted-foreground">{filename}</small>
            </div>
            <div>
              <span className="text-sm font-medium">New workflow TypeScript</span>
              <div className="mt-2">
                <Suspense
                  fallback={
                    <div className="h-48 animate-pulse rounded-md border border-input bg-muted" />
                  }
                >
                  <CodeEditor
                    value={source}
                    id={`${editorId}-source`}
                    label="New workflow TypeScript"
                    readOnly={busy}
                    onChange={(value) => edit("source", value)}
                  />
                </Suspense>
              </div>
            </div>
            <div>
              <span className="text-sm font-medium">New workflow inputs (JSON)</span>
              <div className="mt-2">
                <Suspense
                  fallback={
                    <div className="h-24 animate-pulse rounded-md border border-input bg-muted" />
                  }
                >
                  <CodeEditor
                    value={input}
                    id={`${editorId}-input`}
                    label="New workflow inputs (JSON)"
                    language="json"
                    minLines={3}
                    maxLines={12}
                    readOnly={busy}
                    onChange={(value) => edit("input", value)}
                  />
                </Suspense>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Checking TypeScript…" : "Create workflow draft"}
              </Button>
              <Button type="button" variant="outline" onClick={discard}>
                Discard TypeScript draft
              </Button>
            </div>
          </fieldset>
        </form>
      )}
      {busy && (
        <Button
          type="button"
          variant="ghost"
          className="mt-3"
          onClick={() => controller.current?.abort()}
        >
          Cancel workflow creation
        </Button>
      )}
      {error && (
        <pre
          className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm whitespace-pre-wrap wrap-anywhere text-destructive"
          role="alert"
        >
          {error}
        </pre>
      )}
    </details>
  );
}
