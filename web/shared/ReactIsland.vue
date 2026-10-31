<script setup lang="ts">
import { createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
  component: unknown;
  componentProps: Record<string, unknown>;
}>();

const host = ref<HTMLDivElement>();
let root: Root | undefined;

function render() {
  if (!root) return;
  const component = props.component as ComponentType<Record<string, unknown>>;
  root.render(createElement(component, { ...props.componentProps }));
}

onMounted(() => {
  if (!host.value) return;
  root = createRoot(host.value);
  render();
});

watch(() => [props.component, props.componentProps], render, { deep: true });

onBeforeUnmount(() => {
  root?.unmount();
  root = undefined;
});
</script>

<template>
  <div ref="host" class="contents" />
</template>
