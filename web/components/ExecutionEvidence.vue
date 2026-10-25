<script setup lang="ts">
import { computed } from "vue";
import type { RunEvent, WorkflowRun } from "../../src/domain.js";
import { executionEvidence } from "../execution-evidence.js";
const props = defineProps<{
  run: WorkflowRun;
  events: RunEvent[];
  now: number;
}>();
const evidence = computed(() => executionEvidence(props.run, props.now));
const files = computed(() =>
  props.events
    .filter((event) =>
      ["file_evidence", "file_evidence_unavailable"].includes(event.kind),
    )
    .map((event) => {
      try {
        return {
          event,
          evidence:
            event.kind === "file_evidence"
              ? JSON.parse(event.message)
              : undefined,
        };
      } catch {
        return { event, evidence: undefined };
      }
    }),
);
const ownership = computed(() =>
  props.events.filter((event) =>
    ["ownership_evidence", "ownership_violation"].includes(event.kind),
  ),
);
function ownershipText(event: RunEvent) {
  if (event.kind === "ownership_violation") return event.message;
  try {
    const value = JSON.parse(event.message);
    return `${value.checkedFileCount ?? value.checkedFiles?.length ?? 0} protected files verified unchanged. Allowed writes: ${value.writablePaths === undefined ? "not restricted by an allowlist" : value.writablePaths.join(", ") || "none"}. Protected patterns: ${value.protectedPaths.join(", ") || "all paths outside the allowlist"}.`;
  } catch {
    return "Ownership evidence is incomplete; inspect activity.";
  }
}
</script>
<template>
  <details class="result-checks" open>
    <summary>
      Execution evidence · {{ evidence.intervals.length }} step attempts
    </summary>
    <p>
      Step success is separate from task acceptance. Authoring can complete with
      valid failing tests; acceptance depends on the workflow’s checks and
      review.
    </p>
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
          <tr
            v-for="attempt in evidence.intervals"
            :key="`${attempt.nodeId}-${attempt.visit}`"
          >
            <td>{{ attempt.label }}</td>
            <td>{{ attempt.visit }}</td>
            <td>{{ ((attempt.end - attempt.start) / 1000).toFixed(1) }}s</td>
            <td>{{ attempt.outcome }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <h3>Concurrent execution</h3>
    <p v-if="!evidence.overlaps.length">
      No overlapping step attempts recorded.
    </p>
    <ul v-else>
      <li v-for="(overlap, index) in evidence.overlaps" :key="index">
        {{ overlap.first }} + {{ overlap.second }}:
        {{ overlap.seconds.toFixed(1) }}s overlap
      </li>
    </ul>
    <h3>Execution workspaces</h3>
    <p v-if="!events.some((item) => item.kind === 'execution_workspace')">
      No workspace records captured for this run.
    </p>
    <ul>
      <li
        v-for="event in events.filter(
          (item) => item.kind === 'execution_workspace',
        )"
        :key="event.id"
      >
        {{ event.nodeId }}: {{ event.message }}
      </li>
    </ul>
    <h3>File changes</h3>
    <p>
      Snapshots compare files before and after each AI call. Shared-workspace
      changes may include other concurrent writers; isolated worktrees provide
      separate evidence. Runtime/dependency trees and transient edits are
      excluded.
    </p>
    <ul
      v-if="
        run.attempts.some(
          (attempt) => attempt.recovery && attempt.recovery.status !== 'none',
        )
      "
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
          >Conflicts retained:
          {{ attempt.recovery.conflicts.join(", ") }}.</template
        >
      </li>
    </ul>
    <p v-if="!files.length">No file-change snapshots recorded.</p>
    <details v-for="item in files" :key="item.event.id">
      <summary>
        {{ item.event.nodeId }} ·
        {{
          item.evidence
            ? `${item.evidence.changedFileCount} files changed`
            : "Evidence unavailable"
        }}
      </summary>
      <template v-if="item.evidence"
        ><p>{{ item.evidence.workspace }}</p>
        <ul>
          <li v-for="change in item.evidence.changes" :key="change.path">
            {{ change.path }} ·
            {{
              change.before === null
                ? "added"
                : change.after === null
                  ? "deleted"
                  : "modified"
            }}
          </li>
        </ul>
        <p v-if="item.evidence.changedFileCount > 100">
          Showing the first 100 files.
        </p></template
      >
      <p v-else>{{ item.event.message }}</p>
    </details>
    <h3>File ownership</h3>
    <p v-if="!ownership.length">
      No file-ownership evidence recorded for this run. This does not establish
      that files were unchanged.
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
