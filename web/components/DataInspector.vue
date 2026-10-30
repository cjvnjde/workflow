<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import {
  type AttemptEvidence,
  type EvidenceContentRef,
  type EvidenceDependency,
  type EvidenceValue as PlannedValue,
  type StoredEvidenceValue,
  type WorkflowRun,
  type RunEvent,
} from "../../src/contracts.js";
import { client } from "../api.js";
import { findGroup } from "../graph-layout.js";
import { usageCost, usageTokens } from "../usage-presentation.js";
import EvidenceValue from "./EvidenceValue.vue";

const props = defineProps<{
  run: WorkflowRun;
  selected?: string;
  focus?: {
    nodeId: string;
    visit: number;
    operationId: string;
    sessionId?: string;
  };
  events: RunEvent[];
}>();
const emit = defineEmits<{ select: [id: string]; editor: []; activity: [] }>();
const node = computed(
  () =>
    props.run.plan.nodes.find((item) => item.id === props.selected) ??
    props.run.plan.nodes.find(
      (item) => item.id === props.run.activeNodes?.[0],
    ) ??
    props.run.plan.nodes.find(
      (item) => item.id === props.run.attempts.at(-1)?.nodeId,
    ) ??
    props.run.plan.nodes[0],
);
const visits = computed(() =>
  props.run.attempts
    .filter((item) => item.nodeId === node.value?.id)
    .sort((a, b) => b.visit - a.visit),
);
const chosenVisit = ref<number | undefined>(props.focus?.visit);
watch(
  () => props.focus,
  (focus) => {
    if (focus) chosenVisit.value = focus.visit;
  },
);
let requestedVisit: number | undefined;
const visit = computed(() => chosenVisit.value ?? visits.value[0]?.visit);
const attempt = computed(() =>
  visits.value.find((item) => item.visit === visit.value),
);
const identity = computed(() =>
  node.value && visit.value
    ? { runId: props.run.id, nodeId: node.value.id, visit: visit.value }
    : undefined,
);
const shape = computed(
  () =>
    node.value && findGroup(props.run.program?.structure, node.value.id)?.step,
);
const evidence = ref<AttemptEvidence>();
const loading = ref(false);
const error = ref("");
let controller: AbortController | undefined;
let sequence = 0;
let disposed = false;
let timer: ReturnType<typeof setInterval> | undefined;
const current = computed(
  () =>
    attempt.value &&
    !attempt.value.finishedAt &&
    ["running", "pausing", "paused", "interrupted"].includes(props.run.status),
);
watch(
  () => `${props.run.id}/${node.value?.id}`,
  () => {
    chosenVisit.value =
      requestedVisit ??
      (node.value?.id === props.focus?.nodeId ? props.focus?.visit : undefined);
    requestedVisit = undefined;
  },
);
watch(
  () =>
    `${identity.value?.runId}/${identity.value?.nodeId}/${identity.value?.visit}`,
  () => {
    sequence++;
    controller?.abort();
    evidence.value = undefined;
    error.value = "";
    loading.value = false;
    void refresh();
  },
  { immediate: true },
);
watch(
  () => `${props.run.revision}:${props.events.at(-1)?.id}`,
  () => void refresh(),
);
async function refresh() {
  const key = identity.value;
  if (!key || disposed) return;
  const currentSequence = ++sequence;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  try {
    const value = await client.attemptEvidence(
      key.runId,
      key.nodeId,
      key.visit,
      controller.signal,
    );
    if (currentSequence !== sequence || disposed) return;
    if (
      value.runId !== key.runId ||
      value.nodeId !== key.nodeId ||
      value.visit !== key.visit
    )
      throw new Error(
        "The server returned evidence for a different step visit. Refresh to try again.",
      );
    evidence.value = value;
    error.value = "";
  } catch (failure) {
    if (currentSequence === sequence && !disposed && !controller.signal.aborted)
      error.value =
        failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (currentSequence === sequence && !disposed) loading.value = false;
  }
}
function select(id: string) {
  chosenVisit.value = undefined;
  emit("select", id);
}
function producer(dependency: EvidenceDependency) {
  if (!dependency.producerVisit) return;
  if (node.value?.id === dependency.producerNodeId)
    chosenVisit.value = dependency.producerVisit;
  else {
    requestedVisit = dependency.producerVisit;
    emit("select", dependency.producerNodeId);
  }
}
function label(id: string) {
  return props.run.plan.nodes.find((item) => item.id === id)?.label ?? id;
}
const captured = (value: EvidenceContentRef): StoredEvidenceValue => ({
  state: "captured",
  ref: value,
});
function preview(value: PlannedValue | undefined) {
  return value?.state === "json"
    ? JSON.stringify(value.value, null, 2)
    : value?.state === "unavailable"
      ? value.reason
      : "No value (undefined)";
}
onMounted(() => {
  timer = setInterval(() => {
    if (
      current.value &&
      !loading.value &&
      document.visibilityState === "visible"
    )
      void refresh();
  }, 3000);
});
onScopeDispose(() => {
  disposed = true;
  sequence++;
  controller?.abort();
  clearInterval(timer);
});
</script>

<template>
  <section class="data-inspector" aria-label="Step data inspector">
    <div class="data-toolbar">
      <label
        >Step<select
          :value="node?.id ?? ''"
          @change="select(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="step in run.plan.nodes"
            :key="step.id"
            :value="step.id"
          >
            {{ step.label }} · {{ step.id }}
          </option>
        </select></label
      >
      <label
        >Visit<select
          :value="visit ?? ''"
          :disabled="!visits.length"
          @change="
            chosenVisit = Number(($event.target as HTMLSelectElement).value)
          "
        >
          <option v-if="!visits.length" value="">Not started</option>
          <option v-for="item in visits" :key="item.visit" :value="item.visit">
            Visit {{ item.visit }} ·
            {{ item.error ? "error" : (item.result?.outcome ?? "in progress") }}
          </option>
        </select></label
      >
      <button :disabled="!identity || loading" @click="refresh">
        Refresh data
      </button>
    </div>
    <p class="data-explanation">
      Each visit has its own stored values. Open a value to load it; copy and
      download retain the full stored content.
    </p>
    <template v-if="node">
      <details class="data-planned" :open="!attempt">
        <summary>
          Planned inputs & sources{{ attempt ? "" : " · not executed" }}
        </summary>
        <p>
          These declarations describe what the step will receive. Deferred
          expressions are shown as source and are evaluated only during
          execution.
        </p>
        <h3>Input declaration</h3>
        <template v-if="shape?.inputPreview">
          <p v-if="shape.inputPreview.kind === 'none'">
            No explicit inputs. The block's input schema may supply defaults
            when it starts.
          </p>
          <template v-else-if="shape.inputPreview.kind === 'literal'"
            ><span class="data-tag">{{
              shape.inputPreview.value?.state === "unavailable"
                ? "Literal value unavailable"
                : "Literal value"
            }}</span>
            <pre>{{ preview(shape.inputPreview.value) }}</pre>
          </template>
          <template v-else
            ><span class="data-tag"
              >Deferred · resolved when this step starts</span
            >
            <pre>{{ shape.inputPreview.expression }}</pre>
            <p v-if="shape.inputPreview.truncated" class="data-warning">
              Source preview truncated. Open the editor for the complete
              workflow source.
            </p></template
          >
        </template>
        <template v-else-if="shape?.options.inputs !== undefined"
          ><span class="data-tag">Literal value</span>
          <pre>{{ JSON.stringify(shape.options.inputs, null, 2) }}</pre>
        </template>
        <div v-else-if="node.inputs.length" class="data-sources">
          <p v-for="(input, index) in node.inputs" :key="index">
            <strong>{{ input.as ?? input.artifact }}</strong> ←
            {{ label(input.node) }} / {{ input.artifact }} ·
            {{ input.required ? "required" : "optional" }}
          </p>
        </div>
        <p
          v-else-if="
            run.program || !node.context || !Object.keys(node.context).length
          "
          class="data-warning"
        >
          Input source metadata was not recorded for this workflow. Inspect its
          source; current step context is not an exact historical input
          snapshot.
        </p>
        <template
          v-if="
            !run.program && node.context && Object.keys(node.context).length
          "
          ><span class="data-tag">Declared literal string inputs</span>
          <pre>{{ JSON.stringify(node.context, null, 2) }}</pre>
        </template>
        <h3>Prompt declaration</h3>
        <template v-if="shape?.promptPreview?.kind === 'deferred'"
          ><span class="data-tag">Deferred prompt</span>
          <pre>{{ shape.promptPreview.expression }}</pre>
          <p v-if="shape.promptPreview.truncated" class="data-warning">
            Prompt source preview truncated.
          </p></template
        >
        <p
          v-else-if="
            shape?.promptPreview?.kind === 'literal' &&
            shape.promptPreview.value?.state === 'unavailable'
          "
          class="data-warning"
        >
          {{ shape.promptPreview.value.reason }}
        </p>
        <pre v-else-if="shape?.promptPreview?.kind === 'literal'">{{
          preview(shape.promptPreview.value)
        }}</pre>
        <p
          v-else-if="
            shape && !shape.promptPreview && shape.options.prompt === undefined
          "
          class="data-warning"
        >
          Prompt source metadata was not recorded for this workflow.
        </p>
        <pre v-else>{{ shape?.options.prompt ?? node.goal }}</pre>
        <button class="quiet" @click="emit('editor')">
          Open workflow editor
        </button>
      </details>
      <p v-if="!attempt" class="data-empty">
        Resolved inputs, outputs and model sessions will appear after this step
        starts.
      </p>
      <p v-if="loading && !evidence" role="status">
        Loading this visit's evidence…
      </p>
      <p v-if="error" class="data-warning" role="status">
        {{ evidence ? "Showing the last loaded evidence. " : "" }}{{ error }}
      </p>
      <div
        v-if="evidence && identity"
        :key="`${identity.nodeId}/${identity.visit}`"
        class="data-visit"
      >
        <div class="data-visit-heading">
          <h2>{{ node.label }} · visit {{ identity.visit }}</h2>
          <span>{{
            attempt?.error
              ? "Execution error"
              : (attempt?.result?.outcome ?? "In progress")
          }}</span>
        </div>
        <p v-if="attempt?.error" class="data-warning">{{ attempt.error }}</p>
        <h3>Resolved inputs</h3>
        <template v-if="evidence.inputs.state === 'available'">
          <p>
            Raw inputs are the resolved handoff. Effective inputs include the
            block's schema defaults or transformations.
          </p>
          <p v-if="evidence.inputs.value.inputError" class="data-warning">
            Input validation: {{ evidence.inputs.value.inputError }}
          </p>
          <p v-if="evidence.inputs.value.captureWarning" class="data-warning">
            {{ evidence.inputs.value.captureWarning }}
          </p>
          <div class="data-inputs">
            <EvidenceValue
              :identity="identity"
              :value="evidence.inputs.value.raw"
              label="Raw inputs"
              named
            /><EvidenceValue
              :identity="identity"
              :value="evidence.inputs.value.effective"
              label="Effective inputs"
              named
            />
          </div>
          <EvidenceValue
            :identity="identity"
            :value="evidence.inputs.value.prompt"
            label="Resolved step prompt"
          />
          <div
            v-if="evidence.inputs.value.dependencies.length"
            class="data-dependencies"
          >
            <h4>Source steps</h4>
            <p>
              Computed reads identify source steps. Field-level mapping is shown
              only when explicitly recorded.
            </p>
            <div
              v-for="(dependency, index) in evidence.inputs.value.dependencies"
              :key="index"
            >
              <span>{{
                dependency.inputName
                  ? `Input ${dependency.inputName}`
                  : dependency.usedBy === "prompt"
                    ? "Prompt computed from"
                    : "Inputs computed from"
              }}</span
              ><button
                class="quiet"
                :disabled="
                  !dependency.producerVisit ||
                  !run.plan.nodes.some(
                    (step) => step.id === dependency.producerNodeId,
                  )
                "
                @click="producer(dependency)"
              >
                {{ label(dependency.producerNodeId) }} ·
                {{
                  dependency.producerVisit
                    ? `visit ${dependency.producerVisit}`
                    : "no completed visit"
                }}</button
              ><small>{{ dependency.artifact ?? dependency.kind }}</small>
            </div>
          </div>
        </template>
        <div v-else class="data-unavailable">
          <p>{{ evidence.inputs.reason }}</p>
          <p v-if="evidence.inputs.state === 'unavailable'">
            Activity from older runs may contain shortened previews. Those are
            not exact stored inputs.
          </p>
          <button class="quiet" @click="emit('activity')">View activity</button>
        </div>
        <h3>Output for this visit</h3>
        <template v-if="evidence.output.state === 'available'"
          ><EvidenceValue
            :identity="identity"
            :value="evidence.output.value.data"
            label="Typed output"
            named /><EvidenceValue
            :identity="identity"
            :value="captured(evidence.output.value.summary)"
            label="Result summary" /><EvidenceValue
            v-for="(value, name) in evidence.output.value.artifacts"
            :key="name"
            :identity="identity"
            :value="captured(value)"
            :label="`Artifact: ${name}`"
        /></template>
        <p v-else class="data-unavailable">{{ evidence.output.reason }}</p>
        <h3>Model sessions · {{ evidence.sessions.length }}</h3>
        <p>
          Inspect the context supplied by Workflow, selected tools and reported
          usage. Tool results and continuation prompts can add context within a
          session.
        </p>
        <p v-if="!evidence.sessions.length" class="data-unavailable">
          No model session evidence recorded for this visit. Deterministic code
          may run without a model; older sessions may not have captured context.
        </p>
        <details
          v-for="session in evidence.sessions"
          :key="session.sessionId"
          class="data-session"
          :open="
            !!focus &&
            (focus.sessionId
              ? focus.sessionId === session.sessionId
              : focus.operationId === session.operationId ||
                focus.operationId.startsWith(session.operationId + '/'))
          "
          :aria-label="`AI session ${session.sessionId}`"
        >
          <summary>
            <strong>{{
              session.usage
                ? `${session.usage.provider}/${session.usage.model}`
                : `Model session ${session.sessionId.slice(0, 8)}`
            }}</strong
            ><span
              >{{ session.usage?.status ?? "Usage unavailable"
              }}<template v-if="session.usage">
                ·
                {{
                  usageCost(
                    session.usage.usage,
                    ["running", "interrupted"].includes(session.usage.status),
                  )
                }}</template
              ></span
            >
          </summary>
          <p class="data-session-meta">
            Session {{ session.sessionId }} · operation {{ session.operationId
            }}<template v-if="session.activityAttempt">
              · activity attempt {{ session.activityAttempt }}</template
            >
          </p>
          <p v-if="session.usage">
            {{ session.usage.thinking }} thinking ·
            {{ session.usage.usage.requests }}
            {{ session.usage.usage.requests === 1 ? "request" : "requests" }} ·
            {{ usageTokens(session.usage.usage).toLocaleString() }} tokens ·
            {{
              session.usage.pricing.source === "unknown"
                ? "Price unavailable"
                : session.usage.pricing.source === "override"
                  ? "Configured price"
                  : "Model catalog price"
            }}<template v-if="session.usage.endedAt">
              ·
              {{
                (
                  (Date.parse(session.usage.endedAt) -
                    Date.parse(session.usage.startedAt)) /
                  1000
                ).toFixed(1)
              }}s</template
            >
          </p>
          <p v-if="session.usage?.error" class="data-warning">
            {{ session.usage.error }}
          </p>
          <template v-if="session.call.state === 'available'"
            ><h4>
              Declared AI call ·
              {{
                session.call.value.contextMode === "none"
                  ? "explicit context only"
                  : "workflow context"
              }}
            </h4>
            <EvidenceValue
              :identity="identity"
              :value="session.call.value.prompt"
              label="Original call prompt" /><EvidenceValue
              :identity="identity"
              :value="session.call.value.instructions"
              label="Call instructions"
          /></template>
          <p v-else class="data-unavailable">{{ session.call.reason }}</p>
          <template v-if="session.context.state === 'available'"
            ><h4>Supplied session context</h4>
            <p>
              {{
                session.context.value.contextMode === "none"
                  ? "Inherited workflow context is disabled for this call."
                  : session.context.value.contextMode === "workflow"
                    ? "This call includes its configured workflow context."
                    : "Context mode was not recorded."
              }}
            </p>
            <EvidenceValue
              :identity="identity"
              :value="captured(session.context.value.systemPrompt)"
              label="System instructions"
            /><EvidenceValue
              :identity="identity"
              :value="captured(session.context.value.tools)"
              label="Available tool definitions"
            />
            <details class="data-settings">
              <summary>Session settings</summary>
              <pre>{{
                JSON.stringify(session.context.value.settings, null, 2)
              }}</pre>
            </details></template
          >
          <p v-else class="data-unavailable">{{ session.context.reason }}</p>
          <template v-for="prompt in session.prompts" :key="prompt.index"
            ><EvidenceValue
              :identity="identity"
              :value="prompt.text"
              :label="`Session prompt ${prompt.index + 1} (${prompt.kind})`" /><EvidenceValue
              v-for="(image, index) in prompt.images"
              :key="index"
              :identity="identity"
              :value="image"
              :label="`Prompt ${prompt.index + 1} image ${index + 1}`"
          /></template>
          <details
            v-if="session.tools.length"
            class="data-tools"
            :open="!!focus"
          >
            <summary>Tool calls · {{ session.tools.length }}</summary>
            <article
              v-for="tool in session.tools"
              :key="tool.callId"
              :class="{
                'focused-call': focus?.operationId.endsWith('/' + tool.callId),
              }"
            >
              <h4>{{ tool.name ?? tool.callId }} · {{ tool.state }}</h4>
              <p v-if="tool.error" class="data-warning">{{ tool.error }}</p>
              <EvidenceValue
                v-if="tool.input"
                :identity="identity"
                :value="tool.input"
                label="Tool input"
              /><EvidenceValue
                v-if="tool.output"
                :identity="identity"
                :value="tool.output"
                label="Tool output"
              /><EvidenceValue
                v-if="tool.details"
                :identity="identity"
                :value="tool.details"
                label="Tool details"
              />
            </article>
          </details>
        </details>
      </div>
    </template>
    <p v-else class="data-empty">
      Steps will appear when the workflow declares them.
    </p>
  </section>
</template>

<style scoped>
.data-inspector {
  padding: 22px;
  min-width: 0;
}
.data-toolbar {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.data-toolbar label {
  flex: 1;
  min-width: 180px;
  font-size: 11px;
  color: var(--muted);
}
.data-toolbar label:nth-child(2) {
  flex: 0 1 220px;
  min-width: 140px;
}
.data-toolbar select {
  margin-top: 7px;
  font-size: 12px;
}
.data-explanation,
p {
  font-size: 12px;
}
.data-explanation {
  margin-top: 12px;
  color: var(--muted);
}
.data-planned {
  border-bottom: 1px solid var(--ui-edge);
  padding-bottom: 16px;
  margin-bottom: 20px;
}
.data-planned > summary,
.data-settings > summary,
.data-tools > summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}
.data-planned > p {
  margin-top: 12px;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--ctp-mantle);
  padding: 14px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.7;
  max-height: 360px;
  overflow: auto;
}
.data-tag {
  color: var(--accent);
  font-size: 11px;
}
.data-warning {
  color: var(--ctp-yellow);
  overflow-wrap: anywhere;
}
.data-empty,
.data-unavailable {
  color: var(--muted);
}
.data-unavailable p {
  margin: 8px 0;
}
.data-visit-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 20px;
}
.data-visit-heading h2 {
  margin: 0;
  font-size: 16px;
}
.data-visit-heading > span {
  font-size: 11px;
  color: var(--muted);
}
.data-inputs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.data-dependencies {
  background: var(--ui-raised);
  border-radius: 8px;
  padding: 12px;
  margin-top: 14px;
}
h4 {
  font-size: 12px;
  margin: 12px 0;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.data-dependencies > div {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  font-size: 11px;
}
.data-dependencies small {
  color: var(--muted);
}
.data-dependencies button {
  padding: 4px 7px;
  font-size: 11px;
}
.data-session {
  border: 1px solid var(--ui-edge);
  border-radius: 10px;
  padding: 15px;
  margin: 12px 0;
}
.data-session > summary {
  cursor: pointer;
  font-size: 12px;
}
.data-session > summary strong {
  font-weight: 500;
}
.data-session > summary span {
  margin-left: 12px;
  color: var(--muted);
  font-size: 11px;
}
.data-session-meta {
  color: var(--muted);
  font-size: 10px;
  overflow-wrap: anywhere;
  margin: 14px 0 8px;
}
.data-settings,
.data-tools {
  margin-top: 14px;
}
.data-tools article.focused-call {
  border-left: 3px solid var(--accent);
  padding-left: 10px;
}
.data-tools article {
  border-top: 1px solid var(--ui-edge);
  margin-top: 12px;
  padding-top: 4px;
}
@media (max-width: 700px) {
  .data-inspector {
    padding: 15px;
  }
  .data-inputs {
    grid-template-columns: 1fr;
    gap: 0;
  }
  .data-toolbar label {
    min-width: min(100%, 180px);
  }
  .data-session {
    padding: 12px;
  }
  .data-session > summary span {
    display: block;
    margin: 6px 0 0 14px;
  }
}
</style>
