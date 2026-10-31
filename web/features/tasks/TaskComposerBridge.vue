<script setup lang="ts">
import { computed } from "vue";
import type { Attachment } from "../../../src/contracts/index.js";
import ReactIsland from "../../shared/ReactIsland.vue";
import { TaskComposerReact } from "./TaskComposerReact.js";

const props = defineProps<{
  text: string;
  files: Attachment[];
  automatic: boolean;
  onSubmit: (prompt: string, attachments: string[]) => Promise<void>;
}>();
const emit = defineEmits<{
  "update:text": [value: string];
  "update:files": [value: Attachment[]];
  settings: [];
  discard: [];
}>();

const componentProps = computed(() => ({
  text: props.text,
  files: props.files,
  automatic: props.automatic,
  onTextChange: (value: string) => emit("update:text", value),
  onFilesChange: (value: Attachment[]) => emit("update:files", value),
  onSubmit: props.onSubmit,
  onSettings: () => emit("settings"),
  onDiscard: () => emit("discard"),
}));
</script>

<template>
  <ReactIsland :component="TaskComposerReact" :component-props="componentProps" />
</template>
