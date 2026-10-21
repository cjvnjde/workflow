<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, useId, watch } from "vue";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { tags } from "@lezer/highlight";

const props = withDefaults(defineProps<{
  modelValue: string;
  label: string;
  id?: string;
  language?: "typescript" | "javascript" | "json" | "bash";
  readonly?: boolean;
  minLines?: number;
  maxLines?: number;
}>(), { language: "typescript", minLines: 6, maxLines: 26 });
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const host = ref<HTMLDivElement>();
const fallbackId = useId();
const position = ref({ line: 1, column: 1 });
const languageName = computed(() => ({ typescript: "TypeScript", javascript: "JavaScript", json: "JSON", bash: "Bash" })[props.language]);
const language = new Compartment(), access = new Compartment();
let view: EditorView | undefined;
const languageExtension = () => props.language === "json" ? json() : props.language === "bash" ? StreamLanguage.define(shell) : javascript({ typescript: props.language === "typescript" });
const accessExtension = () => [
  EditorState.readOnly.of(props.readonly),
  EditorView.editable.of(!props.readonly),
  EditorView.contentAttributes.of({
    id: props.id ?? fallbackId, role: "textbox", "aria-label": props.label,
    "aria-multiline": "true", "aria-readonly": String(!!props.readonly),
    tabindex: "0", spellcheck: "false", autocapitalize: "off",
  }),
];
const theme = EditorView.theme({
  "&": { color: "var(--ctp-text)", backgroundColor: "var(--ctp-mantle)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", lineHeight: "1.65", overflow: "auto", maxHeight: "var(--code-max-height)" },
  ".cm-content": { padding: "12px 0", minHeight: "var(--code-min-height)", caretColor: "var(--ctp-rosewater)" },
  ".cm-line": { padding: "0 14px 0 8px" },
  ".cm-gutters": { backgroundColor: "var(--ctp-mantle)", color: "var(--ctp-overlay0)", border: "none", borderRight: "1px solid var(--ctp-surface0)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#31324470" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ctp-rosewater)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#585b7077" },
  ".cm-matchingBracket": { backgroundColor: "#cba6f733", outline: "1px solid var(--ctp-mauve)" },
  ".cm-searchMatch": { backgroundColor: "#f9e2af33" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#fab38755" },
  ".cm-panels, .cm-tooltip": { color: "var(--ctp-text)", backgroundColor: "var(--ctp-base)", borderColor: "var(--ctp-surface1)" },
  ".cm-search input": { width: "auto", maxWidth: "180px", background: "var(--ctp-mantle)", color: "var(--ctp-text)", border: "1px solid var(--ctp-surface1)" },
  ".cm-button": { color: "var(--ctp-text)", backgroundImage: "none", backgroundColor: "var(--ctp-surface0)", border: "1px solid var(--ctp-surface1)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { color: "var(--ctp-crust)", backgroundColor: "var(--ctp-mauve)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--ctp-surface0)", color: "var(--ctp-lavender)", border: "none" },
}, { dark: true });
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#cba6f7" },
  { tag: [tags.string, tags.regexp], color: "#a6e3a1" },
  { tag: [tags.number, tags.bool, tags.null], color: "#fab387" },
  { tag: tags.comment, color: "#7f849c", fontStyle: "italic" },
  { tag: [tags.typeName, tags.className], color: "#f9e2af" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#89b4fa" },
  { tag: [tags.propertyName, tags.attributeName], color: "#b4befe" },
  { tag: [tags.operator, tags.punctuation], color: "#89dceb" },
]);
onMounted(() => {
  view = new EditorView({
    parent: host.value,
    doc: props.modelValue,
    extensions: [basicSetup, theme, syntaxHighlighting(highlight), keymap.of([indentWithTab]),
      language.of(languageExtension()), access.of(accessExtension()),
      EditorView.updateListener.of(update => {
        if (update.docChanged) emit("update:modelValue", update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          position.value = { line: line.number, column: head - line.from + 1 };
        }
      }),
    ],
  });
});
watch(() => props.modelValue, value => {
  if (view && value !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
});
watch(() => props.language, () => view?.dispatch({ effects: language.reconfigure(languageExtension()) }));
watch(() => [props.readonly, props.id, props.label], () => view?.dispatch({ effects: access.reconfigure(accessExtension()) }));
onScopeDispose(() => view?.destroy());
</script>

<template>
  <div class="code-editor" :class="{ 'is-readonly': readonly }" :style="{
    '--code-min-height': `${minLines * 1.65 + 1.85}em`,
    '--code-max-height': `${maxLines * 1.65 + 1.85}em`,
  }">
    <div ref="host" class="code-editor-host" />
    <div class="code-editor-status">
      <span>{{ languageName }}<span v-if="readonly"> · Read only</span></span>
      <span class="code-editor-hint">Ctrl / ⌘ F to search · Esc, Tab to leave</span>
      <span>Ln {{ position.line }}, Col {{ position.column }}</span>
    </div>
  </div>
</template>

<style scoped>
.code-editor { min-width: 0; width: 100%; margin-top: 8px; border: 1px solid var(--ctp-surface1); border-radius: 9px; overflow: hidden; font-size: 13px; text-align: left; }
.code-editor:focus-within { border-color: var(--ctp-mauve); box-shadow: 0 0 0 1px var(--ctp-mauve); }
.code-editor-host { min-width: 0; }
.code-editor-status { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 12px; border-top: 1px solid var(--ctp-surface0); background: var(--ctp-mantle); color: var(--ctp-overlay2); font-size: 10px; line-height: 1.5; }
.code-editor-status > :last-child { margin-left: auto; font-variant-numeric: tabular-nums; }
.code-editor-hint { color: var(--ctp-overlay0); margin-left: auto; }
@media (max-width: 700px) { .code-editor-hint { display: none; } }
</style>
