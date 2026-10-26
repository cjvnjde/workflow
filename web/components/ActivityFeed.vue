<script setup lang="ts">
import { computed, ref } from "vue";
import type { RunEvent } from "../../src/contracts.js";
import {
  activityCategories,
  describeActivity,
  matchesActivity,
  type ActivityCategory,
} from "../activity.js";
import Icon from "./Icon.vue";
import MarkdownView from "./MarkdownView.vue";
const props = withDefaults(
  defineProps<{
    events: RunEvent[];
    liveText?: string;
    liveResponses?: Record<string, string>;
    running?: boolean;
    nodes?: { id: string; label: string }[];
    selected?: string;
    title?: string;
  }>(),
  { title: "Workflow activity" },
);
const emit = defineEmits<{ select: [id: string | undefined] }>();
const query = ref("");
const category = ref<ActivityCategory>("all");
const labels = computed(() =>
  Object.fromEntries((props.nodes ?? []).map((node) => [node.id, node.label])),
);
const scoped = computed(() =>
  props.events
    .filter((event) => !props.selected || event.nodeId === props.selected)
    .map(describeActivity)
    .toReversed(),
);
const matches = computed(() =>
  scoped.value.filter((item) =>
    matchesActivity(item, query.value, labels.value[item.event.nodeId ?? ""]),
  ),
);
const visible = computed(() =>
  matches.value.filter(
    (item) => category.value === "all" || item.category === category.value,
  ),
);
function reset() {
  query.value = "";
  category.value = "all";
}
</script>

<template>
  <section class="activity" :aria-label="title">
    <div class="activity-toolbar">
      <div class="activity-heading">
        <div>
          <h2>{{ selected ? (labels[selected] ?? selected) : title }}</h2>
          <p>
            {{ visible.length }} of {{ scoped.length }} loaded events<span
              v-if="running"
            >
              · <span class="live-dot" /> Live</span
            >
          </p>
        </div>
        <button
          v-if="selected"
          class="quiet"
          @click="emit('select', undefined)"
        >
          Show all steps
        </button>
        <span class="activity-retention"
          >Latest {{ nodes ? 500 : 200 }} events</span
        >
      </div>
      <div class="activity-search-row">
        <label class="activity-search"
          ><Icon name="search" :size="16" />
          <input
            v-model="query"
            type="search"
            aria-label="Search activity"
            placeholder="Search messages, commands, or files…"
          />
        </label>
        <select
          v-if="nodes"
          :value="selected ?? ''"
          aria-label="Activity step"
          @change="
            emit(
              'select',
              ($event.target as HTMLSelectElement).value || undefined,
            )
          "
        >
          <option value="">All steps</option>
          <option v-for="node in nodes" :key="node.id" :value="node.id">
            {{ node.label }}
          </option>
        </select>
      </div>
      <div class="activity-filters" role="group" aria-label="Activity filters">
        <button
          v-for="[id, label] in activityCategories"
          :key="id"
          :aria-pressed="category === id"
          @click="category = id"
        >
          {{ label
          }}<span>{{
            id === "all"
              ? matches.length
              : matches.filter((item) => item.category === id).length
          }}</span>
        </button>
      </div>
    </div>
    <div class="activity-feed">
      <template v-if="!query && ['all', 'updates'].includes(category)">
        <div v-for="(text, id) in liveResponses" :key="id" class="live-output">
          <span class="eyebrow"
            ><span class="live-dot" /> {{ labels[id] ?? id }} · Live
            response</span
          >
          <MarkdownView :content="text" />
        </div>
      </template>
      <div
        v-if="liveText && !query && ['all', 'updates'].includes(category)"
        class="live-output"
      >
        <span class="eyebrow"><span class="live-dot" /> Live response</span>
        <MarkdownView :content="liveText" />
      </div>
      <article
        v-for="item in visible"
        :key="item.event.id"
        class="event"
        :class="[item.event.kind, item.tone]"
      >
        <div class="event-mark"><Icon :name="item.icon" :size="15" /></div>
        <div class="event-body">
          <div class="event-meta">
            <b>{{ item.title }}</b>
            <span v-if="item.state" class="event-state" :class="item.tone">{{
              item.state
            }}</span>
            <time :datetime="item.event.time">{{
              new Date(item.event.time).toLocaleTimeString()
            }}</time>
          </div>
          <button
            v-if="item.event.nodeId && nodes && !selected"
            class="event-step"
            @click="emit('select', item.event.nodeId)"
          >
            {{ labels[item.event.nodeId] ?? item.event.nodeId }}
          </button>
          <MarkdownView v-if="item.markdown" :content="item.event.message" />
          <template v-else>
            <p class="event-preview">{{ item.preview }}</p>
            <details
              v-if="
                item.detail !== item.preview ||
                ['tools', 'checks', 'usage'].includes(item.category)
              "
              class="event-details"
            >
              <summary>View details</summary>
              <pre>{{ item.detail }}</pre>
            </details>
          </template>
        </div>
      </article>
      <div v-if="!visible.length" class="panel-empty">
        <Icon :name="scoped.length ? 'search' : 'log'" :size="26" />
        <p>
          {{
            scoped.length
              ? "No activity matches these filters."
              : "Activity will appear here as work progresses."
          }}
        </p>
        <button v-if="query || category !== 'all'" @click="reset">
          Clear filters
        </button>
      </div>
    </div>
  </section>
</template>
