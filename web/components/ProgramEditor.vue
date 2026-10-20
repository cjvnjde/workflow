<script setup lang="ts">
import { computed, ref } from "vue";
import type { WorkflowRun } from "../../src/domain.js";
import type { PlanDraft } from "../composables/use-draft.js";
import { inputValue } from "../form-events.js";
import Icon from "./Icon.vue";
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
  link.download =
    props.run.program?.filename.split("/").at(-1) ?? "workflow.ts";
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
          Functions, typed results and ordinary loops. Each awaited step is
          saved by the engine.
        </p>
      </div>
      <span class="program-language">TS · {{ run.program?.filename }}</span>
    </div>
    <div class="editor-actions">
      <button class="quiet" @click="copy">
        <Icon name="copy" :size="14" />{{
          copied ? "Copied" : "Copy TypeScript"
        }}
      </button>
      <button class="quiet" @click="download">
        <Icon name="download" :size="14" />Download .ts
      </button>
      <small>{{
        draft.dirty
          ? "Unsaved changes"
          : "Typechecked · source and imports frozen"
      }}</small>
    </div>
    <div v-if="error || draft.error" class="validation-error" role="alert">
      {{ error || draft.error }}
    </div>
    <label class="editor-field"
      >Workflow TypeScript
      <textarea
        v-autosize="24"
        class="program-source"
        :spellcheck="false"
        :rows="6"
        :value="draft.text"
        :readonly="locked"
        @input="
          draft.edit(inputValue($event));
          copied = false;
        "
      />
    </label>
    <label class="editor-field"
      >Workflow inputs (JSON)
      <textarea
        v-autosize
        class="script-source"
        :spellcheck="false"
        :rows="3"
        :value="draft.inputText"
        :readonly="locked"
        @input="draft.editInput(inputValue($event))"
      />
    </label>
    <div class="editor-actions">
      <button
        v-if="run.status === 'draft'"
        class="primary"
        :disabled="busy || !draft.dirty || draft.stale || !draft.validProgram"
        @click="emit('save')"
      >
        Typecheck & save draft
      </button>
      <button v-if="draft.dirty" :disabled="busy" @click="draft.reset()">
        Discard code edits
      </button>
      <small>{{
        run.status === "draft"
          ? "Saving does not execute any steps."
          : "This source is the approved execution version."
      }}</small>
    </div>
    <details class="script-contract">
      <summary>Workflow API</summary>
      <p>
        Import <code>workflow, agent, script, z</code> from
        <code>"workflow"</code>. Use
        <code>await ctx.step(id, block, options)</code> with a Settings block ID
        or an inline definition.
      </p>
      <p>
        Step options include <code>prompt</code>, <code>inputs</code>,
        <code>model</code> and <code>maxVisits</code>. Typed agent results are
        in <code>result.data</code>; feedback and artifacts can be passed to the
        next step.
      </p>
      <p>
        Use ordinary loops and conditions. Put file access, shell commands and
        network work inside agent or script steps so restarts can resume
        completed work. The graph follows the executed path.
      </p>
    </details>
    <details v-if="live && run.status === 'draft'" class="refinement-editor">
      <summary>Refine this workflow with AI</summary>
      <label class="editor-field"
        >Tell AI what to change in this draft
        <textarea
          v-autosize
          v-model="refinement"
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
      <button v-if="refining" @click="emit('cancelRefinement')">
        Cancel refinement
      </button>
      <button v-else-if="refinement" :disabled="busy" @click="refinement = ''">
        Discard refinement
      </button>
      <p v-if="refining" role="status">
        {{ activity || "Refining TypeScript…" }}
      </p>
    </details>
  </div>
</template>
