<script setup lang="ts">
import { nextTick, onScopeDispose, ref } from "vue";
import Icon from "./Icon.vue";
const props = defineProps<{
  onOpen: (value: string, signal: AbortSignal) => Promise<void>;
}>();
const dialog = ref<HTMLDialogElement>();
const input = ref<HTMLInputElement>();
const value = ref("");
const error = ref("");
const busy = ref(false);
let lookup: AbortController | undefined;
function cancelLookup() {
  lookup?.abort();
  lookup = undefined;
  busy.value = false;
}
function dismiss() {
  cancelLookup();
  dialog.value?.close();
}
function closed() {
  // A close event from an earlier opening must not cancel a newly opened dialog.
  if (!dialog.value?.open) cancelLookup();
}
onScopeDispose(cancelLookup);
async function show() {
  error.value = "";
  dialog.value?.showModal();
  await nextTick();
  input.value?.focus();
}
async function open() {
  if (busy.value || !value.value.trim()) return;
  const controller = new AbortController();
  lookup = controller;
  busy.value = true;
  error.value = "";
  try {
    await props.onOpen(value.value, controller.signal);
    controller.signal.throwIfAborted();
    dialog.value?.close();
    value.value = "";
  } catch (failure) {
    if (!controller.signal.aborted)
      error.value =
        failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (lookup === controller) {
      lookup = undefined;
      busy.value = false;
    }
  }
}
</script>

<template>
  <button class="session-open-button" @click="show">
    <Icon name="terminal" :size="16" />Open session by ID
  </button>
  <dialog
    ref="dialog"
    class="session-dialog"
    aria-labelledby="session-dialog-title"
    @cancel.prevent="dismiss"
    @close="closed"
  >
    <form @submit.prevent="open">
      <div class="session-dialog-heading">
        <span class="session-dialog-icon"
          ><Icon name="terminal" :size="23"
        /></span>
        <button
          type="button"
          class="icon-button"
          aria-label="Close session dialog"
          @click="dismiss"
        >
          <Icon name="close" />
        </button>
      </div>
      <h2 id="session-dialog-title">Continue in this workspace</h2>
      <p>
        Open the same task from your terminal or another browser. Its graph,
        activity, and results stay in sync.
      </p>
      <label for="session-reference">Session ID or Workflow link</label>
      <input
        id="session-reference"
        ref="input"
        v-model="value"
        placeholder="Paste a task ID, run ID, or link"
        autocomplete="off"
        spellcheck="false"
        :disabled="busy"
      />
      <p class="session-dialog-hint">
        This opens a session in the current project. Opening a paused session
        leaves it paused until you choose Resume.
      </p>
      <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
      <div class="session-dialog-actions">
        <button type="button" @click="dismiss">Cancel</button>
        <button type="submit" class="primary" :disabled="busy || !value.trim()">
          {{ busy ? "Opening…" : "Open session" }}
        </button>
      </div>
    </form>
  </dialog>
</template>
