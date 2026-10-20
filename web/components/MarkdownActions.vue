<script setup lang="ts">
import { onScopeDispose, ref } from "vue";
import Icon from "./Icon.vue";
const props = defineProps<{ content: string; filename?: string }>();
const copied = ref(false);
const error = ref("");
let timer: ReturnType<typeof setTimeout>;
onScopeDispose(() => clearTimeout(timer));
async function copy() {
  try {
    await navigator.clipboard.writeText(props.content);
    error.value = "";
    copied.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    error.value = "Clipboard unavailable. Download the Markdown instead.";
  }
}
function download() {
  const url = URL.createObjectURL(
    new Blob([props.content], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = (props.filename ?? "result.md")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 180);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <div class="markdown-actions">
    <button class="quiet" aria-label="Copy Markdown" @click="copy">
      <Icon :name="copied ? 'check' : 'copy'" :size="14" />{{
        copied ? "Copied" : "Copy Markdown"
      }}
    </button>
    <button class="quiet" aria-label="Download Markdown" @click="download">
      <Icon name="download" :size="14" />Download
    </button>
    <small v-if="copied" class="sr-only" role="status">Markdown copied</small>
    <small v-if="error" role="alert">{{ error }}</small>
  </div>
</template>
