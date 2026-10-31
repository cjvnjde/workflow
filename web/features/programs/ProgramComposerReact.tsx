import { useEffect, useRef, useState } from "react";
import type { Component } from "vue";
import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { programSourceSchema, type ProgramSource } from "../../../src/contracts/index.js";
import { VueIslandReact } from "../../shared/VueIslandReact.js";

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

export function ProgramComposerReact({ onSubmit }: ProgramComposerProps) {
  const [title, setTitle] = useState("My workflow");
  const [filename, setFilename] = useState("workflow.ts");
  const [source, setSource] = useState(template);
  const [input, setInput] = useState(initialInput);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [codeEditor, setCodeEditor] = useState<Component | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const panel = useRef<HTMLDetailsElement | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    if (!open || codeEditor) return;
    let cancelled = false;
    void import("../../shared/CodeEditor.vue").then((module) => {
      if (!cancelled) setCodeEditor(() => module.default);
    });
    return () => {
      cancelled = true;
    };
  }, [open, codeEditor]);

  function discard() {
    setSource(template);
    setTitle("My workflow");
    setFilename("workflow.ts");
    setInput(initialInput);
    setError("");
    if (panel.current) panel.current.open = false;
    setOpen(false);
  }

  async function load(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".ts") || file.size > 256_000) {
      setError("Choose a TypeScript file below 256 KB.");
      event.currentTarget.value = "";
      return;
    }
    setSource(await file.text());
    setFilename(file.name);
    setError("");
    event.currentTarget.value = "";
  }

  async function submit() {
    setBusy(true);
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
      setBusy(false);
      if (controller.current === current) controller.current = null;
    }
  }

  return (
    <details
      ref={panel}
      className="shadcn-theme dark mt-8 rounded-xl border border-border bg-card p-4 text-left text-card-foreground shadow-sm sm:p-5"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">Use a TypeScript workflow</summary>
      <p className="mt-2 text-sm text-muted-foreground">
        Paste or import a workflow, then review its source before starting it.
      </p>
      {open && (
        <fieldset className="mt-5 space-y-4" disabled={busy}>
          <label className="grid gap-2 text-sm font-medium">
            Workflow name
            <Input
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.currentTarget.value)}
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
            {codeEditor ? (
              <VueIslandReact
                className="mt-2"
                component={codeEditor}
                componentProps={{
                  modelValue: source,
                  label: "New workflow TypeScript",
                  readonly: busy,
                  "onUpdate:modelValue": setSource,
                }}
              />
            ) : (
              <div className="mt-2 h-48 animate-pulse rounded-md border border-input bg-muted" />
            )}
          </div>
          <div>
            <span className="text-sm font-medium">New workflow inputs (JSON)</span>
            {codeEditor ? (
              <VueIslandReact
                className="mt-2"
                component={codeEditor}
                componentProps={{
                  modelValue: input,
                  label: "New workflow inputs (JSON)",
                  language: "json",
                  minLines: 3,
                  maxLines: 12,
                  readonly: busy,
                  "onUpdate:modelValue": setInput,
                }}
              />
            ) : (
              <div className="mt-2 h-24 animate-pulse rounded-md border border-input bg-muted" />
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => void submit()}>
              {busy ? "Checking TypeScript…" : "Create workflow draft"}
            </Button>
            <Button type="button" variant="outline" onClick={discard}>
              Discard TypeScript draft
            </Button>
          </div>
        </fieldset>
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
          className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </pre>
      )}
    </details>
  );
}
