<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { TaskRequest } from "../../src/contracts.js";
import type { TaskStream } from "../composables/use-workflow-data.js";
import { describeActivity } from "../activity.js";
import Icon from "./Icon.vue";
import ActivityFeed from "./ActivityFeed.vue";
const props = defineProps<{
  task: TaskRequest;
  stream?: TaskStream;
  busy: boolean;
}>();
const emit = defineEmits<{ answer: [answer: string]; cancel: []; retry: [] }>();
const answer = ref("");
watch(
  () => props.task.question?.question,
  () => {
    answer.value = "";
  },
);
const failed = computed(() =>
  ["failed", "cancelled"].includes(props.task.status),
);
const stage = computed(() =>
  props.task.events.some((event) => event.kind === "plan_ready")
    ? 3
    : props.task.events.some((event) => event.kind === "classification")
      ? 2
      : props.task.status === "planning"
        ? 1
        : 0,
);
const stages = [
  "Read the request & attachments",
  "Match project task instructions",
  "Compose blocks, models & handoffs",
  "Validate the workflow",
];
</script>

<template>
  <div class="planning-panel">
    <div class="planning-title">
      <div :class="failed ? 'planning-symbol' : 'working-orb'">
        <Icon
          :name="task.status === 'needs_input' ? 'file' : 'spark'"
          :size="26"
        />
      </div>
      <h1>
        {{
          task.status === "queued"
            ? "Your task is queued"
            : task.status === "needs_input"
              ? "One detail before we start"
              : failed
                ? "Planning stopped"
                : "Building your workflow"
        }}
      </h1>
      <p>
        {{
          task.status === "needs_input"
            ? "The coordinator needs this answer to make a useful plan."
            : failed
              ? task.error
              : "Understanding the request, choosing the right blocks, and connecting the steps."
        }}
      </p>
    </div>
    <form
      v-if="task.status === 'needs_input' && task.question"
      class="clarification-card"
      @submit.prevent="answer.trim() && emit('answer', answer)"
    >
      <label for="task-answer">{{ task.question.question }}</label>
      <div class="answer-options">
        <button
          v-for="option in task.question.options"
          :key="option"
          type="button"
          :class="{ selected: answer === option }"
          @click="answer = option"
        >
          {{ option }}
        </button>
      </div>
      <textarea
        v-autosize
        id="task-answer"
        v-model="answer"
        :rows="3"
        :disabled="busy"
        placeholder="Your answer…"
      />
      <button class="primary" :disabled="busy || !answer.trim()">
        Continue planning<Icon name="arrow" :size="16" />
      </button>
    </form>
    <div v-else-if="!failed" class="planning-stages">
      <div
        v-for="(label, index) in stages"
        :key="label"
        :class="{ done: index < stage, current: index === stage }"
      >
        <span
          ><Icon v-if="index < stage" name="check" :size="14" /><span
            v-else-if="index === stage"
            class="spinner"
          /><template v-else>{{ index + 1 }}</template></span
        >{{ label }}
      </div>
    </div>
    <div
      v-if="!failed && task.status !== 'needs_input'"
      class="planning-live"
      role="status"
    >
      <span class="live-dot" /><span>{{
        stream?.activity && !["queued", "planning"].includes(stream.activity)
          ? stream.activity.slice(0, 220)
          : task.events.at(-1)
            ? describeActivity(task.events.at(-1)!).preview
            : "Waiting for the coordinator…"
      }}</span>
    </div>
    <details v-if="task.events.length || stream?.text" class="planning-logs">
      <summary><Icon name="log" :size="15" />Planning activity</summary>
      <ActivityFeed
        :key="task.id"
        :events="task.events"
        :live-text="stream?.text"
        :running="['queued', 'planning'].includes(task.status)"
        title="Planning activity"
      />
    </details>
    <div class="planning-actions">
      <button
        v-if="failed"
        class="primary"
        :disabled="busy"
        @click="emit('retry')"
      >
        Retry planning</button
      ><button v-else class="quiet" :disabled="busy" @click="emit('cancel')">
        Cancel planning
      </button>
    </div>
  </div>
</template>
