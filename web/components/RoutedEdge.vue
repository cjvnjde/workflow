<script setup lang="ts">
import { computed } from "vue";
import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@vue-flow/core";
import { routedEdge, type Obstacle } from "../edge-routing.js";
const props = defineProps<EdgeProps>();
const route = computed(() => {
  const result = routedEdge(
    { x: props.sourceX, y: props.sourceY },
    { x: props.targetX, y: props.targetY },
    props.sourcePosition,
    props.targetPosition,
    (props.data?.obstacles ?? []) as Obstacle[],
  );
  if (result.path) return result;
  const [path, x, y] = getSmoothStepPath(props);
  return { path, label: { x, y } };
});
</script>
<template>
  <BaseEdge
    :id="id"
    :path="route.path"
    :style="style"
    :marker-end="markerEnd"
    :interaction-width="0"
    :label="label"
    :label-x="route.label.x"
    :label-y="route.label.y"
    :label-style="labelStyle"
    :label-bg-style="labelBgStyle"
  />
</template>
