<script setup lang="ts">
import { computed, ref } from "vue";
import type { WorkflowRun } from "../../../src/contracts/index.js";
import type { PlanDraft } from "../tasks/use-draft.js";
import Icon from "../../shared/Icon.vue";
import CodeEditor from "../../shared/CodeEditor.vue";
const props = defineProps<{
  run: WorkflowRun;
  draft: PlanDraft;
  busy: boolean;
  live: boolean;
  refining: boolean;
  activity: string;
}>();
const emit = defineEmits<{
  save: [];
  refine: [instructions: string];
  cancelRefinement: [];
}>();
const locked = computed(() => props.busy || props.run.status !== "draft");
const copied = ref(false);
const error = ref("");
const refinement = ref("");
async function copy() {
  try {
    await navigator.clipboard.writeText(props.draft.text);
    copied.value = true;
    error.value = "";
  } catch {
    error.value = "Clipboard unavailable. Download the source instead.";
  }
}
function download() {
  const url = URL.createObjectURL(
    new Blob([props.draft.text], { type: "text/typescript;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = props.run.program?.filename.split("/").at(-1) ?? "workflow.ts";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <div class="plan-editor program-editor">
    <div class="editor-heading">
      <div>
        <h2>TypeScript workflow</h2>
        <p>
          Compose steps, sequences, branches, parallel groups and loops. The engine saves each
          step's results.
        </p>
      </div>
      <span class="program-language">TS · {{ run.program?.filename }}</span>
    </div>
    <div class="editor-actions">
      <button class="quiet" @click="copy">
        <Icon name="copy" :size="14" />{{ copied ? "Copied" : "Copy TypeScript" }}
      </button>
      <button class="quiet" @click="download">
        <Icon name="download" :size="14" />Download .ts
      </button>
      <small>{{
        draft.dirty ? "Unsaved changes" : "Typechecked · source and imports frozen"
      }}</small>
    </div>
    <div v-if="error || draft.error" class="validation-error" role="alert">
      {{ error || draft.error }}
    </div>
    <div class="editor-field">
      <span>Workflow TypeScript</span>
      <CodeEditor
        :key="run.id"
        label="Workflow TypeScript"
        :model-value="draft.text"
        :readonly="locked"
        @update:model-value="
          draft.edit($event);
          copied = false;
        "
      />
    </div>
    <div class="editor-field">
      <span>Workflow inputs (JSON)</span>
      <CodeEditor
        label="Workflow inputs (JSON)"
        language="json"
        :min-lines="3"
        :max-lines="12"
        :model-value="draft.inputText"
        :readonly="locked"
        @update:model-value="draft.editInput($event)"
      />
    </div>
    <div class="editor-actions">
      <button
        v-if="run.status === 'draft'"
        class="primary"
        :disabled="busy || !draft.dirty || draft.stale || !draft.validProgram"
        @click="emit('save')"
      >
        Typecheck & save draft
      </button>
      <button v-if="draft.dirty" :disabled="busy" @click="draft.reset()">Discard code edits</button>
      <small>{{
        run.status === "draft"
          ? "Saving does not execute any steps."
          : "This source is the approved execution version."
      }}</small>
    </div>
    <details class="script-contract">
      <summary>Workflow API</summary>
      <p>
        Import <code>workflow, block, step, sequence, parallel, when, repeatUntil, z</code> from
        <code>"workflow"</code>. Define a block with
        <code>block({ input, output, async run(ctx) { … } })</code>, then call
        <code>step(id, block, { inputs })</code> and compose it inside
        <code>workflow({ name, flow })</code>.
      </p>
      <p>
        Inside a block, <code>ctx.ai({ prompt, model, output })</code> calls a model,
        <code>ctx.exec(command)</code> runs Bash, and <code>ctx.readFile/writeFile</code> handles
        files. Use <code>ctx.summary(markdown)</code>, <code>ctx.artifact(name, text)</code> and
        <code>await ctx.log(message)</code> for visible results.
      </p>
      <p>
        Conditions and deferred inputs read typed results with <code>ctx.output(step)</code> and
        explicit outcomes with <code>ctx.result(step)?.outcome</code>. Use
        <code>repeatUntil</code> with a condition and iteration limit, and <code>parallel</code> for
        independent work. Saved blocks can be referenced by ID. Parallel branches share the project;
        serialize overlapping writes and Git operations. Inside each block, await every operation.
      </p>
    </details>
    <details v-if="live && run.status === 'draft'" class="refinement-editor">
      <summary>Refine this workflow with AI</summary>
      <label class="editor-field"
        >Tell AI what to change in this draft
        <textarea
          v-model="refinement"
          v-autosize
          :disabled="busy"
          :rows="3"
          :maxlength="8000"
          placeholder="Add a test step, change the review loop, or choose a different model…"
        />
      </label>
      <button
        :disabled="busy || draft.dirty || !refinement.trim()"
        @click="emit('refine', refinement)"
      >
        Update draft with AI
      </button>
      <button v-if="refining" @click="emit('cancelRefinement')">Cancel refinement</button>
      <button v-else-if="refinement" :disabled="busy" @click="refinement = ''">
        Discard refinement
      </button>
      <p v-if="refining" role="status">
        {{ activity || "Refining TypeScript…" }}
      </p>
    </details>
  </div>
</template>
