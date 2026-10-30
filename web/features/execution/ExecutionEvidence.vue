<script setup lang="ts">
import { computed } from "vue";
import type { RunEvent, WorkflowRun } from "../../../src/contracts/index.js";
import { runReport } from "./run-report.js";
import { executionEvidence } from "./execution-evidence.js";
import { useReportEvidence } from "./use-report-evidence.js";
const props = defineProps<{
  run: WorkflowRun;
  events: RunEvent[];
  now: number;
}>();
const {
  events: savedEvents,
  complete,
  available,
  loading,
  error,
  refresh,
} = useReportEvidence(
  () => props.run,
  () => props.events,
);
const report = computed(() => runReport(props.run, savedEvents.value));
const evidence = computed(() => executionEvidence(props.run, props.now));
const files = computed(() =>
  savedEvents.value
    .filter((event) => ["file_evidence", "file_evidence_unavailable"].includes(event.kind))
    .map((event) => {
      try {
        return {
          event,
          evidence: event.kind === "file_evidence" ? JSON.parse(event.message) : undefined,
        };
      } catch {
        return { event, evidence: undefined };
      }
    }),
);
const ownership = computed(() =>
  savedEvents.value.filter((event) =>
    ["ownership_evidence", "ownership_violation", "ownership_contract"].includes(event.kind),
  ),
);
function ownershipText(event: RunEvent) {
  if (event.kind === "ownership_violation") return event.message;
  try {
    const value = JSON.parse(event.message);
    if (event.kind === "ownership_contract")
      return `Assigned role: ${value.role}. Allowed writes: ${value.writablePaths === undefined ? "outside protected patterns" : value.writablePaths.join(", ") || "none"}. Protected: ${value.protectedPaths?.join(", ") || "all paths outside the allowlist"}.`;
    return `${value.checkedFileCount ?? value.checkedFiles?.length ?? 0} protected files verified unchanged. Allowed writes: ${value.writablePaths === undefined ? "not restricted by an allowlist" : value.writablePaths.join(", ") || "none"}. Protected patterns: ${value.protectedPaths.join(", ") || "all paths outside the allowlist"}.`;
  } catch {
    return "Ownership evidence is incomplete; inspect activity.";
  }
}
</script>
<template>
  <details class="result-checks" open>
    <summary>Execution evidence · {{ evidence.intervals.length }} step attempts</summary>
    <p v-if="loading" role="status">Loading complete saved evidence…</p>
    <div v-else-if="error" class="inline-error" role="alert">
      Could not load complete execution evidence: {{ error }}
      Missing records have not been established.
      <button @click="refresh">Retry evidence loading</button>
    </div>
    <p v-else-if="!available">
      Saved execution history is unavailable. Missing records have not been established.
    </p>
    <p>
      Step success is separate from task acceptance. Authoring can complete with valid failing
      tests; acceptance depends on the workflow’s checks and review.
    </p>
    <h3>Result summary</h3>
    <p>
      {{ report.accepted.length }} latest step results explicitly accepted;
      {{ report.unresolved.length }} latest results unresolved. {{ report.checks.length }} host
      checks recorded.
    </p>
    <p v-if="!report.accepted.length">
      No explicit acceptance result recorded. A completed workflow alone does not establish verified
      acceptance.
    </p>
    <ul>
      <li v-for="attempt in report.unresolved" :key="attempt.nodeId">
        <details>
          <summary>
            {{ attempt.nodeId }} ·
            {{ attempt.result?.disposition || attempt.result?.outcome || "Execution error" }}
          </summary>
          <pre>{{ attempt.error || attempt.result?.summary }}</pre>
        </details>
      </li>
    </ul>
    <details v-if="report.checks.length">
      <summary>Host check evidence</summary>
      <ul>
        <li v-for="(check, index) in report.checks" :key="index">
          {{ check.nodeId }} · visit {{ check.visit }} · {{ check.command }} · expected
          {{ check.expected }} · exit {{ check.exitCode }} ·
          {{ check.matched ? "matched" : "NOT matched" }}
          <pre>{{ check.output }}</pre>
        </li>
      </ul>
    </details>
    <h3>Decisions</h3>
    <p v-if="complete && !report.decisions.length">
      No predicate evaluations recorded. Older runs retain their group state but not decision
      history.
    </p>
    <ol v-else>
      <li v-for="decision in report.decisions" :key="decision.id">
        {{ decision.groupId
        }}<template v-if="decision.iteration"> · round {{ decision.iteration }}</template
        >:
        {{ decision.result === undefined ? "not evaluated" : decision.result }}
        → <strong>{{ decision.route }}</strong
        >. {{ decision.reason }}
      </li>
    </ol>
    <details v-if="savedEvents.some((event) => event.kind === 'capability_warning')" open>
      <summary>Capability warnings</summary>
      <ul>
        <li
          v-for="event in savedEvents.filter((event) => event.kind === 'capability_warning')"
          :key="event.id"
        >
          {{ event.message }}
        </li>
      </ul>
    </details>
    <h3>Actual model calls</h3>
    <p v-if="complete && !report.calls.length">
      No detailed model-session records. See agent-start activity for older runs; step defaults may
      differ from inner calls.
    </p>
    <details v-for="call in report.calls" :key="call.id">
      <summary>
        {{ call.nodeId }} · {{ call.description
        }}<template v-if="call.durationMs !== undefined">
          · {{ (call.durationMs / 1000).toFixed(1) }}s</template
        >
      </summary>
      <p>Exposed tools: {{ call.tools.join(", ") || "none" }}</p>
      <p v-if="call.usage">
        {{ call.usage.inputTokens }} input / {{ call.usage.outputTokens }} output tokens ·
        {{ call.usage.requests }} requests ·
        {{ call.usage.unpricedRequests ? "cost incomplete" : "$" + call.usage.costUsd.toFixed(4) }}
      </p>
    </details>
    <div style="overflow-x: auto">
      <table>
        <thead>
          <tr>
            <th>Step</th>
            <th>Visit</th>
            <th>Duration</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="attempt in evidence.intervals" :key="`${attempt.nodeId}-${attempt.visit}`">
            <td>{{ attempt.label }}</td>
            <td>{{ attempt.visit }}</td>
            <td>{{ ((attempt.end - attempt.start) / 1000).toFixed(1) }}s</td>
            <td>{{ attempt.outcome }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <h3>Concurrent execution</h3>
    <p v-if="!evidence.overlaps.length">No overlapping step attempts recorded.</p>
    <ul v-else>
      <li v-for="(overlap, index) in evidence.overlaps" :key="index">
        {{ overlap.first }} + {{ overlap.second }}: {{ overlap.seconds.toFixed(1) }}s overlap
      </li>
    </ul>
    <p>
      Overlapping attempts prove scheduling overlap, not simultaneous model calls or safe
      integration. Inspect separate workspaces and the verification after the join before accepting
      concurrent edits.
    </p>
    <h3>Concurrent model sessions</h3>
    <p v-if="complete && !report.modelOverlaps.length">
      No completed overlapping model sessions recorded.
    </p>
    <ul v-else>
      <li v-for="(overlap, index) in report.modelOverlaps" :key="index">
        {{ overlap.first }} + {{ overlap.second }}: {{ overlap.seconds.toFixed(1) }}s ·
        {{
          overlap.isolated
            ? "different execution workspaces"
            : "workspace isolation not established"
        }}
      </li>
    </ul>
    <h3>Execution workspaces</h3>
    <p v-if="complete && !savedEvents.some((item) => item.kind === 'execution_workspace')">
      No workspace records captured for this run.
    </p>
    <ul>
      <li
        v-for="event in savedEvents.filter((item) => item.kind === 'execution_workspace')"
        :key="event.id"
      >
        {{ event.nodeId }}: {{ event.message }}
      </li>
    </ul>
    <h3>File changes</h3>
    <p>
      Snapshots compare files before and after each AI call. Shared-workspace changes may include
      other concurrent writers; isolated worktrees provide separate evidence. Runtime/dependency
      trees and transient edits are excluded.
    </p>
    <ul
      v-if="run.attempts.some((attempt) => attempt.recovery && attempt.recovery.status !== 'none')"
    >
      <li
        v-for="attempt in run.attempts.filter(
          (attempt) => attempt.recovery && attempt.recovery.status !== 'none',
        )"
        :key="`recovery-${attempt.nodeId}-${attempt.visit}`"
      >
        {{ attempt.nodeId }} · visit {{ attempt.visit }} · file recovery:
        {{ attempt.recovery?.status }}.
        <template v-if="attempt.recovery?.restored.length"
          >Restored: {{ attempt.recovery.restored.join(", ") }}.</template
        >
        <template v-if="attempt.recovery?.conflicts.length"
          >Conflicts retained: {{ attempt.recovery.conflicts.join(", ") }}.</template
        >
      </li>
    </ul>
    <p v-if="complete && !files.length">No file-change snapshots recorded.</p>
    <details v-for="item in files" :key="item.event.id">
      <summary>
        {{ item.event.nodeId }} ·
        {{
          item.evidence ? `${item.evidence.changedFileCount} files changed` : "Evidence unavailable"
        }}
      </summary>
      <template v-if="item.evidence"
        ><p>{{ item.evidence.workspace }}</p>
        <ul>
          <li v-for="change in item.evidence.changes" :key="change.path">
            {{ change.path }} ·
            {{ change.before === null ? "added" : change.after === null ? "deleted" : "modified" }}
          </li>
        </ul>
        <p v-if="item.evidence.changedFileCount > 100">Showing the first 100 files.</p></template
      >
      <p v-else>{{ item.event.message }}</p>
    </details>
    <h3>File ownership</h3>
    <p v-if="complete && !ownership.length">
      No file-ownership evidence recorded for this run. This does not establish that files were
      unchanged.
    </p>
    <ul v-else>
      <li v-for="event in ownership" :key="event.id">
        <strong>{{ event.nodeId }}</strong
        >: {{ ownershipText(event) }}
      </li>
    </ul>
  </details>
</template>
<style scoped>
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
th,
td {
  padding: 0.65rem 0.85rem;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent);
}
th:first-child,
td:first-child {
  padding-left: 0;
}
td:nth-child(2),
td:nth-child(3) {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
li {
  overflow-wrap: anywhere;
  margin-block: 0.4rem;
}
</style>
