<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  VueFlow,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeDragEvent,
  useVueFlow,
} from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { resolveAgentSettings, type WorkflowRun } from "../../src/domain.js";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
const props = defineProps<{ run: WorkflowRun }>();
const emit = defineEmits<{ select: [id: string] }>();
const { fitView, dimensions } = useVueFlow();
const motionDuration = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250;
let focusedNode: string | undefined;
function fitViewport() {
  if (!dimensions.value.width || !dimensions.value.height) return;
  void fitView({
    nodes: focusedNode ? [focusedNode] : undefined,
    padding: focusedNode ? 0.6 : 0.18,
    maxZoom: 1.1,
    duration: motionDuration(),
  });
}
function fit() {
  focusedNode = undefined;
  fitViewport();
}
defineExpose({ fit });
// Vue Flow measures the canvas through ResizeObserver. Fit only after those
// dimensions update, including when the inspector or expanded view opens.
watch(() => [dimensions.value.width, dimensions.value.height], fitViewport);
const positions = ref<Record<string, { x: number; y: number }>>({});
const storageKey = () => `workflow:graph:${props.run.id}`;
watch(
  () => props.run.id,
  () => {
    positions.value = {};
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem(storageKey()) ?? "{}",
      );
      if (saved && typeof saved === "object") {
        for (const [id, point] of Object.entries(saved)) {
          if (
            point &&
            typeof point === "object" &&
            Number.isFinite(point.x) &&
            Number.isFinite(point.y)
          ) {
            positions.value[id] = { x: point.x, y: point.y };
          }
        }
      }
    } catch {
      /* Local layout storage is optional. */
    }
  },
  { immediate: true },
);
function remember({ nodes: moved }: NodeDragEvent) {
  positions.value = {
    ...positions.value,
    ...Object.fromEntries(moved.map((node) => [node.id, { ...node.position }])),
  };
  try {
    localStorage.setItem(storageKey(), JSON.stringify(positions.value));
  } catch {
    /* Quota or private browsing. */
  }
}
async function resetLayout() {
  positions.value = {};
  try {
    localStorage.removeItem(storageKey());
  } catch {
    /* Optional storage. */
  }
  await nextTick();
  fit();
}
async function focusActive() {
  focusedNode = props.run.cursor;
  emit("select", props.run.cursor);
  await nextTick();
  fitViewport();
}
const nodes = computed<Node[]>(() => [
  ...props.run.plan.nodes.map((node, index) => {
    const { run } = props;
    const block = run.blocks[node.block]?.definition;
    const settings = resolveAgentSettings(
      run.config.agent,
      block?.agent,
      node.agent,
    );
    const current =
      ["running", "pausing"].includes(run.status) && run.cursor === node.id;
    const last = run.attempts
      .filter((attempt) => attempt.nodeId === node.id)
      .at(-1);
    const state = current
      ? "active"
      : last?.error
        ? "fail"
        : (last?.result?.outcome ?? "pending");
    return {
      id: node.id,
      type: "workflow",
      position: positions.value[node.id] ?? {
        x: index % 2 === 0 ? 70 : 380,
        y: index * 155 + 25,
      },
      data: {
        block: node.block,
        visits: run.visits[node.id] ?? 0,
        maxVisits: node.maxVisits,
        label: node.label,
        model: block?.executor
          ? `⌘ ${block.executor.kind === "function" ? "Git push" : block.executor.command}`
          : (settings.model ?? "orchestrator chooses"),
        thinking: block?.executor ? block.executor.kind : settings.thinking,
        state,
        current,
      },
      class: `workflow-node ${state}`,
      style: { width: "260px" },
    };
  }),
  {
    id: "$complete",
    position: positions.value.$complete ?? {
      x: 300,
      y: props.run.plan.nodes.length * 155 + 25,
    },
    data: {},
    label: "✓ Complete",
    class: "terminal complete",
  },
  {
    id: "$failed",
    position: positions.value.$failed ?? { x: 720, y: 150 },
    data: {},
    label: "× Stop / failed",
    class: "terminal failed",
  },
]);
const edges = computed<Edge[]>(() =>
  props.run.plan.nodes.flatMap((node) =>
    Object.entries(node.on).map(([outcome, target]) => ({
      id: `${node.id}-${outcome}`,
      source: node.id,
      target,
      type: node.id === target ? "default" : "smoothstep",
      label: outcome,
      animated: props.run.status === "running" && props.run.cursor === node.id,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        stroke:
          outcome === "pass"
            ? "var(--ctp-green)"
            : outcome === "retry"
              ? "var(--ctp-yellow)"
              : "var(--ctp-overlay0)",
        strokeWidth: outcome === "fail" ? 1 : 2,
        strokeDasharray: outcome === "retry" ? "6 4" : undefined,
      },
      labelStyle: { fill: "var(--ctp-subtext1)", fontSize: 10 },
      labelBgStyle: { fill: "var(--ctp-mantle)" },
    })),
  ),
);
</script>

<template>
  <VueFlow
    :nodes="nodes"
    :edges="edges"
    fit-view-on-init
    :nodes-draggable="true"
    :delete-key-code="null"
    :nodes-connectable="false"
    :min-zoom="0.25"
    :max-zoom="1.5"
    @node-click="emit('select', $event.node.id)"
    @node-drag-stop="remember"
  >
    <template #node-workflow="{ data }">
      <Handle type="target" :position="Position.Top" />
      <div class="graph-label">
        <small
          >{{ data.block }} · {{ data.visits }}/{{
            data.maxVisits
          }}
          visits</small
        ><strong>{{ data.label }}</strong
        ><span>{{ data.model }} · {{ data.thinking }}</span
        ><b>{{ data.current ? "● working" : data.state }}</b>
      </div>
      <Handle type="source" :position="Position.Bottom" />
    </template>
    <Background :gap="22" pattern-color="var(--ctp-surface1)" />
    <Controls :show-interactive="false" />
    <div class="graph-toolbar">
      <span>Drag blocks to arrange</span>
      <button
        v-if="['running', 'pausing'].includes(run.status)"
        @click="focusActive"
      >
        Focus active step
      </button>
      <button @click="fit">Fit workflow</button>
      <button @click="resetLayout">Reset layout</button>
    </div>
  </VueFlow>
</template>
