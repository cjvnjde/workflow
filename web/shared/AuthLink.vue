<script setup lang="ts">
defineProps<{ url: string }>();
</script>
<template>
  <!-- Provider messages must never become executable URLs. -->
  <a v-if="/^https?:\/\//i.test(url)" :href="url" target="_blank" rel="noopener noreferrer"
    ><slot /> ↗</a
  >
</template>
