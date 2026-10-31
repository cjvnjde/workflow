import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab, isolateHistory } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { tags } from "@lezer/highlight";
import { z } from "zod";
import { request } from "./api.js";
import "./CodeEditor.css";

export interface CodeEditorProps {
  value: string;
  label: string;
  id?: string;
  language?: "typescript" | "javascript" | "json" | "bash";
  readOnly?: boolean;
  minLines?: number;
  maxLines?: number;
  onChange?: (value: string) => void;
}

type EditorConfiguration = CodeEditorProps & {
  id: string;
  language: NonNullable<CodeEditorProps["language"]>;
};

function languageExtension(language: EditorConfiguration["language"]) {
  return language === "json"
    ? json()
    : language === "bash"
      ? StreamLanguage.define(shell)
      : javascript({ typescript: language === "typescript" });
}
function accessExtension({ readOnly, id, label }: EditorConfiguration) {
  return [
    EditorState.readOnly.of(!!readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({
      id,
      role: "textbox",
      "aria-label": label,
      "aria-multiline": "true",
      "aria-readonly": String(!!readOnly),
      tabindex: "0",
      spellcheck: "false",
      autocapitalize: "off",
    }),
  ];
}

const theme = EditorView.theme({
  "&": { color: "var(--foreground)", backgroundColor: "var(--card)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    lineHeight: "1.65",
    overflow: "auto",
    maxHeight: "var(--code-max-height)",
  },
  ".cm-content": {
    padding: "12px 0",
    minHeight: "var(--code-min-height)",
    caretColor: "var(--foreground)",
  },
  ".cm-line": { padding: "0 14px 0 8px" },
  ".cm-gutters": {
    backgroundColor: "var(--card)",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--muted) 60%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklch, var(--primary) 20%, transparent)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "var(--accent)",
    outline: "1px solid var(--ring)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklch, var(--chart-4) 25%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklch, var(--chart-4) 45%, transparent)",
  },
  ".cm-panels, .cm-tooltip": {
    color: "var(--popover-foreground)",
    backgroundColor: "var(--popover)",
    borderColor: "var(--border)",
  },
  ".cm-search input": {
    width: "auto",
    maxWidth: "180px",
    background: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--input)",
  },
  ".cm-button": {
    color: "var(--secondary-foreground)",
    backgroundImage: "none",
    backgroundColor: "var(--secondary)",
    border: "1px solid var(--input)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    color: "var(--primary-foreground)",
    backgroundColor: "var(--primary)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "none",
  },
});
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--chart-1)" },
  { tag: [tags.string, tags.regexp], color: "var(--chart-2)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--chart-5)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [tags.typeName, tags.className], color: "var(--chart-4)" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--chart-3)",
  },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--foreground)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--muted-foreground)" },
]);
const languageNames = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  json: "JSON",
  bash: "Bash",
};

export default function CodeEditor({
  value,
  label,
  id,
  language = "typescript",
  readOnly,
  minLines = 6,
  maxLines = 26,
  onChange,
}: CodeEditorProps) {
  const fallbackId = useId();
  const resolvedId = id ?? fallbackId;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const configuration = useRef<EditorConfiguration | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const revision = useRef(0);
  const busy = useRef(false);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [formatting, setFormatting] = useState(false);
  const [formatError, setFormatError] = useState("");

  useLayoutEffect(() => {
    const previous = configuration.current;
    if (
      previous &&
      (previous.id !== resolvedId ||
        previous.language !== language ||
        previous.readOnly !== readOnly)
    ) {
      revision.current++;
    }
    configuration.current = {
      value,
      label,
      id: resolvedId,
      language,
      readOnly,
      onChange,
    };
  });

  const format = useCallback(async () => {
    const editor = view.current;
    const config = configuration.current;
    const abort = controller.current;
    if (
      !editor ||
      !config ||
      !abort ||
      config.readOnly ||
      busy.current ||
      config.language === "bash"
    )
      return;
    const source = editor.state.doc.toString();
    const syntax = config.language;
    const sourceRevision = revision.current;
    const sourceId = config.id;
    busy.current = true;
    setFormatting(true);
    setFormatError("");
    try {
      const result = await request(
        "/api/format",
        z.object({ formatted: z.string(), cursorOffset: z.number() }),
        {
          method: "POST",
          signal: abort.signal,
          body: { source, language: syntax, cursorOffset: editor.state.selection.main.head },
        },
      );
      // Never replace typing, a newly selected source, or locked approval text with a late response.
      if (
        abort.signal.aborted ||
        view.current !== editor ||
        configuration.current?.readOnly ||
        configuration.current?.language !== syntax ||
        configuration.current?.id !== sourceId ||
        sourceRevision !== revision.current ||
        source !== editor.state.doc.toString()
      )
        return;
      editor.dispatch({
        changes: { from: 0, to: source.length, insert: result.formatted },
        selection: { anchor: Math.max(0, Math.min(result.formatted.length, result.cursorOffset)) },
        annotations: isolateHistory.of("full"),
      });
    } catch (error) {
      if (!abort.signal.aborted && view.current === editor && sourceRevision === revision.current) {
        setFormatError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!abort.signal.aborted) {
        busy.current = false;
        setFormatting(false);
      }
    }
  }, []);

  useLayoutEffect(() => {
    const config = configuration.current;
    if (!host.current || !config) return;
    const syntax = new Compartment();
    const access = new Compartment();
    const abort = new AbortController();
    controller.current = abort;
    const editor = new EditorView({
      parent: host.current,
      doc: config.value,
      extensions: [
        basicSetup,
        theme,
        syntaxHighlighting(highlight),
        keymap.of([
          {
            key: "Shift-Alt-f",
            run: () => {
              void format();
              return true;
            },
          },
          indentWithTab,
        ]),
        syntax.of(languageExtension(config.language)),
        access.of(accessExtension(config)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            revision.current++;
            configuration.current?.onChange?.(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            setPosition({ line: line.number, column: head - line.from + 1 });
          }
        }),
      ],
    });
    view.current = editor;
    compartments.current = { syntax, access };
    return () => {
      abort.abort();
      editor.destroy();
      view.current = undefined;
      compartments.current = undefined;
      busy.current = false;
    };
  }, [format]);

  const compartments = useRef<{ syntax: Compartment; access: Compartment } | undefined>(undefined);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const previous = editor.state.doc.toString();
    if (previous === value) return;
    // A minimal replacement lets CodeMirror map the current selection and retain undo history.
    let from = 0;
    while (from < previous.length && from < value.length && previous[from] === value[from]) from++;
    let oldEnd = previous.length;
    let newEnd = value.length;
    while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === value[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    editor.dispatch({ changes: { from, to: oldEnd, insert: value.slice(from, newEnd) } });
  }, [value]);
  useLayoutEffect(() => {
    const syntax = compartments.current?.syntax;
    if (syntax)
      view.current?.dispatch({ effects: syntax.reconfigure(languageExtension(language)) });
  }, [language]);
  useLayoutEffect(() => {
    const access = compartments.current?.access;
    const config = configuration.current;
    if (access && config)
      view.current?.dispatch({ effects: access.reconfigure(accessExtension(config)) });
  }, [readOnly, resolvedId, label]);

  return (
    <div
      className={`code-editor workflow-workspace${readOnly ? " is-readonly" : ""}`}
      style={
        {
          "--code-min-height": `${minLines * 1.65 + 1.85}em`,
          "--code-max-height": `${maxLines * 1.65 + 1.85}em`,
        } as CSSProperties
      }
    >
      <div ref={host} className="code-editor-host" />
      <div className="code-editor-status">
        <span>
          {languageNames[language]}
          {readOnly && <span> · Read only</span>}
        </span>
        {!readOnly && language !== "bash" && (
          <button
            type="button"
            className="code-format"
            disabled={formatting}
            aria-label={`Format ${label}`}
            title="Format with Prettier · Shift + Alt + F"
            onClick={() => void format()}
          >
            {formatting ? "Formatting…" : "Format"}
          </button>
        )}
        <span className="code-editor-hint">Ctrl / ⌘ F to search · Esc, Tab to leave</span>
        <span>
          Ln {position.line}, Col {position.column}
        </span>
      </div>
      {formatError && (
        <pre className="code-format-error" role="alert">
          {formatError}
        </pre>
      )}
    </div>
  );
}
