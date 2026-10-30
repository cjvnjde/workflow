<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import {
  type ExecutionOperation,
  type RunEvent,
  type WorkflowRun,
  projectOperations,
} from "../../src/contracts.js";
import { client } from "../api.js";
import { operationBody, durationLabel } from "../operation-presentation.js";
import ExecutionTimeline from "./ExecutionTimeline.vue";
const props = defineProps<{
  run: WorkflowRun;
  events: RunEvent[];
  selected?: string;
  timeline?: boolean;
}>();
const emit = defineEmits<{
  select: [id: string | undefined];
  evidence: [
    nodeId: string,
    visit: number,
    operationId: string,
    sessionId?: string,
  ];
}>();
const operations = shallowRef<ExecutionOperation[]>([]);
const error = ref("");
const loading = ref(false);
const query = ref("");
const selectedKey = ref<string>();
const selectedVisit = ref<number>();
const folded = ref(new Set<string>());
const page = ref(0);
const followLatest = ref(true);
const pageSize = 80;
const range = ref<{ start: number; end: number }>();
const detail = shallowRef<ExecutionOperation>();
const detailError = ref("");
const detailLoading = ref(false);
const outputText = ref("");
const outputOffset = ref(0);
const outputMore = ref(true);
const outputLoading = ref(false);
const outputError = ref("");
let outputController: AbortController | undefined;
const outputRef = computed(() => detail.value?.operation.outputRef);
const outputDownload = computed(() => {
  const item = detail.value,
    ref = outputRef.value;
  return item?.nodeId && item.visit && ref
    ? client.commandOutputUrl(
        props.run.id,
        item.nodeId,
        item.visit,
        ref.id,
        "output",
        true,
      )
    : undefined;
});
async function loadOutput() {
  const item = detail.value,
    ref = outputRef.value;
  if (!item?.nodeId || !item.visit || !ref || outputLoading.value) return;
  outputLoading.value = true;
  const key = item.key;
  const request = new AbortController();
  outputController = request;
  try {
    const result = await client.commandOutput(
      props.run.id,
      item.nodeId,
      item.visit,
      ref.id,
      "output",
      { offset: outputOffset.value },
      request.signal,
    );
    if (request.signal.aborted || selectedKey.value !== key) return;
    outputText.value = result.text;
    outputOffset.value = result.nextOffset;
    outputMore.value = result.hasMore;
    outputError.value = "";
  } catch (failure) {
    if (!request.signal.aborted && selectedKey.value === key)
      outputError.value =
        failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (!request.signal.aborted) outputLoading.value = false;
  }
}
let controller: AbortController | undefined;
let detailController: AbortController | undefined;
let generation = 0;
let disposed = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const selectedOperation = computed(() =>
  operations.value.find((item) => item.key === selectedKey.value),
);
const requestTiming = computed(() => {
  const value = detail.value?.operation.details;
  if (
    detail.value?.kind !== "request" ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return undefined;
  return {
    first:
      typeof value.firstTokenMs === "number" ? value.firstTokenMs : undefined,
    generation:
      typeof value.generationMs === "number" ? value.generationMs : undefined,
    tokens:
      typeof value.outputTokens === "number" ? value.outputTokens : undefined,
  };
});
const body = computed(() =>
  detail.value ? operationBody(detail.value.operation) : undefined,
);
const allKeys = computed(
  () => new Set(operations.value.map((item) => item.key)),
);
const children = computed(() => {
  const values = new Map<string, ExecutionOperation[]>();
  const parents = new Map(
    operations.value.map((item) => [item.key, item.parentKey]),
  );
  for (const item of operations.value) {
    let ancestor = item.parentKey;
    const seen = new Set([item.key]);
    let cycle = false;
    while (ancestor) {
      if (seen.has(ancestor)) {
        cycle = true;
        break;
      }
      seen.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    const key =
      !cycle && item.parentKey && allKeys.value.has(item.parentKey)
        ? item.parentKey
        : "";
    values.set(key, [...(values.get(key) ?? []), item]);
  }
  return values;
});
const visits = computed(() =>
  props.run.attempts.filter(
    (item) => !props.selected || item.nodeId === props.selected,
  ),
);
const scoped = computed(() => {
  const result: { item: ExecutionOperation; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (items: ExecutionOperation[], depth: number) => {
    for (const item of items) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      const start = item.startedAt ? Date.parse(item.startedAt) : undefined;
      const end = item.finishedAt ? Date.parse(item.finishedAt) : start;
      const matches =
        (!props.selected || item.nodeId === props.selected) &&
        (selectedVisit.value === undefined ||
          item.visit === selectedVisit.value) &&
        (!range.value ||
          (start !== undefined &&
            end !== undefined &&
            start <= range.value.end &&
            end >= range.value.start)) &&
        (!query.value ||
          `${item.name} ${item.summary ?? ""} ${item.nodeId ?? ""}`
            .toLowerCase()
            .includes(query.value.toLowerCase()));
      if (matches) result.push({ item, depth });
      if (query.value || range.value || !folded.value.has(item.key))
        visit(children.value.get(item.key) ?? [], depth + 1);
    }
  };
  visit(children.value.get("") ?? [], 0);
  return result;
});
const pages = computed(() =>
  Math.max(1, Math.ceil(scoped.value.length / pageSize)),
);
const visible = computed(() =>
  scoped.value.slice(page.value * pageSize, (page.value + 1) * pageSize),
);
watch([query, () => props.selected, selectedVisit, range], () => {
  page.value = 0;
});
watch(
  () => scoped.value.length,
  () => {
    if (followLatest.value && !selectedKey.value) page.value = pages.value - 1;
  },
);
watch(pages, (value) => {
  page.value = Math.min(page.value, value - 1);
});
function toggle(key: string) {
  followLatest.value = false;
  const next = new Set(folded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  folded.value = next;
}
async function refresh() {
  const runId = props.run.id,
    current = generation;
  if (loading.value || disposed) return;
  controller = new AbortController();
  loading.value = true;
  try {
    const result = await client.execution(runId, controller.signal);
    if (current !== generation || disposed) return;
    operations.value = result.operations;
    error.value = "";
  } catch (failure) {
    if (current === generation && !controller.signal.aborted)
      error.value = String(
        failure instanceof Error ? failure.message : failure,
      );
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function selectOperation(item: ExecutionOperation) {
  selectedKey.value = item.key;
  followLatest.value = false;
  outputController?.abort();
  outputLoading.value = false;
  outputText.value = "";
  outputOffset.value = 0;
  outputMore.value = true;
  outputError.value = "";
  detail.value = undefined;
  detailError.value = "";
  detailController?.abort();
  const request = new AbortController();
  detailController = request;
  detailLoading.value = true;
  try {
    const result = await client.operationEvents(
      props.run.id,
      item.key,
      request.signal,
    );
    if (request.signal.aborted || disposed || selectedKey.value !== item.key)
      return;
    detail.value =
      result.operation ??
      projectOperations(result.events).find(
        (value) => value.key === item.key,
      ) ??
      item;
  } catch (failure) {
    if (!request.signal.aborted)
      detailError.value =
        failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (!request.signal.aborted) detailLoading.value = false;
  }
}
function reveal(key: string) {
  const item = operations.value.find((value) => value.key === key);
  if (!item) return;
  const next = new Set(folded.value);
  let ancestor = item.parentKey;
  const seen = new Set<string>();
  while (ancestor && !seen.has(ancestor)) {
    seen.add(ancestor);
    next.delete(ancestor);
    ancestor = operations.value.find(
      (value) => value.key === ancestor,
    )?.parentKey;
  }
  folded.value = next;
  selectedVisit.value = item.visit;
  emit("select", item.nodeId);
  void selectOperation(item);
}
function evidence() {
  const item = detail.value ?? selectedOperation.value;
  if (item?.nodeId && item.visit)
    emit("evidence", item.nodeId, item.visit, item.id, item.sessionId);
}
watch(
  () => props.run.id,
  () => {
    generation++;
    controller?.abort();
    detailController?.abort();
    outputController?.abort();
    outputLoading.value = false;
    clearTimeout(refreshTimer);
    operations.value = [];
    detail.value = undefined;
    selectedKey.value = undefined;
    selectedVisit.value = undefined;
    folded.value = new Set();
    loading.value = false;
    page.value = 0;
    followLatest.value = true;
    range.value = undefined;
    void refresh();
  },
  { immediate: true },
);
watch(
  () => `${props.run.revision}/${props.events.at(-1)?.id}`,
  () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void refresh().then(() => {
        const item = selectedOperation.value;
        if (item && detail.value?.lastCursor !== item.lastCursor)
          void selectOperation(item);
      });
    }, 400);
  },
);
onScopeDispose(() => {
  disposed = true;
  generation++;
  controller?.abort();
  detailController?.abort();
  outputController?.abort();
  clearTimeout(refreshTimer);
});
</script>

<template>
  <section class="execution-inspector" aria-label="Execution inspector">
    <div class="inspection-controls">
      <label
        >Step<select
          :value="selected ?? ''"
          @change="
            emit(
              'select',
              ($event.target as HTMLSelectElement).value || undefined,
            )
          "
        >
          <option value="">All steps</option>
          <option
            v-for="node in run.plan.nodes"
            :key="node.id"
            :value="node.id"
          >
            {{ node.label }}
          </option>
        </select></label
      >
      <label
        >Visit<select v-model="selectedVisit">
          <option :value="undefined">All visits</option>
          <option
            v-for="visit in [...new Set(visits.map((item) => item.visit))]"
            :key="visit"
            :value="visit"
          >
            Visit {{ visit }}
          </option>
        </select></label
      >
      <label class="search"
        >Search calls<input
          v-model="query"
          type="search"
          placeholder="Tool, step, or summary…"
      /></label>
      <button :disabled="loading" @click="refresh">
        {{ loading ? "Refreshing…" : "Refresh history" }}
      </button>
    </div>
    <p class="inspection-note">
      {{ operations.length }} recorded operation attempts across the run · saved
      run history. Search covers names and summaries. Open a call for its
      recorded details.
    </p>
    <p v-if="error" class="inspection-error" role="alert">{{ error }}</p>
    <ExecutionTimeline
      v-if="timeline"
      :run="run"
      :operations="operations"
      :selected="selected"
      :selected-key="selectedKey"
      :visit="selectedVisit"
      @select="reveal"
      @step="
        (id, visit) => {
          emit('select', id);
          selectedVisit = visit;
        }
      "
      @range="range = $event"
    />
    <button v-if="range" class="quiet" @click="range = undefined">
      Clear selected time range
    </button>
    <div class="inspection-layout">
      <section class="call-ledger" aria-label="Recorded tool calls">
        <div class="ledger-heading">
          <strong>Calls · {{ scoped.length }}</strong
          ><label class="follow-control"
            ><input
              v-model="followLatest"
              type="checkbox"
              @change="
                if (followLatest) {
                  selectedKey = undefined;
                  page = pages - 1;
                }
              "
            />Follow latest</label
          ><button
            class="quiet"
            @click="
              folded = folded.size
                ? new Set()
                : new Set(
                    operations
                      .filter((item) => children.has(item.key))
                      .map((item) => item.key),
                  )
            "
          >
            {{ folded.size ? "Expand calls" : "Fold calls" }}
          </button>
        </div>
        <p v-if="!scoped.length" class="inspection-note">
          {{
            operations.length
              ? "No calls match this selection."
              : "No structured operations recorded. Step timing and legacy activity remain available."
          }}
        </p>
        <div
          v-for="{ item, depth } in visible"
          :key="item.key"
          class="call-row"
          :class="{ chosen: selectedKey === item.key }"
          :style="{ paddingLeft: `${Math.min(depth, 8) * 14 + 8}px` }"
        >
          <button
            v-if="children.has(item.key)"
            class="fold"
            :aria-label="`${folded.has(item.key) ? 'Expand' : 'Fold'} ${item.name}`"
            :aria-expanded="!folded.has(item.key)"
            @click="toggle(item.key)"
          >
            {{ folded.has(item.key) ? "▸" : "▾" }}</button
          ><span v-else class="fold-placeholder" />
          <button
            class="call-select"
            :aria-pressed="selectedKey === item.key"
            @click="selectOperation(item)"
          >
            <span class="call-title">{{ item.name }}</span
            ><span class="call-state" :class="item.state">{{ item.state }}</span
            ><span class="call-meta"
              >{{ item.nodeId ?? "Run"
              }}<template v-if="item.visit"> · visit {{ item.visit }}</template
              ><template v-if="item.attempt">
                · attempt {{ item.attempt }}</template
              >
              · {{ durationLabel(item.durationMs) }}</span
            ><span v-if="item.summary" class="call-summary">{{
              item.summary
            }}</span>
          </button>
        </div>
        <div v-if="pages > 1" class="ledger-pages">
          <button
            :disabled="page === 0"
            @click="
              followLatest = false;
              page--;
            "
          >
            Previous calls</button
          ><span>Page {{ page + 1 }} of {{ pages }}</span
          ><button
            :disabled="page + 1 >= pages"
            @click="
              followLatest = false;
              page++;
            "
          >
            Next calls
          </button>
        </div>
      </section>
      <aside class="call-detail" aria-label="Selected call details">
        <template v-if="selectedOperation"
          ><div class="ledger-heading">
            <h3>{{ body?.title ?? selectedOperation.name }}</h3>
            <button
              class="quiet"
              :disabled="!selectedOperation.nodeId || !selectedOperation.visit"
              @click="evidence"
            >
              Open exact evidence
            </button>
          </div>
          <p class="inspection-note">
            {{ selectedOperation.state }} ·
            {{ durationLabel(selectedOperation.durationMs)
            }}<template v-if="selectedOperation.environmentId">
              · {{ selectedOperation.environmentId }}</template
            >
          </p>
          <p v-if="selectedOperation.startedAt">
            Started {{ new Date(selectedOperation.startedAt).toLocaleString() }}
          </p>
          <p v-if="selectedOperation.finishedAt">
            Finished
            {{ new Date(selectedOperation.finishedAt).toLocaleString() }}
          </p>
          <p v-if="detailLoading" role="status">Loading recorded call…</p>
          <p v-if="detailError" role="alert">{{ detailError }}</p>
          <dl v-if="requestTiming" class="request-timing">
            <dt>Time to first output (TTFT)</dt>
            <dd>{{ durationLabel(requestTiming.first) }}</dd>
            <dt>Recorded streaming span</dt>
            <dd>{{ durationLabel(requestTiming.generation) }}</dd>
            <template v-if="requestTiming.tokens !== undefined"
              ><dt>Reported output tokens</dt>
              <dd>{{ requestTiming.tokens }}</dd></template
            >
          </dl>
          <p v-if="requestTiming" class="inspection-note">
            Timing is observed by this client. It includes provider response
            latency and does not measure server-only processing.
          </p>
          <div v-if="outputDownload" class="captured-output">
            <a :href="outputDownload" download>Download captured output</a
            ><button
              :disabled="outputLoading || !outputMore"
              @click="loadOutput"
            >
              {{
                outputLoading
                  ? "Loading output…"
                  : outputOffset
                    ? "Next output page"
                    : "Read captured output"
              }}
            </button>
            <p v-if="outputRef?.truncated" class="inspection-note">
              Capture reached its size limit; the download contains retained
              output.
            </p>
            <pre v-if="outputText">{{ outputText }}</pre>
            <p v-if="outputError" role="alert">{{ outputError }}</p>
          </div>
          <template v-if="body"
            ><div v-if="body.command" class="command-card">
              <small v-if="body.cwd">{{ body.cwd }}</small>
              <pre>{{ body.command }}</pre>
              <span
                v-if="body.exitCode !== undefined"
                :class="{ 'inspection-error': body.exitCode !== 0 }"
                >Exit {{ body.exitCode }}</span
              >
            </div>
            <p v-if="body.path" class="recorded-path">{{ body.path }}</p>
            <div
              v-if="body.oldText !== undefined && body.newText !== undefined"
              class="recorded-diff"
            >
              <section>
                <h4>Before this call</h4>
                <pre>{{ body.oldText }}</pre>
              </section>
              <section>
                <h4>After this call</h4>
                <pre>{{ body.newText }}</pre>
              </section>
            </div>
            <details v-if="body.input">
              <summary>Recorded input</summary>
              <pre>{{ body.input }}</pre>
            </details>
            <div v-if="body.matches?.length" class="search-matches">
              <details
                v-for="path in [
                  ...new Set(body.matches.map((match) => match.path)),
                ]"
                :key="path"
                open
              >
                <summary>{{ path }}</summary>
                <p
                  v-for="(match, index) in body.matches.filter(
                    (match) => match.path === path,
                  )"
                  :key="index"
                >
                  <code
                    >{{ match.line ? match.line + " · " : ""
                    }}{{ match.text }}</code
                  >
                </p>
              </details>
            </div>
            <section v-if="body.result !== undefined">
              <h4>Recorded output</h4>
              <pre>{{ body.result }}</pre>
            </section>
            <details v-if="body.details">
              <summary>Additional details</summary>
              <pre>{{ body.details }}</pre>
            </details>
            <p v-if="detail?.truncated" class="inspection-note">
              This activity preview was shortened. Open exact evidence for
              complete captured values where available.
            </p></template
          ></template
        >
        <p v-else class="inspection-note">
          Select a call or timeline span to inspect its recorded input, output,
          and timing.
        </p>
      </aside>
    </div>
  </section>
</template>
<style scoped>
.execution-inspector {
  padding: 20px;
  min-width: 0;
}
.inspection-controls {
  display: flex;
  align-items: end;
  gap: 12px;
  flex-wrap: wrap;
}
.inspection-controls label {
  font-size: 11px;
  color: var(--muted);
  min-width: 120px;
}
.inspection-controls select,
.inspection-controls input {
  margin-top: 6px;
}
.search {
  flex: 1;
}
.inspection-note,
.call-meta {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
}
.inspection-error {
  color: var(--ctp-red);
}
.inspection-layout {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(280px, 1fr);
  border: 1px solid var(--ui-edge);
  border-radius: 10px;
  overflow: hidden;
  margin-top: 16px;
}
.call-ledger {
  min-width: 0;
  border-right: 1px solid var(--ui-edge);
}
.ledger-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 10px;
  font-size: 12px;
}
.request-timing {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  font-size: 11px;
}
.request-timing dt {
  color: var(--muted);
}
.request-timing dd {
  margin: 0;
}
.follow-control {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--muted);
}
.follow-control input {
  width: auto;
}
.ledger-heading h3 {
  margin: 0;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.call-row {
  display: flex;
  border-top: 1px solid var(--ui-edge);
  align-items: flex-start;
}
.call-row.chosen {
  background: var(--ui-raised);
}
.fold {
  border: 0;
  background: none;
  padding: 12px 4px;
}
.fold-placeholder {
  width: 20px;
  flex-shrink: 0;
}
.call-select {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
  min-width: 0;
  text-align: left;
  border: 0;
  background: transparent;
  border-radius: 0;
  padding: 12px 8px;
}
.call-title {
  overflow-wrap: anywhere;
  flex: 1;
  font-size: 12px;
}
.call-state {
  font-size: 10px;
  color: var(--muted);
}
.call-state.failed,
.call-state.interrupted {
  color: var(--ctp-red);
}
.call-state.started,
.call-state.progress {
  color: var(--ctp-yellow);
}
.call-meta,
.call-summary {
  width: 100%;
  font-size: 10px;
  overflow-wrap: anywhere;
}
.call-summary {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.call-detail {
  padding: 12px;
  min-width: 0;
}
.call-detail p {
  font-size: 11px;
  overflow-wrap: anywhere;
}
.call-detail details {
  margin: 12px 0;
}
.call-detail summary {
  font-size: 12px;
  cursor: pointer;
}
.call-detail h4 {
  font-size: 12px;
}
.call-detail pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 400px;
  overflow: auto;
  font-size: 11px;
  background: var(--ctp-mantle);
  padding: 12px;
  border-radius: 6px;
  line-height: 1.6;
}
.command-card {
  border-left: 3px solid var(--accent);
  padding-left: 10px;
}
.command-card small {
  color: var(--muted);
  overflow-wrap: anywhere;
}
.recorded-path {
  font-family: monospace;
  color: var(--accent);
}
.recorded-diff {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.recorded-diff section {
  min-width: 0;
}
.ledger-pages {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px;
  font-size: 11px;
  gap: 8px;
}
@media (max-width: 800px) {
  .inspection-layout {
    grid-template-columns: 1fr;
  }
  .call-ledger {
    border-right: 0;
    border-bottom: 1px solid var(--ui-edge);
  }
  .recorded-diff {
    grid-template-columns: 1fr;
  }
  .execution-inspector {
    padding: 12px;
  }
  .inspection-controls label {
    min-width: 100px;
  }
}
</style>
