<script setup lang="ts">
import { onScopeDispose, ref } from "vue";
import {
  attachmentSchema,
  type Attachment,
} from "../../src/capability-schema.js";
import { request } from "../api.js";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    onSubmit: (prompt: string, attachments: string[]) => Promise<void>;
    automatic: boolean;
    initialText?: string;
  }>(),
  { initialText: "" },
);
const emit = defineEmits<{ settings: [] }>();
const text = ref(props.initialText);
const files = ref<Attachment[]>([]);
const uploading = ref(false);
const submitting = ref(false);
const error = ref("");
const dragging = ref(false);
const picker = ref<HTMLInputElement>();
const input = ref<HTMLTextAreaElement>();
let uploadController: AbortController | undefined;
function cancelUpload() {
  uploadController?.abort();
}
onScopeDispose(cancelUpload);
function discard() {
  cancelUpload();
  text.value = "";
  files.value = [];
  error.value = "";
}
const suggestions = [
  "Find and fix a bug in this project",
  "Build a feature from my screenshots",
  "Review this code and suggest improvements",
];

async function attach(selected: File[]) {
  if (uploading.value || submitting.value || !selected.length) {
    return;
  }
  if (selected.length + files.value.length > 8) {
    error.value = "Attach up to eight files per task.";
    return;
  }
  uploading.value = true;
  const controller = new AbortController();
  uploadController = controller;
  error.value = "";
  try {
    for (const file of selected) {
      controller.signal.throwIfAborted();
      if (file.size > 6_000_000) {
        throw new Error(`${file.name} exceeds 6 MB.`);
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        const abort = () => {
          reader.abort();
          reject(controller.signal.reason);
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        reader.onloadend = () =>
          controller.signal.removeEventListener("abort", abort);
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
        reader.onload = () =>
          resolve(String(reader.result).split(",")[1] ?? "");
        reader.readAsDataURL(file);
      });
      controller.signal.throwIfAborted();
      const attached = await request("/api/attachments", attachmentSchema, {
        method: "POST",
        body: {
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          data,
        },
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      files.value.push(attached);
    }
  } catch (failure) {
    if (!controller.signal.aborted)
      error.value =
        failure instanceof Error ? failure.message : String(failure);
  } finally {
    uploading.value = false;
    if (uploadController === controller) uploadController = undefined;
    if (picker.value) {
      picker.value.value = "";
    }
  }
}
async function submit() {
  if (!text.value.trim() || uploading.value || submitting.value) {
    return;
  }
  submitting.value = true;
  error.value = "";
  try {
    await props.onSubmit(
      text.value.trim(),
      files.value.map((file) => file.id),
    );
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
    submitting.value = false;
  }
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}
function paste(event: ClipboardEvent) {
  const images = Array.from(event.clipboardData?.files ?? []);
  if (images.length) {
    event.preventDefault();
    void attach(images);
  }
}
function leave(event: DragEvent) {
  if (
    !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)
  ) {
    dragging.value = false;
  }
}
function drop(event: DragEvent) {
  dragging.value = false;
  void attach(Array.from(event.dataTransfer?.files ?? []));
}
</script>

<template>
  <div class="composer-wrap">
    <div
      class="task-composer"
      :class="{ dragging }"
      @dragover.prevent="dragging = true"
      @dragleave="leave"
      @drop.prevent="drop"
    >
      <div v-if="files.length" class="attachment-tray">
        <div v-for="file in files" :key="file.id" class="attachment-chip">
          <img
            v-if="file.kind === 'image'"
            :src="`/api/attachments/${file.id}`"
            :alt="file.name"
          />
          <Icon v-else name="file" :size="22" />
          <span
            >{{ file.name
            }}<small>{{ Math.ceil(file.size / 1000) }} KB</small></span
          >
          <button
            class="icon-button"
            :aria-label="`Remove ${file.name}`"
            :disabled="submitting"
            @click="files = files.filter((item) => item.id !== file.id)"
          >
            <Icon name="close" :size="14" />
          </button>
        </div>
      </div>
      <textarea
        v-autosize
        ref="input"
        v-model="text"
        aria-label="What should we work on?"
        placeholder="Describe what you want to build, fix, or explore…"
        :maxlength="32_000"
        :disabled="submitting"
        :rows="4"
        @keydown="keydown"
        @paste="paste"
      />
      <div class="composer-controls">
        <input
          ref="picker"
          type="file"
          multiple
          hidden
          aria-label="Attach files"
          @change="
            attach(Array.from(($event.target as HTMLInputElement).files ?? []))
          "
        />
        <button
          type="button"
          class="attach-button"
          :disabled="uploading || submitting"
          @click="picker?.click()"
        >
          <Icon name="plus" />{{ uploading ? "Attaching…" : "Attach files" }}
        </button>
        <span class="composer-hint"
          >Paste screenshots · Shift + Enter for a new line</span
        >
        <button v-if="uploading" type="button" @click="cancelUpload">
          Cancel upload
        </button>
        <button
          v-if="text || files.length"
          type="button"
          class="quiet"
          :disabled="submitting"
          @click="discard"
        >
          Discard task draft
        </button>
        <button
          class="send-button"
          aria-label="Start task"
          title="Start task"
          :disabled="!text.trim() || uploading || submitting"
          @click="submit"
        >
          <Icon name="arrow" :size="22" />
        </button>
      </div>
      <div v-if="dragging" class="drop-overlay">
        <Icon name="image" :size="28" />Drop files to add context
      </div>
    </div>
    <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
    <div class="composer-footer">
      <span
        ><Icon :name="automatic ? 'spark' : 'shield'" :size="14" />{{
          automatic
            ? "Automatic execution enabled"
            : "You review the workflow before it runs"
        }}</span
      >
      <button @click="emit('settings')">Change in Settings</button>
    </div>
    <div v-if="!text && !files.length" class="prompt-suggestions">
      <button
        v-for="(prompt, index) in suggestions"
        :key="prompt"
        @click="
          text = prompt;
          input?.focus();
        "
      >
        <Icon
          :name="index === 0 ? 'code' : index === 1 ? 'image' : 'search'"
        /><span>{{ prompt }}</span>
      </button>
    </div>
  </div>
</template>
