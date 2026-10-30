<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, useId } from "vue";
import type { StrategyPreview, RememberStrategyResult } from "../../../src/contracts/index.js";
import { WorkflowApiError } from "../../../src/client/client.js";
import { client } from "../../shared/api.js";
import Field from "../../shared/Field.vue";
import Icon from "../../shared/Icon.vue";
import StrategyFacts from "./StrategyFacts.vue";
const props = defineProps<{ runId: string }>();
const emit = defineEmits<{ settings: [] }>();
const titleId = useId();
const dialog = ref<HTMLDialogElement>();
const trigger = ref<HTMLButtonElement>();
const preview = ref<StrategyPreview>();
const saved = ref<RememberStrategyResult>();
const form = ref({ title: "", description: "", details: "", tags: "" });
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const notice = ref("");
const conflict = ref(false);
const remembered = ref(false);
let read: AbortController | undefined;
let readVersion = 0;
let disposed = false;
const existing = computed(() => saved.value?.entry ?? preview.value?.existingEntry);
const metadata = computed(
  () =>
    saved.value?.entry.strategy ??
    preview.value?.existingEntry?.strategy ??
    preview.value?.metadata,
);
function stopRead() {
  readVersion++;
  read?.abort();
  loading.value = false;
}
async function load(preserve = false) {
  stopRead();
  const version = ++readVersion;
  const controller = new AbortController();
  read = controller;
  loading.value = true;
  error.value = "";
  notice.value = "";
  try {
    const value = await client.strategyPreview(props.runId, controller.signal);
    if (controller.signal.aborted || disposed || version !== readVersion) return;
    preview.value = value;
    remembered.value = !!value.existingEntry;
    conflict.value = false;
    if (!preserve) form.value = { ...value.entry, tags: value.entry.tags.join(", ") };
    else
      notice.value =
        "Latest source facts and memory revision loaded. Your draft is unchanged; review before saving.";
  } catch (failure) {
    if (!controller.signal.aborted && !disposed && version === readVersion)
      error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (version === readVersion && !disposed) loading.value = false;
  }
}
async function show() {
  preview.value = undefined;
  saved.value = undefined;
  conflict.value = false;
  error.value = "";
  notice.value = "";
  dialog.value?.showModal();
  await nextTick();
  void load();
}
function dismiss() {
  if (saving.value) return;
  stopRead();
  dialog.value?.close();
  trigger.value?.focus();
}
function closed() {
  if (!dialog.value?.open) stopRead();
}
function fields() {
  const tags = form.value.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.length > 8 || tags.some((tag) => tag.length > 40))
    throw new Error("Use at most 8 tags, with at most 40 characters each.");
  return {
    title: form.value.title.trim(),
    description: form.value.description.trim(),
    details: form.value.details,
    tags,
  };
}
async function save() {
  if (!preview.value || saving.value || loading.value || existing.value || conflict.value) return;
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await client.rememberStrategy(props.runId, {
      ...fields(),
      sourceRunRevision: preview.value.sourceRunRevision,
      memoryRevision: preview.value.memoryRevision,
    });
    if (disposed) return;
    saved.value = result;
    remembered.value = true;
    notice.value = result.state.enabled
      ? "Approach remembered. Future planning can consult this strategy."
      : "Approach saved. Project memory remains off. Enable it in Settings → Memory when you want future planning to consult this strategy.";
  } catch (failure) {
    if (!disposed) {
      error.value = failure instanceof Error ? failure.message : String(failure);
      conflict.value = failure instanceof WorkflowApiError && failure.status === 409;
    }
  } finally {
    if (!disposed) saving.value = false;
  }
}
async function copyDraft() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(fields(), null, 2));
    notice.value = "Draft copied.";
  } catch {
    error.value = "The clipboard is unavailable. Your draft remains in the fields below.";
  }
}
function settings() {
  dismiss();
  emit("settings");
}
onScopeDispose(() => {
  disposed = true;
  stopRead();
});
</script>

<template>
  <button ref="trigger" class="quiet" @click="show">
    <Icon name="file" :size="14" />{{
      remembered ? "Approach remembered" : "Remember this approach"
    }}
  </button>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="remember-dialog"
      :aria-labelledby="titleId"
      @cancel.prevent="dismiss"
      @close="closed"
    >
      <div class="remember-heading">
        <div>
          <span class="eyebrow">REUSABLE STRATEGY</span>
          <h2 :id="titleId">Remember this approach</h2>
        </div>
        <button
          class="icon-button"
          :disabled="saving"
          aria-label="Close strategy preview"
          @click="dismiss"
        >
          <Icon name="close" />
        </button>
      </div>
      <p class="remember-intro">
        Keep the approach you found useful as concise guidance. Future tasks get a fresh workflow
        using current blocks, models and approvals.
      </p>
      <p class="remember-boundary">
        This preview uses recorded metadata and makes no model requests. It stores no executable
        graph, source code, conversation or artifact contents. Saving is your endorsement, not a
        quality rating.
      </p>
      <p v-if="loading" role="status">Loading strategy preview…</p>
      <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
      <p v-if="notice" class="setup-notice" role="status">{{ notice }}</p>
      <button v-if="error && !preview" :disabled="loading" @click="load()">
        Retry strategy preview
      </button>
      <form v-if="preview" @submit.prevent="save">
        <div v-if="existing" class="setup-notice" role="status">
          <strong>Already remembered</strong>
          <p>
            A strategy is already saved for this source workflow. Edit or delete it in Settings →
            Memory. Opening this preview does not create another entry.
          </p>
          <small>Entry {{ existing.id }}</small>
        </div>
        <p class="remember-mode">
          {{
            (saved?.state.enabled ?? preview.memoryEnabled)
              ? "Project memory is enabled."
              : existing
                ? "Project memory is off. Saved strategies are retained, but future planning will not read them."
                : "Project memory is off. Saving this strategy will keep it off."
          }}
          <template v-if="!existing">Nothing is saved until you choose Save strategy.</template>
        </p>
        <fieldset class="settings-fields" :disabled="saving || loading || !!existing">
          <Field v-slot="{ id }" label="Strategy title"
            ><input :id="id" v-model="form.title" required maxlength="100"
          /></Field>
          <Field
            v-slot="{ id }"
            label="When this is useful"
            help="Up to 300 characters. Future planners see this description before loading details."
          >
            <textarea :id="id" v-model="form.description" required rows="2" maxlength="300" />
          </Field>
          <Field
            v-slot="{ id }"
            label="Reusable guidance"
            help="Up to 4,000 characters. Describe the approach, roles and checks worth repeating."
          >
            <textarea :id="id" v-model="form.details" rows="6" maxlength="4000" />
          </Field>
          <Field
            v-slot="{ id }"
            label="Strategy tags"
            help="Optional, comma separated. Up to 8 tags of 40 characters each."
            ><input :id="id" v-model="form.tags"
          /></Field>
        </fieldset>
        <div v-if="conflict" class="remember-conflict" role="status">
          <p>The source workflow or saved memory changed. Your draft is preserved.</p>
          <button type="button" :disabled="loading || saving" @click="load(true)">
            Review latest source & memory
          </button>
        </div>
        <details v-if="existing && !saved" class="remember-existing">
          <summary>Saved strategy text</summary>
          <strong>{{ existing.title }}</strong>
          <p>{{ existing.description }}</p>
          <pre>{{ existing.details }}</pre>
        </details>
        <details v-if="metadata" class="remember-evidence" open>
          <summary>Review source facts</summary>
          <StrategyFacts :metadata="metadata" />
        </details>
        <div class="remember-actions">
          <button v-if="existing || conflict" type="button" :disabled="saving" @click="copyDraft">
            Copy my draft</button
          ><button v-if="existing" type="button" @click="settings">Open Settings</button
          ><button type="button" :disabled="saving" @click="dismiss">
            {{ saved || existing ? "Done" : "Cancel" }}</button
          ><button
            v-if="!existing"
            type="submit"
            class="primary"
            :disabled="
              saving || loading || conflict || !form.title.trim() || !form.description.trim()
            "
          >
            {{ saving ? "Saving…" : "Save strategy" }}
          </button>
        </div>
      </form>
      <div v-else class="remember-actions">
        <button type="button" @click="dismiss">Cancel</button>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.remember-dialog {
  width: min(760px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  overflow: auto;
  padding: 26px;
  border: 1px solid var(--ctp-surface1);
  border-radius: 16px;
  background: var(--ctp-base);
  color: var(--ctp-text);
  box-shadow: 0 24px 80px #0008;
}
.remember-dialog::backdrop {
  background: #11111baa;
  backdrop-filter: blur(3px);
}
.remember-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.remember-heading h2 {
  margin: 7px 0 16px;
  font-size: 22px;
}
.remember-heading .icon-button {
  flex-shrink: 0;
}
.remember-intro,
.remember-boundary,
.remember-mode {
  line-height: 1.6;
  color: var(--ctp-subtext0);
}
.remember-boundary {
  font-size: 11px;
}
.remember-mode {
  padding: 12px;
  border: 1px solid var(--ctp-surface1);
  border-radius: 8px;
}
.remember-dialog textarea {
  resize: vertical;
}
.remember-evidence,
.remember-existing {
  margin: 18px 0;
  border-top: 1px solid var(--ctp-surface1);
  padding-top: 16px;
}
.remember-evidence > summary,
.remember-existing > summary {
  cursor: pointer;
  margin-bottom: 18px;
}
.remember-existing pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 12px;
  background: var(--ctp-mantle);
  border-radius: 8px;
}
.remember-conflict {
  padding: 14px;
  border: 1px solid var(--ctp-yellow);
  border-radius: 8px;
}
.remember-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 22px;
}
.remember-dialog .setup-notice {
  display: block;
  overflow-wrap: anywhere;
}
.remember-dialog .setup-notice p {
  line-height: 1.6;
}
@media (max-width: 640px) {
  .remember-dialog {
    padding: 18px;
  }
  .remember-actions button {
    flex: 1 1 auto;
  }
}
</style>
