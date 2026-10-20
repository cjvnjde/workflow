<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from "vue";
import {
  resolveAgentSettings,
  type RunEvent,
  type WorkflowRun,
} from "../../src/domain.js";
import type { PlanDraft } from "../composables/use-draft.js";
import { currentActivity, statusLabel, stepState } from "../workflow-status.js";
import Icon from "./Icon.vue";
import { executionLabel } from "../execution-label.js";
import MarkdownView from "./MarkdownView.vue";
import MarkdownActions from "./MarkdownActions.vue";
import ActivityFeed from "./ActivityFeed.vue";
import { describeActivity } from "../activity.js";
const WorkflowGraph = defineAsyncComponent(() => import("./WorkflowGraph.vue"));
const PlanEditor = defineAsyncComponent(() => import("./PlanEditor.vue"));
const ProgramEditor = defineAsyncComponent(() => import("./ProgramEditor.vue"));
const props = defineProps<{
  run: WorkflowRun;
  draft: PlanDraft;
  events: RunEvent[];
  liveText: string;
  busy: boolean;
  live: boolean;
  coordinatorActivity: string;
  coordinatorText: string;
  refining: boolean;
}>();
const emit = defineEmits<{
  action: [action: string];
  save: [];
  refine: [instructions: string];
  cancelRefinement: [];
  settings: [];
}>();
const tab = ref(props.run.program && props.run.status === "draft" ? "edit" : "workflow");
const selected = ref<string>();
const expanded = ref(false);
const focusDialog = ref<HTMLDialogElement>();
const expandButton = ref<HTMLButtonElement>();
const graph = ref<{ fit: () => void }>();
async function expandWorkspace() {
  expanded.value = true;
  await nextTick();
  focusDialog.value?.showModal();
  expandButton.value?.focus();
  requestAnimationFrame(() => graph.value?.fit());
}
function closeWorkspace() {
  focusDialog.value?.close();
  expanded.value = false;
  void nextTick(() => {
    expandButton.value?.focus();
    requestAnimationFrame(() => graph.value?.fit());
  });
}
function dialogClosed() {
  if (!focusDialog.value?.open) expanded.value = false;
}
function dialogKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing) return;
  // Search inputs otherwise consume Escape to clear their text before the
  // native dialog can close. Preserve the search when leaving expanded mode.
  event.preventDefault();
  event.stopPropagation();
  closeWorkspace();
}
watch(expanded, (open, _previous, cleanup) => {
  if (!open) return;
  const overflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  cleanup(() => {
    document.body.style.overflow = overflow;
  });
});
const now = ref(Date.now());
const tabs = [
  ["results", "Results", "file"],
  ["workflow", "Workflow", "workflow"],
  ["activity", "Activity", "log"],
  ["artifacts", "Artifacts", "folder"],
  ["edit", "Editor", "code"],
] as const;
watch(
  () => props.run.id,
  () => {
    if (expanded.value) closeWorkspace();
    selected.value = undefined;
    tab.value = props.run.program && props.run.status === "draft" ? "edit" : "workflow";
  },
);
watch(
  () => props.run.status,
  (status, previous, onCleanup) => {
    if (props.run.program && previous === "draft" && props.run.approvedAt && tab.value === "edit") {
      tab.value = "workflow";
    }
    if (!["running", "pausing"].includes(status)) {
      return;
    }
    const timer = setInterval(() => {
      now.value = Date.now();
    }, 1000);
    onCleanup(() => clearInterval(timer));
  },
  { immediate: true },
);
const plan = computed(() =>
  props.draft.dirty && props.draft.validPlan
    ? props.draft.validPlan
    : props.run.plan,
);
const node = computed(() =>
  plan.value.nodes.find((item) => item.id === selected.value),
);
const bundle = computed(() => node.value && props.run.blocks[node.value.block]);
const agent = computed(() =>
  bundle.value
    ? resolveAgentSettings(
        props.run.config.agent,
        bundle.value.definition.agent,
        node.value?.agent,
      )
    : undefined,
);
const active = computed(() =>
  props.run.plan.nodes.find((item) => item.id === props.run.cursor),
);
const latestEvent = computed(() =>
  props.events
    .filter(
      (event) =>
        event.kind !== "usage" &&
        (!event.nodeId || event.nodeId === props.run.cursor),
    )
    .at(-1),
);
const latestActivity = computed(
  () => latestEvent.value && describeActivity(latestEvent.value),
);
const elapsed = computed(() => {
  const attempt = props.run.attempts
    .filter((item) => item.nodeId === props.run.cursor)
    .at(-1);
  return attempt
    ? Math.max(
        0,
        Math.floor((now.value - new Date(attempt.startedAt).getTime()) / 1000),
      )
    : 0;
});
const completed = computed(
  () =>
    props.run.plan.nodes.filter(
      (item) => stepState(props.run, item.id) === "pass",
    ).length,
);
const running = computed(() =>
  ["running", "pausing"].includes(props.run.status),
);
const artifacts = computed(() =>
  Object.entries(props.run.artifacts).flatMap(([nodeId, items]) =>
    Object.entries(items).map(([name, content]) => ({ nodeId, name, content })),
  ),
);
const finished = computed(() =>
  [
    "completed",
    "failed",
    "cancelled",
    "rejected",
    "interrupted",
    "paused",
  ].includes(props.run.status),
);
const lastAttempt = computed(() => props.run.attempts.at(-1));
const resultSummary = computed(
  () =>
    props.run.error ??
    props.run.output ??
    lastAttempt.value?.error ??
    lastAttempt.value?.result?.summary ??
    (props.run.status === "completed"
      ? "All workflow completion conditions were met."
      : props.run.status === "rejected"
        ? "The proposed workflow was rejected. No steps were executed."
        : props.run.status === "paused"
          ? "Execution is paused. Review the step results before continuing."
          : "Execution stopped. Review the step activity before retrying."),
);
const resultTitle = computed(
  () =>
    ({
      completed: "Workflow completed",
      failed: "Workflow failed",
      interrupted: "Execution interrupted",
      cancelled: "Workflow stopped",
      rejected: "Workflow rejected",
      paused: "Workflow paused",
    })[props.run.status as "completed"] ?? "Latest results",
);
const resultArtifacts = computed(() =>
  [...artifacts.value].sort(
    (a, b) =>
      Number(b.nodeId === lastAttempt.value?.nodeId) -
      Number(a.nodeId === lastAttempt.value?.nodeId),
  ),
);
const report = computed(() =>
  [
    `# ${props.run.plan.title}`,
    `Status: ${statusLabel(props.run.status)}`,
    resultSummary.value,
    ...resultArtifacts.value.map(
      (a) => `## ${a.nodeId} / ${a.name}\n\n${a.content}`,
    ),
  ].join("\n\n"),
);
const selectedAttempt = computed(() =>
  props.run.attempts.filter((a) => a.nodeId === selected.value).at(-1),
);
function resume() {
  if (
    props.run.status === "interrupted" &&
    !window.confirm(
      "Review step logs and any command side effects first. Retry the interrupted step?",
    )
  ) {
    return;
  }
  emit("action", "resume");
}
function selectStep(id: string) {
  selected.value = plan.value.nodes.some((item) => item.id === id)
    ? id
    : undefined;
  if (tab.value === "edit") {
    tab.value = "workflow";
  }
}
</script>

<template>
  <section class="run-workspace">
    <div class="workflow-heading">
      <div>
        <div class="eyebrow">
          {{ run.status === "draft" ? "PROPOSED WORKFLOW" : "EXECUTION" }}
        </div>
        <h1>{{ run.plan.title }}</h1>
      </div>
      <span class="status-pill" :class="run.status"
        ><span class="status-dot" :class="run.status" />{{
          statusLabel(run.status)
        }}</span
      >
    </div>
    <div class="workflow-actions">
      <template v-if="run.status === 'draft'">
        <button
          class="primary"
          :disabled="busy || draft.dirty"
          :title="draft.dirty ? 'Save or discard your edits first' : undefined"
          @click="emit('action', 'approve')"
        >
          <Icon name="play" :size="16" />Approve & start
        </button>
        <button :disabled="busy" @click="tab = 'edit'">
          <Icon name="workflow" :size="16" />Edit workflow</button
        ><button
          class="quiet"
          :disabled="busy"
          @click="emit('action', 'reject')"
        >
          Reject
        </button>
      </template>
      <button
        v-if="run.status === 'running'"
        :disabled="busy"
        @click="emit('action', 'pause')"
      >
        <Icon name="pause" :size="16" />Pause after step
      </button>
      <button
        v-if="
          ['paused', 'interrupted'].includes(run.status) &&
          run.temporalWorkflowId
        "
        class="primary"
        :disabled="busy"
        @click="resume"
      >
        <Icon name="play" :size="16" />{{
          run.status === "interrupted"
            ? "Retry interrupted step"
            : "Resume workflow"
        }}
      </button>
      <button
        v-if="
          ['running', 'pausing', 'paused', 'interrupted'].includes(run.status)
        "
        class="danger-quiet"
        :disabled="busy"
        @click="emit('action', 'cancel')"
      >
        Stop execution
      </button>
      <button
        v-if="
          ['cancelled', 'failed', 'interrupted'].includes(run.status) &&
          run.executionProtocol === 2 &&
          run.config.recovery?.rollbackOnFailure !== false &&
          (lastAttempt?.recovery?.status === 'conflict' ||
            (run.status === 'interrupted' && !lastAttempt?.recovery))
        "
        :disabled="busy"
        @click="emit('action', 'recover')"
      >
        Retry file recovery
      </button>
      <span class="workflow-counts"
        >{{ run.plan.nodes.length }} blocks · {{ run.attempts.length }}/{{
          run.config.maxSteps
        }}
        step visits</span
      >
    </div>
    <div v-if="draft.dirty" class="draft-notice" role="status">
      <span>{{
        draft.stale
          ? "This workflow changed in another session. Your edits are preserved; load the latest draft before saving."
          : "Unsaved workflow changes. Save or discard them before execution."
      }}</span
      ><button @click="tab = 'edit'">Review edits</button>
    </div>
    <div v-if="run.error && !finished" class="inline-error" role="alert">
      {{ run.error }}
    </div>
    <div v-if="running" class="working-card" role="status">
      <div class="working-orb">
        <Icon
          :name="latestEvent?.kind.startsWith('check') ? 'shield' : 'spark'"
          :size="23"
        />
      </div>
      <div>
        <span class="eyebrow">{{ currentActivity(latestEvent) }}</span
        ><strong>{{ active?.label ?? "Preparing execution" }}</strong
        ><span>{{
          run.status === "pausing"
            ? "Finishing this step, then pausing"
            : (latestActivity?.preview.slice(0, 140) ?? "Starting…")
        }}</span>
      </div>
      <time
        >{{ Math.floor(elapsed / 60) }}:{{
          String(elapsed % 60).padStart(2, "0")
        }}</time
      >
    </div>
    <div
      v-if="finished"
      class="result-banner"
      :class="run.status"
      role="status"
    >
      <div class="result-icon">
        <Icon
          :name="run.status === 'completed' ? 'check' : 'file'"
          :size="22"
        />
      </div>
      <div>
        <strong>{{ resultTitle }}</strong>
        <MarkdownView :content="resultSummary" />
        <div class="result-links">
          <button @click="tab = 'results'">
            View full results<span v-if="artifacts.length">
              · {{ artifacts.length }} artifacts</span
            >
          </button>
          <button
            class="quiet"
            @click="
              selected = lastAttempt?.nodeId;
              tab = 'activity';
            "
          >
            View last step activity
          </button>
        </div>
      </div>
    </div>
    <div class="step-progress" aria-label="Workflow progress">
      <button
        v-for="(item, index) in run.plan.nodes"
        :key="item.id"
        class="progress-step"
        :class="[stepState(run, item.id), { selected: selected === item.id }]"
        @click="selectStep(item.id)"
      >
        <span class="step-number"
          ><Icon
            v-if="stepState(run, item.id) === 'pass'"
            name="check"
            :size="13"
          /><span
            v-else-if="stepState(run, item.id) === 'running'"
            class="spinner"
          /><template v-else>{{ index + 1 }}</template></span
        >
        <span
          >{{ item.label
          }}<small>{{
            run.blocks[item.block]?.definition.executor
              ? executionLabel(run.blocks[item.block]?.definition.executor)
              : (resolveAgentSettings(
                  run.config.agent,
                  run.blocks[item.block]?.definition.agent,
                  item.agent,
                ).model ?? "Project model")
          }}</small></span
        >
      </button>
    </div>
    <dialog
      ref="focusDialog"
      class="workflow-dialog"
      aria-label="Expanded workflow workspace"
      @cancel.prevent="closeWorkspace"
      @close="dialogClosed"
      @click.self="closeWorkspace"
      @keydown="dialogKeydown"
    />
    <Teleport :to="focusDialog ?? 'body'" :disabled="!expanded">
      <section class="details-panel">
        <header v-if="expanded" class="expanded-heading">
          <div>
            <span class="eyebrow">WORKFLOW WORKSPACE</span>
            <h2>{{ run.plan.title }}</h2>
          </div>
          <span class="status-pill" :class="run.status"
            ><span class="status-dot" :class="run.status" />{{
              statusLabel(run.status)
            }}</span
          >
        </header>
        <nav class="tabs" aria-label="Workflow views">
          <button
            v-for="[id, label, icon] in tabs"
            :key="id"
            :class="{ active: tab === id }"
            @click="tab = id"
          >
            <Icon :name="icon" :size="15" />{{ label }}</button
          ><span>{{
            running
              ? "Live"
              : run.program && !run.plan.nodes.length
                ? "Steps appear during execution"
                : `${completed}/${run.plan.nodes.length} blocks passed`
          }}</span>
          <button
            ref="expandButton"
            class="expand-workspace"
            :aria-label="expanded ? 'Close expanded view' : 'Expand workspace'"
            :title="
              expanded
                ? 'Close expanded view (Esc)'
                : 'Expand workflow, results and activity'
            "
            @click="expanded ? closeWorkspace() : expandWorkspace()"
          >
            <Icon :name="expanded ? 'close' : 'expand'" :size="16" /><span>{{
              expanded ? "Close" : "Expand"
            }}</span>
          </button>
        </nav>
        <div v-if="tab === 'results'" class="results-panel">
          <div class="card-title">
            <h2>{{ finished ? resultTitle : "Results so far" }}</h2>
            <MarkdownActions
              :content="report"
              :filename="`${run.id}-results.md`"
            />
          </div>
          <MarkdownView v-if="finished" :content="resultSummary" />
          <details
            v-if="run.attempts.some((attempt) => attempt.checks.length)"
            class="result-checks"
          >
            <summary>
              Verification checks ·
              {{
                run.attempts.reduce(
                  (sum, attempt) => sum + attempt.checks.length,
                  0,
                )
              }}
              recorded
            </summary>
            <template
              v-for="attempt in run.attempts"
              :key="`${attempt.nodeId}-${attempt.visit}`"
            >
              <details v-for="(check, index) in attempt.checks" :key="index">
                <summary>
                  {{
                    check.matched
                      ? "✓ Met expectation"
                      : "× Did not meet expectation"
                  }}
                  · {{ attempt.nodeId }} / visit {{ attempt.visit }} ·
                  {{ check.command }} · exit {{ check.exitCode ?? "unknown" }}
                </summary>
                <pre>{{ check.output }}</pre>
              </details>
            </template>
          </details>
          <div v-if="!artifacts.length && !finished" class="panel-empty">
            Step results will appear here as the workflow runs.
          </div>
          <article
            v-for="artifact in resultArtifacts"
            :key="`${artifact.nodeId}/${artifact.name}`"
            class="result-artifact"
          >
            <div class="card-title">
              <h3>
                {{
                  run.plan.nodes.find((n) => n.id === artifact.nodeId)?.label ??
                  artifact.nodeId
                }}
                / {{ artifact.name }}
              </h3>
              <MarkdownActions
                :content="artifact.content"
                :filename="`${artifact.nodeId}-${artifact.name}.md`"
              />
            </div>
            <MarkdownView :content="artifact.content" />
          </article>
        </div>
        <div
          v-if="tab === 'workflow'"
          class="workflow-canvas"
          :class="{ inspecting: node }"
        >
          <div class="graph-panel">
            <div v-if="!plan.nodes.length" class="panel-empty"><Icon name="code" :size="28" /><p>The graph appears as the TypeScript workflow reaches each step.</p><button @click="tab = 'edit'">View TypeScript</button></div>
            <WorkflowGraph v-else
              ref="graph"
              :key="run.id"
              :run="{ ...run, plan }"
              @select="selectStep"
            />
            <div class="graph-legend">
              <strong v-if="draft.dirty && draft.validPlan"
                >Unsaved preview</strong
              ><span>― pass</span><span>┄ retry with feedback</span
              ><span>― fail</span>
            </div>
          </div>
          <aside v-if="node && bundle" class="step-inspector">
            <div class="card-title">
              <span class="eyebrow">STEP DETAILS</span
              ><button
                class="icon-button"
                aria-label="Close step details"
                @click="selected = undefined"
              >
                <Icon name="close" />
              </button>
            </div>
            <h2>{{ node.label }}</h2>
            <p>{{ node.goal }}</p>
            <div
              v-if="selectedAttempt?.result || selectedAttempt?.error"
              class="step-result"
            >
              <h3>
                Latest step result ·
                {{ selectedAttempt.result?.outcome ?? "error" }}
              </h3>
              <MarkdownView
                :content="
                  selectedAttempt.error ?? selectedAttempt.result?.summary ?? ''
                "
              />
              <button class="quiet" @click="tab = 'results'">
                View results & artifacts
              </button>
            </div>
            <div class="detail-row">
              <span>Execution</span
              ><strong>{{
                bundle.definition.executor
                  ? executionLabel(bundle.definition.executor)
                  : (agent?.model ?? "Project model")
              }}</strong>
            </div>
            <div class="detail-row">
              <span>Visits</span
              ><strong
                >{{ run.visits[node.id] ?? 0 }} / {{ node.maxVisits }}</strong
              >
            </div>
            <h3>Context received</h3>
            <template v-if="node.inputs.length"
              ><div
                v-for="(input, index) in node.inputs"
                :key="index"
                class="handoff-label"
              >
                {{ input.node }} / {{ input.artifact
                }}<small
                  >{{ input.as ?? input.artifact }} ·
                  {{ input.required ? "required" : "optional" }}</small
                >
              </div></template
            >
            <template v-else-if="node.context && Object.keys(node.context).length">
              <details v-for="(value, name) in node.context" :key="name"><summary>{{ name }}</summary><pre>{{ value }}</pre></details>
            </template>
            <p v-else class="muted">Task and attachments only.</p>
            <button @click="tab = 'activity'">
              <Icon name="log" :size="15" />View step activity
            </button>
            <details>
              <summary>Instructions & tools</summary>
              <pre>{{ bundle.prompt }}</pre>
              <p v-if="!bundle.definition.executor">
                Full file access, Bash, Git and enabled MCP servers. Step
                instructions define the work to perform.
              </p>
              <h3>Host checks</h3>
              <pre>{{ JSON.stringify(bundle.definition.checks, null, 2) }}</pre>
            </details>
          </aside>
        </div>
        <ActivityFeed
          v-if="tab === 'activity'"
          :key="run.id"
          :events="events"
          :nodes="plan.nodes"
          :selected="selected"
          :running="running"
          :live-text="!selected || selected === run.cursor ? liveText : ''"
          @select="selected = $event"
        />
        <div v-if="tab === 'artifacts'" class="artifact-list">
          <p class="muted">
            Each step receives only the context selected in the workflow.
          </p>
          <details
            v-for="artifact in artifacts"
            :key="`${artifact.nodeId}-${artifact.name}`"
          >
            <summary>
              <Icon name="file" :size="16" />{{ artifact.nodeId }} /
              {{ artifact.name }}
            </summary>
            <MarkdownActions
              :content="artifact.content"
              :filename="`${artifact.nodeId}-${artifact.name}.md`"
            />
            <MarkdownView :content="artifact.content" />
          </details>
          <div v-if="!artifacts.length" class="panel-empty">
            <Icon name="folder" :size="26" />
            <p>No artifacts yet.</p>
          </div>
        </div>
        <ProgramEditor v-if="tab === 'edit' && run.program" :run="run" :draft="draft" :busy="busy" :live="live"
          :refining="refining" :activity="coordinatorActivity" @save="emit('save')" @refine="emit('refine', $event)"
          @cancel-refinement="emit('cancelRefinement')" />
        <PlanEditor
          v-else-if="tab === 'edit'"
          :run="run"
          :draft="draft"
          :busy="busy"
          :live="live"
          :coordinator-activity="coordinatorActivity"
          :coordinator-text="coordinatorText"
          :refining="refining"
          @cancel-refinement="emit('cancelRefinement')"
          @save="emit('save')"
          @refine="emit('refine', $event)"
          @setup="emit('settings')"
        />
      </section>
    </Teleport>
    <details class="run-metrics">
      <summary>
        <Icon name="clock" :size="14" />Execution details ·
        {{ run.attempts.length }} visits ·
        {{
          (
            (run.usage?.inputTokens ?? 0) +
            (run.usage?.outputTokens ?? 0) +
            (run.usage?.cacheReadTokens ?? 0) +
            (run.usage?.cacheWriteTokens ?? 0)
          ).toLocaleString()
        }}
        tokens
      </summary>
      <div class="metrics-grid">
        <div>
          <small>ESTIMATED COST</small
          ><strong>{{
            run.estimate?.expectedCostUsd == null
              ? "Pricing unavailable"
              : `$${run.estimate.expectedCostUsd.toFixed(4)}`
          }}</strong>
        </div>
        <div>
          <small>REPORTED COST</small
          ><strong>${{ (run.usage?.costUsd ?? 0).toFixed(4) }}</strong>
        </div>
        <div>
          <small>SPENDING LIMIT</small
          ><strong>{{
            run.config.budget?.maxCostUsd === undefined
              ? "None"
              : `$${run.config.budget.maxCostUsd}`
          }}</strong>
        </div>
      </div>
      <p>{{ run.estimate?.assumptions }}</p>
      <small
        >Version {{ run.executionVersion?.slice(0, 12) ?? "legacy" }} ·
        {{ run.id
        }}{{
          run.usage?.unpricedRequests
            ? ` · ${run.usage.unpricedRequests} requests without pricing`
            : ""
        }}</small
      >
    </details>
  </section>
</template>
