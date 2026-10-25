<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  VueFlow,
  Handle,
  Position,
  MarkerType,
  BaseEdge,
  type Node,
  type Edge,
  type EdgeProps,
  type NodeDragEvent,
  useVueFlow,
} from "@vue-flow/core";
import RoutedEdge from "./RoutedEdge.vue";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { resolveAgentSettings, type WorkflowRun } from "../../src/domain.js";
import { compositionLayout, routedPositions } from "../graph-layout.js";
import { stepState } from "../workflow-status.js";
import { executionLabel, isSourceWorkflow } from "../execution-label.js";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
const props = defineProps<{ run: WorkflowRun }>();
const emit = defineEmits<{ select: [id: string] }>();
const { fitView, dimensions, getNodes } = useVueFlow();
const motionDuration = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250;
let focusedNodes: string[] | undefined;
function fitViewport() {
  if (!dimensions.value.width || !dimensions.value.height) return;
  void fitView({
    nodes: focusedNodes,
    padding: focusedNodes ? 0.3 : layout.value ? 0.07 : 0.18,
    maxZoom: 1.1,
    duration: motionDuration(),
  });
}
function fit() {
  focusedNodes = undefined;
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
  focusedNodes = props.run.plan.nodes
    .filter((node) => stepState(props.run, node.id) === "running")
    .map((node) => node.id);
  if (focusedNodes.length === 1) emit("select", focusedNodes[0]!);
  await nextTick();
  fitViewport();
}
const layout = computed(() =>
  props.run.program?.structure
    ? compositionLayout(props.run.program.structure)
    : undefined,
);
const routed = computed(() => routedPositions(props.run.plan));
const nodes = computed<Node[]>(() => [
  ...(layout.value?.nodes
    .filter((node) => node.kind !== "step")
    .map((node) => ({
      id: node.id,
      type: node.kind,
      position: node.position,
      draggable: false,
      selectable: node.kind === "group",
      data: {
        label: node.label,
        detail: node.detail,
        condition: node.condition,
        state: props.run.groups?.[node.id],
        horizontal: true,
      },
      style: { width: `${node.width}px`, height: `${node.height}px` },
      class:
        node.kind === "group" ? "composition-group" : "composition-junction",
      zIndex: node.kind === "group" ? 0 : 1,
    })) ?? []),
  ...props.run.plan.nodes.map((node) => {
    const { run } = props;
    const block = run.blocks[node.block]?.definition;
    const settings = resolveAgentSettings(
      run.config.agent,
      block?.agent,
      node.agent,
    );
    const status = stepState(run, node.id);
    const current = status === "running";
    const state = current ? "active" : status === "failed" ? "fail" : status;
    const placement = layout.value?.nodes.find((item) => item.id === node.id);
    return {
      id: node.id,
      type: "workflow",
      position: positions.value[node.id] ??
        placement?.position ??
        routed.value[node.id] ?? { x: 0, y: 0 },
      extent: placement?.extent,
      data: {
        block: node.block,
        visits: run.visits[node.id] ?? 0,
        maxVisits: node.maxVisits,
        label: node.label,
        model: block?.executor
          ? block.executor.kind === "code" && node.agent?.model
            ? `${executionLabel(block.executor)} · ${settings.model}`
            : executionLabel(block.executor)
          : (settings.model ?? "orchestrator chooses"),
        thinking:
          block?.executor &&
          !(block.executor.kind === "code" && node.agent?.model)
            ? block.executor.kind
            : settings.thinking,
        state,
        current,
        horizontal: !!layout.value,
      },
      class: `workflow-node ${layout.value ? "composition-step" : ""} ${state}`,
      style: {
        width: `${placement?.width ?? 260}px`,
        height: `${placement?.height ?? 184}px`,
      },
    };
  }),
  {
    id: "$complete",
    position: positions.value.$complete ?? {
      x: layout.value ? layout.value.width + 96 : 60,
      y: layout.value
        ? (() => {
            const exit = layout.value.nodes.find(
              (node) => node.id === layout.value!.exit,
            )!;
            return exit.position.y + exit.height / 2 - 20;
          })()
        : Math.max(0, ...Object.values(routed.value).map((point) => point.y)) +
          280,
    },
    data: {},
    label: "✓ Complete",
    class: "terminal complete",
    targetPosition: layout.value ? Position.Left : Position.Top,
  },
  ...(!layout.value
    ? [
        {
          id: "$failed",
          position: positions.value.$failed ?? {
            x:
              Math.max(
                0,
                ...Object.values(routed.value).map((point) => point.x),
              ) + 380,
            y: 0,
          },
          data: {},
          label: "× Stop / failed",
          class: "terminal failed",
        },
      ]
    : []),
]);
const obstacles = computed(() =>
  nodes.value.map((node) => {
    const measured = getNodes.value.find((item) => item.id === node.id);
    const position = measured?.computedPosition ?? node.position;
    const style = node.style as { width?: string; height?: string } | undefined;
    return {
      x: position.x,
      y: position.y,
      width: measured?.dimensions.width || parseFloat(style?.width ?? "160"),
      height:
        node.type === "group"
          ? 48
          : measured?.dimensions.height || parseFloat(style?.height ?? "40"),
    };
  }),
);
const edges = computed<Edge[]>(() =>
  (layout.value
    ? [...layout.value.edges, { from: layout.value.exit, to: "$complete" }].map(
        (edge) => ({
          from: edge.from,
          target: edge.to,
          outcome: edge.repeat ? "retry" : "pass",
          label: edge.label,
          returnY: "returnY" in edge ? edge.returnY : undefined,
          returnSide: "returnSide" in edge ? edge.returnSide : undefined,
        }),
      )
    : isSourceWorkflow(props.run)
      ? [
          ...new Map(
            (props.run.transitions ?? []).map((edge) => [
              `${edge.from}-${edge.to}-${edge.outcome}`,
              edge,
            ]),
          ).values(),
        ].map((edge) => ({
          from: edge.from,
          target: edge.to,
          outcome: edge.outcome,
        }))
      : props.run.plan.nodes.flatMap((node) =>
          Object.entries(node.on).map(([outcome, target]) => ({
            from: node.id,
            target,
            outcome,
          })),
        )
  ).map(({ from, target, outcome, ...extra }) => ({
    id: `${from}-${target}-${outcome}`,
    source: from,
    target,
    type:
      "returnY" in extra && extra.returnY !== undefined
        ? "loop-return"
        : "obstacle",
    sourceHandle:
      "returnY" in extra && extra.returnY !== undefined
        ? `return-output-${"returnSide" in extra ? extra.returnSide : "top"}`
        : undefined,
    targetHandle:
      "returnY" in extra && extra.returnY !== undefined
        ? `return-input-${"returnSide" in extra ? extra.returnSide : "top"}`
        : undefined,
    data: {
      returnY: "returnY" in extra ? extra.returnY : undefined,
      obstacles: obstacles.value,
    },
    selectable: false,
    focusable: false,
    interactionWidth: 0,
    label: layout.value
      ? "label" in extra
        ? (extra.label as string)
        : undefined
      : isSourceWorkflow(props.run) && outcome === "pass"
        ? "next"
        : outcome,
    animated: stepState(props.run, from) === "running",
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
      pointerEvents: "none",
    },
    labelStyle: { fill: "var(--ctp-subtext1)", fontSize: 10 },
    labelBgStyle: { fill: "var(--ctp-mantle)" },
  })),
);
function returnPath(edge: EdgeProps) {
  const y = Number(edge.data.returnY);
  const direction = Math.sign(edge.targetX - edge.sourceX) || -1;
  const radius = 8;
  const sourceCorner = y + Math.sign(edge.sourceY - y) * radius;
  const targetCorner = y + Math.sign(edge.targetY - y) * radius;
  return `M ${edge.sourceX} ${edge.sourceY} L ${edge.sourceX} ${sourceCorner} Q ${edge.sourceX} ${y} ${edge.sourceX + direction * radius} ${y} L ${edge.targetX - direction * radius} ${y} Q ${edge.targetX} ${y} ${edge.targetX} ${targetCorner} L ${edge.targetX} ${edge.targetY}`;
}
</script>

<template>
  <VueFlow
    class="workflow-graph"
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
    <template #edge-obstacle="edge"><RoutedEdge v-bind="edge" /></template>
    <template #edge-loop-return="edge">
      <BaseEdge
        :id="edge.id"
        :path="returnPath(edge)"
        :style="edge.style"
        :marker-end="edge.markerEnd"
        :interaction-width="0"
        :label="edge.label"
        :label-x="(edge.sourceX + edge.targetX) / 2"
        :label-y="Number(edge.data.returnY)"
        :label-style="edge.labelStyle"
        :label-bg-style="edge.labelBgStyle"
      />
    </template>
    <template #node-group="{ data }">
      <div class="composition-heading">
        <strong
          :title="data.condition ? `Predicate: ${data.condition}` : undefined"
          >{{ data.label }}</strong
        ><span>{{ data.detail }}</span
        ><small v-if="data.state"
          >{{ data.state.state
          }}<template v-if="data.state.iteration">
            · round {{ data.state.iteration }}</template
          ><template v-if="data.state.decision">
            · {{ data.state.decision.route
            }}<template v-if="data.state.decision.result !== undefined">
              ({{ data.state.decision.result }})</template
            ></template
          ></small
        >
      </div>
    </template>
    <template #node-junction>
      <Handle type="target" :position="Position.Left" /><Handle
        type="source"
        :position="Position.Right"
      />
      <Handle id="return-input-top" type="target" :position="Position.Top" />
      <Handle id="return-output-top" type="source" :position="Position.Top" />
      <Handle
        id="return-input-bottom"
        type="target"
        :position="Position.Bottom"
      />
      <Handle
        id="return-output-bottom"
        type="source"
        :position="Position.Bottom"
      />
    </template>
    <template #node-workflow="{ data }">
      <Handle
        type="target"
        :position="data.horizontal ? Position.Left : Position.Top"
      />
      <div class="graph-label">
        <small
          >{{ data.block }} · {{ data.visits }}/{{
            data.maxVisits
          }}
          visits</small
        ><strong :title="data.label">{{ data.label }}</strong
        ><span
          >{{ data.model
          }}<template v-if="data.thinking !== 'code'">
            · {{ data.thinking }}</template
          ></span
        ><b>{{ data.current ? "● working" : data.state }}</b>
      </div>
      <Handle
        type="source"
        :position="data.horizontal ? Position.Right : Position.Bottom"
      />
    </template>
    <Background :gap="22" pattern-color="var(--ctp-surface1)" />
    <Controls :show-interactive="false" />
    <div class="graph-toolbar">
      <span>Drag blocks to arrange</span>
      <button
        v-if="
          run.plan.nodes.some((node) => stepState(run, node.id) === 'running')
        "
        @click="focusActive"
      >
        Focus active {{ (run.activeNodes?.length ?? 1) > 1 ? "steps" : "step" }}
      </button>
      <button @click="fit">Fit workflow</button>
      <button @click="resetLayout">Reset layout</button>
    </div>
  </VueFlow>
</template>
