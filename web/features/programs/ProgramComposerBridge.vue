<script setup lang="ts">
import { computed } from "vue";
import type { ProgramSource } from "../../../src/contracts/index.js";
import ReactIsland from "../../shared/ReactIsland.vue";
import { ProgramComposerReact } from "./ProgramComposerReact.js";

const props = defineProps<{
  onSubmit: (
    value: ProgramSource & { title: string; task: string },
    signal: AbortSignal,
  ) => Promise<void>;
}>();
const componentProps = computed(() => ({ onSubmit: props.onSubmit }));
</script>

<template>
  <ReactIsland :component="ProgramComposerReact" :component-props="componentProps" />
</template>
