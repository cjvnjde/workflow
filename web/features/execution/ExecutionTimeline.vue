<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ExecutionOperation, WorkflowRun } from "../../../src/contracts/index.js";
import { executionTimeline, type TimelineRow } from "./execution-timeline.js";
import { durationLabel } from "./operation-presentation.js";
const props = defineProps<{
  run: WorkflowRun;
  operations: ExecutionOperation[];
  selected?: string;
  selectedKey?: string;
  visit?: number;
}>();
const emit = defineEmits<{
  select: [key: string];
  step: [nodeId: string, visit: number];
  range: [value: { start: number; end: number } | undefined];
}>();
const mode = ref<"time" | "sequence">("time");
const zoom = ref(1);
const page = ref(0);
const startSelection = ref<number>();
const selectedRange = ref<{ start: number; end: number }>();
const model = computed(() => executionTimeline(props.run, props.operations, mode.value));
const rows = computed(() =>
  model.value.rows.filter(
    (row) =>
      (!props.selected || row.nodeId === props.selected) &&
      (props.visit === undefined || row.visit === props.visit),
  ),
);
const pages = computed(() => Math.max(1, Math.ceil(rows.value.length / 80)));
const visible = computed(() => rows.value.slice(page.value * 80, (page.value + 1) * 80));
watch([() => props.selected, () => props.visit, mode], () => {
  page.value = 0;
  clearRange();
});
watch(pages, (count) => (page.value = Math.min(page.value, count - 1)));
watch(
  () => props.selectedKey,
  (key) => {
    const index = rows.value.findIndex((row) => row.operationKey === key);
    if (index >= 0) page.value = Math.floor(index / 80);
  },
);
function select(row: TimelineRow) {
  if (row.operationKey) emit("select", row.operationKey);
  else if (row.nodeId && row.visit) emit("step", row.nodeId, row.visit);
}
function position(value: number) {
  return ((value - model.value.start) / (model.value.end - model.value.start)) * 100;
}
function pointerTime(event: PointerEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return (
    model.value.start +
    Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) *
      (model.value.end - model.value.start)
  );
}
function down(event: PointerEvent) {
  if (mode.value !== "time" || event.button !== 0) return;
  startSelection.value = pointerTime(event);
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function up(event: PointerEvent) {
  if (startSelection.value === undefined) return;
  const end = pointerTime(event),
    start = startSelection.value;
  startSelection.value = undefined;
  if (Math.abs(end - start) < (model.value.end - model.value.start) / 200) return;
  selectedRange.value = {
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
  emit("range", selectedRange.value);
}
function clearRange() {
  selectedRange.value = undefined;
  emit("range", undefined);
}
function title(row: TimelineRow) {
  return `${row.label} · ${row.state} · ${row.settled && mode.value === "time" ? durationLabel(row.end - row.start) : "No completed duration"}${mode.value === "time" ? " · " + new Date(row.start).toLocaleTimeString() : ""}`;
}
</script>
<template>
  <section class="execution-timeline" aria-label="Execution timeline">
    <div class="timeline-toolbar">
      <h3>Timeline</h3>
      <label
        >Display<select v-model="mode">
          <option value="time">Wall-clock time</option>
          <option value="sequence">Operation sequence</option>
        </select></label
      ><label
        >Zoom<input
          v-model.number="zoom"
          aria-label="Timeline zoom"
          type="range"
          min="1"
          max="8"
          step="0.5" /></label
      ><button
        class="quiet"
        @click="
          zoom = 1;
          clearRange();
        "
      >
        Reset view
      </button>
    </div>
    <p>
      Each step visit has its own lane. Select a span to inspect it.<template
        v-if="mode === 'time'"
      >
        Drag across the time ruler to filter calls; scroll horizontally when zoomed. Unfinished
        operations show their recorded start only.</template
      >
    </p>
    <div class="timeline-scroll">
      <div class="timeline-grid" :style="{ minWidth: `${Math.max(600, 600 * zoom)}px` }">
        <div class="timeline-ruler-label">
          {{ mode === "time" ? "Recorded time" : "Call order" }}
        </div>
        <div
          class="timeline-ruler"
          aria-label="Select time range"
          @pointerdown="down"
          @pointerup="up"
          @pointercancel="startSelection = undefined"
        >
          <span
            v-for="fraction in [0, 0.25, 0.5, 0.75, 1]"
            :key="fraction"
            :style="{ left: `${fraction * 100}%` }"
            >{{
              mode === "time"
                ? durationLabel((model.end - model.start) * fraction)
                : Math.round(model.start + (model.end - model.start) * fraction)
            }}</span
          >
          <div
            v-if="selectedRange"
            class="range-highlight"
            :style="{
              left: `${position(selectedRange.start)}%`,
              width: `${position(selectedRange.end) - position(selectedRange.start)}%`,
            }"
          />
        </div>
        <template v-for="row in visible" :key="row.key"
          ><button
            class="timeline-label"
            :class="{ child: row.operationKey }"
            :title="row.label"
            @click="select(row)"
          >
            {{ row.label }}
          </button>
          <div class="timeline-lane">
            <button
              class="timeline-span"
              :class="[
                row.state,
                {
                  child: row.operationKey,
                  selected: selectedKey === row.operationKey,
                  marker: !row.settled && mode === 'time',
                },
              ]"
              :style="{
                left: `${position(row.start)}%`,
                width: `${Math.max(0, position(row.end) - position(row.start))}%`,
              }"
              :aria-label="title(row)"
              :title="title(row)"
              @click="select(row)"
            >
              <span class="sr-only">{{ row.label }}</span>
            </button>
          </div></template
        >
      </div>
    </div>
    <p v-if="!rows.length">No recorded timing for this selection.</p>
    <div v-if="pages > 1" class="timeline-pages">
      <button :disabled="page === 0" @click="page--">Previous lanes</button
      ><span
        >Lanes {{ page * 80 + 1 }}–{{ Math.min((page + 1) * 80, rows.length) }} of
        {{ rows.length }}</span
      ><button :disabled="page + 1 >= pages" @click="page++">Next lanes</button>
    </div>
  </section>
</template>
<style scoped>
.execution-timeline {
  border: 1px solid var(--ui-edge);
  border-radius: 10px;
  padding: 12px;
  margin-top: 16px;
  min-width: 0;
}
.timeline-toolbar {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
}
.timeline-toolbar h3 {
  font-size: 13px;
  margin: 0;
  flex: 1;
}
.timeline-toolbar label {
  font-size: 11px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.timeline-toolbar select {
  width: auto;
}
.timeline-toolbar input {
  width: 100px;
}
.execution-timeline p {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.6;
}
.timeline-scroll {
  overflow: auto;
  max-height: 500px;
  padding-right: 12px;
}
.timeline-grid {
  display: grid;
  grid-template-columns: 180px 1fr;
}
.timeline-ruler-label,
.timeline-label {
  padding: 8px;
  font-size: 11px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline-label {
  border: none;
  border-bottom: 1px solid var(--ui-edge);
  border-radius: 0;
  background: transparent;
}
.timeline-label.child {
  padding-left: 24px;
  color: var(--muted);
}
.timeline-ruler {
  position: relative;
  height: 36px;
  touch-action: none;
  cursor: crosshair;
  border-bottom: 1px solid var(--ui-edge);
  user-select: none;
}
.timeline-ruler span {
  position: absolute;
  top: 8px;
  font-size: 10px;
  color: var(--muted);
  transform: translateX(-50%);
}
.timeline-ruler span:first-child {
  transform: none;
}
.timeline-ruler span:last-of-type {
  transform: translateX(-100%);
}
.timeline-lane {
  position: relative;
  height: 34px;
  border-bottom: 1px solid var(--ui-edge);
  background: repeating-linear-gradient(
    to right,
    transparent,
    transparent calc(25% - 1px),
    var(--ui-edge) 25%
  );
}
.timeline-span {
  position: absolute;
  top: 10px;
  height: 13px;
  min-height: 0;
  min-width: 5px;
  border: 0;
  border-radius: 3px;
  background: var(--accent);
  padding: 0;
  opacity: 0.8;
}
.timeline-span.child {
  height: 9px;
  top: 12px;
  background: var(--ctp-blue);
}
.timeline-span.failed,
.timeline-span.interrupted {
  background: var(--ctp-red);
}
.timeline-span.started,
.timeline-span.progress {
  background: var(--ctp-yellow);
}
.timeline-span.marker {
  width: 4px !important;
  min-width: 4px;
  border-radius: 0;
}
.timeline-span.selected,
.timeline-span:focus-visible {
  outline: 2px solid var(--text);
  outline-offset: 2px;
  opacity: 1;
}
.range-highlight {
  position: absolute;
  height: 100%;
  background: color-mix(in srgb, var(--accent) 25%, transparent);
  pointer-events: none;
}
.timeline-pages {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  gap: 8px;
  margin-top: 10px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
