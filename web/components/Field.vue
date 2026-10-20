<script setup lang="ts">
import { useId } from "vue";
defineProps<{ label: string; help?: string }>();
defineSlots<{ default(props: { id: string }): unknown }>();
const id = useId();
</script>

<template>
  <div class="field">
    <label :for="id">{{ label }}</label>
    <slot :id="id" />
    <small v-if="help">{{ help }}</small>
  </div>
</template>
