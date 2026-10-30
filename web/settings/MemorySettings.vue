<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import type {
  MemoryEntry,
  MemoryState,
  MemoryDescription,
} from "../../src/contracts.js";
import { WorkflowApiError } from "../../src/client.js";
import { client } from "../api.js";
import { usageCost, usageTokens } from "../usage-presentation.js";
import Field from "../components/Field.vue";
import StrategyFacts from "../components/StrategyFacts.vue";

const emit = defineEmits<{ dirty: [value: boolean]; busy: [value: boolean] }>();
const state = ref<MemoryState>();
const selected = ref<MemoryEntry>();
const editing = ref(false);
const newKind = ref<"note" | "preference">("note");
const empty = () => ({ title: "", description: "", details: "", tags: "" });
const form = ref(empty());
const saved = ref(JSON.stringify(form.value));
const formRevision = ref("");
const query = ref("");
const kind = ref("");
const busy = ref(false);
const loading = ref(false);
const detailLoading = ref(false);
const error = ref("");
const loadError = ref("");
const notice = ref("");
const conflict = ref(false);
const latest = ref<{ entry: MemoryEntry; revision: string }>();
const lifecycle = new AbortController();
let detailController: AbortController | undefined;
let detailVersion = 0;
let stateVersion = 0;
let disposed = false;
const dirty = computed(
  () => editing.value && JSON.stringify(form.value) !== saved.value,
);
const entries = computed(() => {
  const text = query.value.trim().toLocaleLowerCase();
  return (state.value?.entries ?? []).filter(
    (entry) =>
      (!kind.value || entry.kind === kind.value) &&
      (!text ||
        [entry.title, entry.description, ...entry.tags]
          .join(" ")
          .toLocaleLowerCase()
          .includes(text)),
  );
});
const changed = computed(
  () =>
    selected.value &&
    state.value &&
    state.value.entries.find((entry) => entry.id === selected.value!.id)
      ?.updatedAt !== selected.value.updatedAt,
);
const observation = computed(() => selected.value?.observation);
const strategy = computed(() => selected.value?.strategy);
const caption = (kind: string) =>
  kind === "preference"
    ? "Explicit preference"
    : kind === "observation"
      ? "Observed work"
      : kind === "strategy"
        ? "Remembered strategy"
        : "Project note";
const date = (value: string) => new Date(value).toLocaleString();
watch(dirty, (value) => emit("dirty", value));
watch(busy, (value) => emit("busy", value));
function reset(entry?: MemoryEntry, revision = state.value?.revision ?? "") {
  selected.value = entry;
  form.value = entry
    ? {
        title: entry.title,
        description: entry.description,
        details: entry.details,
        tags: entry.tags.join(", "),
      }
    : empty();
  saved.value = JSON.stringify(form.value);
  formRevision.value = revision;
  error.value = "";
  conflict.value = false;
  latest.value = undefined;
}
function discard() {
  form.value = JSON.parse(saved.value);
  error.value = "";
}
defineExpose({ discard });
function canLeave() {
  return !dirty.value || window.confirm("Discard unsaved memory edits?");
}
function create(kind: "note" | "preference") {
  if (!canLeave()) return;
  detailVersion++;
  detailController?.abort();
  detailLoading.value = false;
  newKind.value = kind;
  editing.value = true;
  notice.value = "";
  reset();
}
async function load() {
  const version = ++stateVersion;
  loading.value = true;
  loadError.value = "";
  try {
    const value = await client.memory(lifecycle.signal);
    if (version === stateVersion && !disposed) state.value = value;
  } catch (failure) {
    if (version === stateVersion && !disposed)
      loadError.value =
        failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (version === stateVersion && !disposed) loading.value = false;
  }
}
async function open(entry: MemoryDescription) {
  if (!canLeave()) return;
  const version = ++detailVersion;
  detailController?.abort();
  detailController = new AbortController();
  const revision = state.value?.revision ?? "";
  editing.value = false;
  selected.value = undefined;
  detailLoading.value = true;
  error.value = "";
  notice.value = "";
  conflict.value = false;
  latest.value = undefined;
  try {
    const value = await client.memoryEntry(entry.id, detailController.signal);
    if (version !== detailVersion || disposed) return;
    reset(value, revision);
    editing.value = true;
  } catch (failure) {
    if (version === detailVersion && !disposed)
      error.value =
        failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (version === detailVersion && !disposed) detailLoading.value = false;
  }
}
async function perform(action: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
  } catch (failure) {
    if (!disposed) {
      error.value =
        failure instanceof Error ? failure.message : String(failure);
      conflict.value =
        failure instanceof WorkflowApiError && failure.status === 409;
      if (conflict.value) latest.value = undefined;
    }
  } finally {
    if (!disposed) busy.value = false;
  }
}
function applyState(value: MemoryState) {
  stateVersion++;
  state.value = value;
  loading.value = false;
  loadError.value = "";
}
async function toggle() {
  if (!state.value) return;
  const prior = state.value.revision;
  const updated = await client.setMemoryEnabled(!state.value.enabled, prior);
  if (disposed) return;
  // A switch change only changes collection/retrieval, so this client's own edit stays valid.
  if (formRevision.value === prior) formRevision.value = updated.revision;
  applyState(updated);
  notice.value = updated.enabled
    ? "Project memory enabled. New planning sessions can consult these entries."
    : "Project memory disabled. Saved entries are retained; future collection and memory reads are stopped.";
}
function fields() {
  const tags = form.value.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.length > 8 || tags.some((tag) => tag.length > 40))
    throw new Error("Use at most 8 tags, with at most 40 characters each.");
  return {
    title: form.value.title.trim(),
    description: form.value.description.trim(),
    details: form.value.details,
    tags,
  };
}
async function save(revision?: string) {
  if (!state.value) return;
  const value = fields();
  const result = selected.value
    ? await client.updateMemoryEntry(selected.value.id, {
        ...value,
        revision: revision ?? formRevision.value,
      })
    : await client.createMemoryEntry({
        ...value,
        kind: newKind.value,
        revision: state.value.revision,
      });
  if (disposed) return;
  applyState(result.state);
  reset(result.entry, result.state.revision);
  notice.value = state.value.enabled
    ? "Memory entry saved."
    : "Memory entry saved. Project memory remains disabled.";
}
async function remove() {
  if (
    !state.value ||
    !selected.value ||
    !window.confirm(`Delete “${selected.value.title}” from project memory?`)
  )
    return;
  const updated = await client.deleteMemoryEntry(
    selected.value.id,
    formRevision.value,
  );
  if (disposed) return;
  applyState(updated);
  reset();
  editing.value = false;
  notice.value = "Memory entry deleted.";
}
async function reviewLatest() {
  if (!selected.value) {
    await load();
    return;
  }
  // Capture the state revision before the detail. A concurrent write then causes a safe conflict.
  const updated = await client.memory(lifecycle.signal);
  const entry = await client.memoryEntry(selected.value.id, lifecycle.signal);
  if (disposed) return;
  applyState(updated);
  latest.value = { entry, revision: updated.revision };
}
function reloadLatest() {
  if (!latest.value || !canLeave()) return;
  reset(latest.value.entry, latest.value.revision);
  notice.value = "Latest saved entry loaded.";
}
onMounted(() => void load());
onScopeDispose(() => {
  disposed = true;
  lifecycle.abort();
  detailController?.abort();
  emit("dirty", false);
  emit("busy", false);
});
</script>

<template>
  <section class="memory-settings" aria-label="Project memory">
    <div class="settings-section-title">
      <div>
        <h2>Project memory</h2>
        <p>
          Keep concise project guidance and recorded outcomes for future
          planning. Disabled by default.
        </p>
      </div>
      <button :disabled="busy || loading" @click="load">
        {{ loading ? "Refreshing…" : "Refresh memory" }}
      </button>
    </div>
    <p v-if="loading && !state" role="status">Loading project memory…</p>
    <div v-if="loadError" class="inline-error" role="alert">
      {{ loadError }}
      <button :disabled="loading || busy" @click="load">
        Retry loading memory
      </button>
    </div>
    <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
    <p v-if="notice" class="setup-notice" role="status">{{ notice }}</p>
    <template v-if="state">
      <div class="settings-card memory-switch">
        <div>
          <strong>Project memory is {{ state.enabled ? "on" : "off" }}</strong>
          <p>
            {{
              state.enabled
                ? "The planner reads compact descriptions first and loads selected details only when useful. Ordinary live work can add observations."
                : "The planner does not read these entries and new work does not add observations. You can still manage saved entries."
            }}
          </p>
          <small
            >Turning memory off keeps your entries. It stops future reads and
            collection; context already supplied to an active session cannot be
            recalled. Memory does not launch background AI jobs or
            benchmarks.</small
          >
        </div>
        <button
          :class="{ primary: !state.enabled }"
          :disabled="busy"
          @click="perform(toggle)"
        >
          {{
            state.enabled ? "Disable project memory" : "Enable project memory"
          }}
        </button>
      </div>
      <div class="memory-list-heading">
        <div>
          <h3>
            Saved entries
            <small>{{ state.entries.length }} / {{ state.limit }}</small>
          </h3>
          <p>
            Descriptions help the planner choose what to read. Details load when
            you open an entry.
          </p>
        </div>
        <div class="button-row">
          <button
            :disabled="busy || state.entries.length >= state.limit"
            @click="create('note')"
          >
            New note</button
          ><button
            :disabled="busy || state.entries.length >= state.limit"
            @click="create('preference')"
          >
            New preference
          </button>
        </div>
      </div>
      <p v-if="state.entries.length >= state.limit" class="setup-notice">
        Project memory is full. Delete an entry before adding another.
      </p>
      <div v-if="state.entries.length" class="memory-filters">
        <Field v-slot="{ id }" label="Search memory descriptions"
          ><input
            :id="id"
            v-model="query"
            type="search"
            placeholder="Title, description or tags"
        /></Field>
        <Field v-slot="{ id }" label="Entry type"
          ><select :id="id" v-model="kind">
            <option value="">All entries</option>
            <option value="note">Project notes</option>
            <option value="preference">Explicit preferences</option>
            <option value="observation">Observed work</option>
            <option value="strategy">Remembered strategies</option>
          </select></Field
        >
      </div>
      <div class="memory-layout">
        <div class="memory-list" aria-label="Memory descriptions">
          <p v-if="!state.entries.length" class="memory-empty">
            No saved entries yet. Add a project note or an explicit preference.
            Observations appear only from ordinary live runs started while
            memory is enabled.
          </p>
          <p v-else-if="!entries.length" class="memory-empty">
            No descriptions match your search.
          </p>
          <button
            v-for="entry in entries"
            :key="entry.id"
            class="memory-entry"
            :aria-pressed="selected?.id === entry.id"
            :disabled="busy"
            @click="open(entry)"
          >
            <span class="memory-kind">{{ caption(entry.kind) }}</span
            ><strong>{{ entry.title }}</strong
            ><span>{{ entry.description }}</span
            ><small v-if="entry.tags.length">{{
              entry.tags.join(" · ")
            }}</small>
          </button>
        </div>
        <div class="memory-detail">
          <p v-if="detailLoading" role="status">Loading entry details…</p>
          <p v-else-if="!editing && state.entries.length" class="memory-empty">
            Open an entry to read its details and recorded facts.
          </p>
          <form
            v-if="editing"
            class="settings-card"
            aria-label="Memory entry editor"
            @submit.prevent="perform(() => save())"
          >
            <div class="memory-editor-heading">
              <h3>
                {{
                  selected
                    ? caption(selected.kind)
                    : newKind === "preference"
                      ? "New explicit preference"
                      : "New project note"
                }}
              </h3>
              <small v-if="selected"
                >Updated {{ date(selected.updatedAt) }}</small
              >
            </div>
            <p v-if="(selected?.kind ?? newKind) === 'preference'">
              This is an explicit preference you choose to save. Workflow does
              not infer preferences from your activity.
            </p>
            <p v-if="selected?.kind === 'observation'">
              {{
                selected.edited
                  ? "Your annotation"
                  : "Generated observation text"
              }}: you can edit this guidance. The recorded facts below remain
              unchanged.
            </p>
            <p v-if="selected?.kind === 'strategy'">
              You chose to remember this approach. Edit the reusable guidance;
              source facts stay unchanged. Future planning composes a fresh
              workflow under the current models and permissions.
            </p>
            <fieldset class="settings-fields" :disabled="busy">
              <Field v-slot="{ id }" label="Memory title"
                ><input
                  :id="id"
                  v-model="form.title"
                  required
                  maxlength="100"
                  placeholder="How we review UI changes"
              /></Field>
              <Field
                v-slot="{ id }"
                label="Short description"
                help="Up to 300 characters. The planner sees this before choosing to load the details."
              >
                <textarea
                  :id="id"
                  v-model="form.description"
                  rows="2"
                  required
                  maxlength="300"
                  placeholder="When this guidance is useful"
                />
              </Field>
              <Field
                v-slot="{ id }"
                :label="
                  selected?.kind === 'observation'
                    ? 'Your annotation'
                    : selected?.kind === 'strategy'
                      ? 'Reusable guidance'
                      : 'Memory details'
                "
                help="Up to 4,000 characters. Keep reusable guidance focused; current requests and project permissions still apply."
              >
                <textarea
                  :id="id"
                  v-model="form.details"
                  rows="7"
                  maxlength="4000"
                  placeholder="Specific guidance worth retaining"
                />
              </Field>
              <Field
                v-slot="{ id }"
                label="Memory tags"
                help="Optional, comma separated. Up to 8 tags of 40 characters each."
                ><input
                  :id="id"
                  v-model="form.tags"
                  placeholder="review, frontend"
              /></Field>
              <div class="button-row">
                <button type="submit" class="primary" :disabled="!dirty">
                  {{ busy ? "Saving…" : "Save memory entry" }}</button
                ><button v-if="dirty" type="button" @click="discard">
                  Discard entry edits</button
                ><button
                  v-if="selected"
                  type="button"
                  class="danger"
                  @click="perform(remove)"
                >
                  Delete entry
                </button>
              </div>
            </fieldset>
            <div
              v-if="conflict || changed"
              class="memory-conflict"
              role="status"
            >
              <p>
                The saved memory changed. Your draft is preserved. Review the
                latest saved version before replacing it.
              </p>
              <button
                type="button"
                :disabled="busy"
                @click="perform(reviewLatest)"
              >
                Review latest saved entry
              </button>
              <div v-if="latest" class="memory-latest">
                <h4>Latest saved version</h4>
                <strong>{{ latest.entry.title }}</strong>
                <p>{{ latest.entry.description }}</p>
                <pre>{{ latest.entry.details }}</pre>
                <p v-if="latest.entry.tags.length">
                  Tags: {{ latest.entry.tags.join(", ") }}
                </p>
                <div class="button-row">
                  <button type="button" :disabled="busy" @click="reloadLatest">
                    Reload latest entry</button
                  ><button
                    type="button"
                    :disabled="busy || !dirty"
                    @click="perform(() => save(latest!.revision))"
                  >
                    Save my edits over this version
                  </button>
                </div>
              </div>
            </div>
            <p v-if="selected" class="memory-id">Entry {{ selected.id }}</p>
          </form>
          <section
            v-if="observation"
            class="settings-card memory-observation"
            aria-label="Recorded observation facts"
          >
            <h3>Recorded facts</h3>
            <p>
              These are observed execution outcomes, not a quality score or
              proof that changes were correct. Matched check conditions can
              include expected failures.
            </p>
            <dl class="memory-facts">
              <div>
                <dt>Task type</dt>
                <dd>
                  {{ observation.taskCaseName }} · {{ observation.taskCaseId }}
                </dd>
              </div>
              <div>
                <dt>Block</dt>
                <dd>{{ observation.blockId }}</dd>
              </div>
              <div>
                <dt>Recorded model</dt>
                <dd>
                  {{
                    observation.model
                      ? `${observation.model.provider}/${observation.model.model} · ${observation.model.thinking}`
                      : "Model attribution unavailable"
                  }}
                </dd>
              </div>
              <div>
                <dt>Runs / visits</dt>
                <dd>{{ observation.runs }} / {{ observation.visits }}</dd>
              </div>
              <div>
                <dt>Run outcomes</dt>
                <dd>
                  {{ observation.runStatuses.completed }} completed ·
                  {{ observation.runStatuses.failed }} failed ·
                  {{ observation.runStatuses.cancelled }} cancelled
                </dd>
              </div>
              <div>
                <dt>Visit outcomes</dt>
                <dd>
                  {{ observation.outcomes.pass }} pass ·
                  {{ observation.outcomes.retry }} retry ·
                  {{ observation.outcomes.fail }} fail ·
                  {{ observation.outcomes.interrupted }} interrupted
                </dd>
              </div>
              <div>
                <dt>Configured check conditions</dt>
                <dd>
                  {{ observation.checks.matched }} matched ·
                  {{ observation.checks.unmatched }} unmatched ·
                  {{ observation.checks.total }} recorded
                </dd>
              </div>
              <div>
                <dt>Reported usage</dt>
                <dd>
                  {{
                    usageCost(
                      observation.usage,
                      observation.usageIncomplete ||
                        observation.sessionStatuses.running > 0 ||
                        observation.sessionStatuses.interrupted > 0,
                    )
                  }}
                  · {{ usageTokens(observation.usage).toLocaleString() }} tokens
                  · {{ observation.sessions }} sessions
                </dd>
              </div>
            </dl>
            <details>
              <summary>Session status and acceptance signals</summary>
              <p>
                {{ observation.sessionStatuses.completed }} completed ·
                {{ observation.sessionStatuses.failed }} failed ·
                {{ observation.sessionStatuses.cancelled }} cancelled ·
                {{ observation.sessionStatuses.interrupted }} interrupted ·
                {{ observation.sessionStatuses.running }} running
              </p>
              <p>
                {{ observation.dispositions.workCompleted }} work completed ·
                {{ observation.dispositions.accepted }} accepted ·
                {{ observation.dispositions.changesRequested }} changes
                requested · {{ observation.dispositions.blocked }} blocked
              </p>
            </details>
            <p>
              Observed {{ date(observation.firstObservedAt) }} —
              {{ date(observation.lastObservedAt) }}
            </p>
            <h4>Recent sources</h4>
            <ul class="memory-sources">
              <li
                v-for="source in observation.sources"
                :key="`${source.runId}/${source.nodeId}/${source.visit}`"
              >
                <a :href="`#run=${source.runId}`"
                  >{{ source.nodeId }} · visit {{ source.visit }}</a
                ><small>{{ date(source.at) }} · {{ source.runId }}</small>
              </li>
            </ul>
          </section>
          <div v-if="strategy" class="settings-card">
            <StrategyFacts :metadata="strategy" />
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.memory-settings {
  min-width: 0;
}
.memory-settings p {
  line-height: 1.6;
}
.memory-switch,
.memory-list-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}
.memory-switch > div {
  max-width: 800px;
}
.memory-switch > button {
  flex-shrink: 0;
}
.memory-switch small,
.memory-list-heading p,
.memory-editor-heading small,
.memory-id {
  color: var(--ctp-subtext0);
}
.memory-list-heading {
  margin: 24px 0 10px;
}
.memory-list-heading h3 {
  margin: 0;
}
.memory-list-heading h3 small {
  margin-left: 8px;
  color: var(--ctp-overlay1);
  font-weight: 400;
}
.memory-list-heading p {
  margin: 6px 0 0;
}
.memory-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(170px, 240px);
  gap: 16px;
}
.memory-layout {
  display: grid;
  grid-template-columns: minmax(230px, 0.8fr) minmax(0, 1.4fr);
  gap: 20px;
  align-items: start;
}
.memory-list {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.memory-entry {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 16px;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
}
.memory-entry[aria-pressed="true"] {
  border-color: var(--ctp-blue);
  background: var(--ctp-surface0);
}
.memory-entry > span:not(.memory-kind),
.memory-entry small {
  color: var(--ctp-subtext0);
  line-height: 1.5;
}
.memory-kind {
  color: var(--ctp-mauve);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.memory-empty {
  color: var(--ctp-subtext0);
  padding: 20px;
  border: 1px dashed var(--ctp-surface1);
  border-radius: 12px;
  margin: 0;
}
.memory-detail,
.memory-detail > * {
  min-width: 0;
}
.memory-detail .settings-card:first-child {
  margin-top: 0;
}
.memory-editor-heading {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}
.memory-editor-heading h3 {
  margin: 0 0 12px;
}
.memory-detail textarea {
  resize: vertical;
  min-height: 70px;
}
.memory-conflict {
  margin-top: 18px;
  padding: 14px;
  border: 1px solid var(--ctp-yellow);
  border-radius: 8px;
}
.memory-latest {
  margin-top: 14px;
}
.memory-latest pre {
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--ctp-mantle);
  padding: 12px;
}
.memory-id {
  font-size: 10px;
  margin-bottom: 0;
  overflow-wrap: anywhere;
}
.memory-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.memory-facts > div {
  min-width: 0;
}
.memory-facts dt {
  color: var(--ctp-subtext0);
  font-size: 11px;
  margin-bottom: 5px;
}
.memory-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.memory-observation summary {
  cursor: pointer;
}
.memory-sources {
  padding-left: 18px;
}
.memory-sources li {
  margin-top: 10px;
}
.memory-sources small {
  display: block;
  color: var(--ctp-subtext0);
  overflow-wrap: anywhere;
  margin-top: 5px;
}
@media (max-width: 1050px) {
  .memory-layout {
    grid-template-columns: minmax(190px, 0.7fr) minmax(0, 1.3fr);
  }
}
@media (max-width: 780px) {
  .memory-switch,
  .memory-list-heading {
    flex-direction: column;
    gap: 12px;
  }
  .memory-filters,
  .memory-layout,
  .memory-facts {
    grid-template-columns: minmax(0, 1fr);
  }
  .memory-filters {
    gap: 0;
  }
  .memory-list {
    max-height: 340px;
    overflow-y: auto;
  }
}
</style>
