import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { programSourceSchema, type ProgramSource } from "../../../src/contracts/index.js";

type ProgramComposerProps = {
  onSubmit: (
    value: ProgramSource & { title: string; task: string },
    signal: AbortSignal,
  ) => Promise<void>;
};

const template = `import { workflow, block, z } from "workflow";

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
`;
const initialInput = '{\n  "request": "Inspect the working tree"\n}';

const CodeEditor = lazy(() => import("../../shared/CodeEditor.js"));

export function ProgramComposerReact({ onSubmit }: ProgramComposerProps) {
  const editorId = useId();
  const form = useForm({
    defaultValues: {
      title: "My workflow",
      filename: "workflow.ts",
      source: template,
      input: initialInput,
    },
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

  function discard() {
    form.reset();
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
                onChange={(event) => form.setFieldValue("title", event.currentTarget.value)}
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
                    onChange={(value) => form.setFieldValue("source", value)}
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
                    onChange={(value) => form.setFieldValue("input", value)}
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
