<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import {
  usageReportSchema,
  type UsageReport,
  type UsagePhase,
} from "../../src/contracts.js";
import { request } from "../api.js";
import {
  usageCost,
  usagePhaseLabels,
  usageTokens,
} from "../usage-presentation.js";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    scope: "project" | "task" | "run";
    scopeId?: string;
    revision?: string | number;
    active?: boolean;
  }>(),
  { active: false },
);
const report = ref<UsageReport>();
const error = ref("");
const loading = ref(false);
let controller: AbortController | undefined;
let version = 0;
let disposed = false;
let timer: ReturnType<typeof setInterval> | undefined;
const endpoint = computed(() =>
  props.scope === "project"
    ? "/api/usage"
    : props.scopeId
      ? `/api/${props.scope === "task" ? "tasks" : "runs"}/${encodeURIComponent(props.scopeId)}/usage`
      : undefined,
);
const title = computed(() =>
  props.scope === "project"
    ? "Project AI usage"
    : (report.value?.scope.kind ?? props.scope) === "task"
      ? "Task cost"
      : "Workflow cost",
);
const partial = computed(
  () =>
    !!report.value &&
    (report.value.incomplete || report.value.total.unpricedRequests > 0),
);
const warnings = computed(() => {
  if (!report.value) return [];
  const items = [...report.value.warnings];
  if (
    report.value.total.unpricedRequests > 0 &&
    !items.some((item) => /pric/i.test(item))
  )
    items.unshift(
      `${report.value.total.unpricedRequests} model requests have no recorded price. Their cost is unknown.`,
    );
  if (report.value.incomplete && !items.length)
    items.push(
      "Some historical or interrupted activity has incomplete usage records.",
    );
  return [...new Set(items)];
});
function unfinished(phase?: UsagePhase, provider?: string, model?: string) {
  return (
    report.value?.sessions.some(
      (session) =>
        ["running", "interrupted"].includes(session.status) &&
        (phase === undefined || session.phase === phase) &&
        (provider === undefined ||
          (session.provider === provider && session.model === model)),
    ) ?? false
  );
}

async function refresh() {
  const url = endpoint.value;
  if (!url || disposed) return;
  const current = ++version;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  try {
    const value = await request(url, usageReportSchema, {
      signal: controller.signal,
    });
    if (current !== version || disposed) return;
    report.value = value;
    error.value = "";
  } catch (failure) {
    if (current !== version || disposed || controller.signal.aborted) return;
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (current === version && !disposed) loading.value = false;
  }
}
watch(
  endpoint,
  () => {
    report.value = undefined;
    error.value = "";
    void refresh();
  },
  { immediate: true },
);
watch(
  () => props.revision,
  () => void refresh(),
);
onMounted(() => {
  timer = setInterval(() => {
    if (
      document.visibilityState === "visible" &&
      !loading.value &&
      (props.active ||
        report.value?.sessions.some((session) => session.status === "running"))
    )
      void refresh();
  }, 5000);
});
onScopeDispose(() => {
  disposed = true;
  version++;
  controller?.abort();
  clearInterval(timer);
});
function time(value: string) {
  return new Date(value).toLocaleString();
}
</script>

<template>
  <section class="usage-summary" :aria-label="title" :aria-busy="loading">
    <div class="usage-heading">
      <div class="usage-title">
        <Icon name="chart" :size="17" /><span>{{ title }}</span>
      </div>
      <strong v-if="report" class="usage-total" :class="{ partial }">{{
        usageCost(report.total, report.incomplete)
      }}</strong>
      <span v-else class="usage-loading">{{
        error ? "Unavailable" : "Loading usage…"
      }}</span>
      <button
        class="quiet"
        :disabled="loading"
        :aria-label="`Refresh ${title.toLowerCase()}`"
        @click="refresh"
      >
        Refresh
      </button>
    </div>
    <template v-if="report">
      <p class="usage-scope-note">
        {{
          scope === "project"
            ? "Recorded across this project, including setup, settings design and retained task history."
            : report.scope.kind === "task"
              ? "Planning, refinement and execution for this task, including retries and recovery."
              : "Recorded planning, refinement and execution for this workflow."
        }}
      </p>
      <div
        v-if="report.phases.length"
        class="usage-phases"
        aria-label="Cost by phase"
      >
        <span v-for="phase in report.phases" :key="phase.phase"
          ><span>{{ usagePhaseLabels[phase.phase] }}</span
          ><strong>{{
            usageCost(phase.usage, unfinished(phase.phase))
          }}</strong></span
        >
      </div>
      <div
        v-if="
          report.limits.totalCostUsd !== undefined ||
          report.limits.executionCostUsd !== undefined
        "
        class="usage-limits"
      >
        <span v-if="report.limits.totalCostUsd !== undefined"
          >Total limit
          <strong>${{ report.limits.totalCostUsd.toFixed(4) }}</strong></span
        >
        <span v-if="report.limits.remainingCostUsd !== null"
          >Remaining
          <strong
            >${{ report.limits.remainingCostUsd.toFixed(4) }}</strong
          ></span
        >
        <span v-else-if="report.limits.totalCostUsd !== undefined"
          >Remaining amount unavailable</span
        >
        <span v-if="report.limits.executionCostUsd !== undefined"
          >Execution limit
          <strong
            >${{ report.limits.executionCostUsd.toFixed(4) }}</strong
          ></span
        >
      </div>
      <p v-if="partial" class="usage-warning">
        <Icon name="alert" :size="14" />Incomplete cost coverage. Missing usage
        or pricing is not counted as free.
      </p>
      <details class="usage-breakdown">
        <summary>
          Usage details · {{ report.sessionCount }} model
          {{ report.sessionCount === 1 ? "session" : "sessions" }} ·
          {{ usageTokens(report.total).toLocaleString() }} tokens
        </summary>
        <p>
          Amounts use reported token usage and recorded model prices; they may
          differ from your provider's invoice.
        </p>
        <ul v-if="warnings.length" class="usage-warnings">
          <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
        </ul>
        <div v-if="report.models.length" class="usage-table-wrap">
          <table class="usage-table">
            <caption>
              Cost by model
            </caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Sessions</th>
                <th scope="col">Tokens</th>
                <th scope="col">Recorded cost</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="model in report.models"
                :key="`${model.provider}/${model.model}`"
              >
                <th scope="row">
                  <strong>{{ model.model }}</strong
                  ><small>{{ model.provider }}</small>
                </th>
                <td>{{ model.sessionCount }}</td>
                <td>{{ usageTokens(model.usage).toLocaleString() }}</td>
                <td>
                  {{
                    usageCost(
                      model.usage,
                      unfinished(undefined, model.provider, model.model),
                    )
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-if="
            report.legacyExecution.requests ||
            usageTokens(report.legacyExecution) ||
            report.legacyExecution.costUsd
          "
          class="usage-legacy"
        >
          Historical execution: {{ usageCost(report.legacyExecution) }} is
          already included in this total. Model session details were not
          recorded for that activity.
        </p>
        <p
          v-if="
            !report.sessionCount && !report.total.requests && !report.incomplete
          "
        >
          No model usage recorded yet.
        </p>
        <details v-if="report.sessions.length" class="usage-sessions">
          <summary>
            Model sessions{{
              report.sessionsTruncated
                ? ` · latest ${report.sessions.length} of ${report.sessionCount}`
                : ""
            }}
          </summary>
          <p v-if="report.sessionsTruncated">
            Totals include all retained sessions.
          </p>
          <article
            v-for="session in report.sessions"
            :key="session.id"
            class="usage-session"
          >
            <div>
              <strong>{{ session.model }}</strong
              ><span>{{
                usageCost(
                  session.usage,
                  ["running", "interrupted"].includes(session.status),
                )
              }}</span>
            </div>
            <p>
              {{ usagePhaseLabels[session.phase] }} · {{ session.status
              }}<template v-if="session.nodeId">
                · {{ session.nodeId
                }}<template v-if="session.visit">
                  · visit {{ session.visit }}</template
                ></template
              >
            </p>
            <small
              >{{ session.provider }} · {{ session.thinking }} thinking ·
              {{ session.usage.requests }}
              {{ session.usage.requests === 1 ? "request" : "requests" }} ·
              {{ usageTokens(session.usage).toLocaleString() }} tokens</small
            >
            <small
              >{{ time(session.startedAt) }} ·
              {{
                session.pricing.source === "unknown"
                  ? "Price unavailable"
                  : session.pricing.source === "override"
                    ? "Configured price"
                    : "Model catalog price"
              }}</small
            >
            <p v-if="session.error" class="usage-session-error">
              {{ session.error }}
            </p>
          </article>
        </details>
      </details>
    </template>
    <p v-if="error" class="usage-fetch-error" role="status">
      {{ report ? "Showing the last loaded usage. " : "Could not load usage. "
      }}{{ error }}
    </p>
  </section>
</template>

<style scoped>
.usage-summary {
  border: 1px solid var(--ui-edge);
  border-radius: var(--ui-card-radius);
  background: var(--ui-raised);
  padding: 16px 20px;
  margin: 0 0 20px;
  min-width: 0;
}
.usage-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.usage-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}
.usage-title svg {
  color: var(--accent);
}
.usage-total {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-left: auto;
}
.usage-total.partial {
  color: var(--ctp-yellow);
}
.usage-heading > button {
  font-size: 11px;
  padding: 4px 7px;
}
.usage-loading {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}
.usage-scope-note {
  font-size: 11px;
  margin: 5px 0 12px;
  color: var(--muted);
}
.usage-phases {
  display: flex;
  gap: 8px 22px;
  flex-wrap: wrap;
}
.usage-phases > span {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 12px;
}
.usage-phases > span > span {
  color: var(--muted);
}
.usage-phases strong,
.usage-limits strong {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.usage-limits {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  font-size: 11px;
  color: var(--muted);
  margin-top: 10px;
}
.usage-limits strong {
  color: var(--ctp-text);
  margin-left: 4px;
}
.usage-warning {
  color: var(--ctp-yellow);
  font-size: 11px;
  margin: 10px 0 0;
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.usage-warning svg {
  flex-shrink: 0;
}
.usage-breakdown {
  border-top: 1px solid var(--ui-edge);
  padding-top: 10px;
  margin-top: 12px;
}
.usage-breakdown > summary,
.usage-sessions > summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 11px;
}
.usage-breakdown > p,
.usage-sessions > p,
.usage-warnings {
  font-size: 11px;
  margin: 12px 0;
}
.usage-warnings {
  color: var(--ctp-yellow);
  padding-left: 20px;
  line-height: 1.7;
}
.usage-table-wrap {
  overflow-x: auto;
  margin-top: 16px;
}
.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.usage-table caption {
  text-align: left;
  font-weight: 600;
  margin-bottom: 10px;
}
.usage-table th,
.usage-table td {
  padding: 10px 8px;
  text-align: right;
  border-bottom: 1px solid var(--ui-edge);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.usage-table th:first-child {
  padding-left: 0;
  text-align: left;
  white-space: normal;
  min-width: 150px;
  overflow-wrap: anywhere;
}
.usage-table thead th {
  color: var(--muted);
  font-size: 10px;
  font-weight: 500;
}
.usage-table tbody th strong {
  font-weight: 500;
}
.usage-table small {
  display: block;
  color: var(--muted);
  font-size: 10px;
  margin-top: 4px;
}
.usage-legacy {
  color: var(--muted);
}
.usage-sessions {
  margin-top: 16px;
}
.usage-session {
  padding: 14px 0;
  border-bottom: 1px solid var(--ui-edge);
}
.usage-session:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}
.usage-session > div {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.usage-session strong {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.usage-session p {
  font-size: 11px;
  margin: 5px 0;
}
.usage-session small {
  display: block;
  font-size: 10px;
  color: var(--muted);
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.usage-session-error,
.usage-fetch-error {
  color: var(--ctp-peach);
  overflow-wrap: anywhere;
}
.usage-fetch-error {
  font-size: 11px;
  margin: 10px 0 0;
}
@media (max-width: 600px) {
  .usage-summary {
    padding: 14px;
  }
  .usage-heading {
    gap: 8px;
  }
  .usage-title {
    font-size: 12px;
  }
  .usage-total {
    font-size: 17px;
  }
  .usage-heading > button {
    margin-left: auto;
  }
  .usage-phases {
    gap: 8px 16px;
  }
}
</style>
