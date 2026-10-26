<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import {
  triggerConfigSchema,
  type Trigger,
  type TriggerConfig,
  type TriggerState,
} from "../../src/contracts.js";
import { client } from "../api.js";
import Field from "../components/Field.vue";
const emit = defineEmits<{ dirty: [value: boolean]; busy: [value: boolean] }>();
const defaults = (): TriggerConfig => ({
  name: "",
  repository: "",
  event: "pull_request.opened",
  workflowRunId: "",
  enabled: false,
  pollSeconds: 60,
  labels: [],
  authors: [],
  includeDrafts: false,
  result: "local",
});
const state = ref<TriggerState>({ triggers: [], jobs: [] });
const runs = ref<Awaited<ReturnType<typeof client.runs>>>([]);
const selected = ref<Trigger>();
const form = ref(defaults());
const labels = ref("");
const authors = ref("");
const number = ref<number>();
const busy = ref(false);
const error = ref("");
const notice = ref("");
const serialized = () =>
  JSON.stringify({
    form: form.value,
    labels: labels.value,
    authors: authors.value,
  });
const saved = ref(serialized());
const dirty = computed(() => serialized() !== saved.value);
const controller = new AbortController();
let timer: ReturnType<typeof setInterval> | undefined;
let loading = false;
watch(dirty, (value) => emit("dirty", value));
watch(busy, (value) => emit("busy", value));
function select(trigger?: Trigger) {
  if (dirty.value && !window.confirm("Discard unsaved trigger changes?"))
    return;
  selected.value = trigger;
  form.value = trigger
    ? triggerConfigSchema.strip().parse(trigger)
    : defaults();
  labels.value = form.value.labels.join(", ");
  authors.value = form.value.authors.join(", ");
  saved.value = serialized();
  number.value = undefined;
  error.value = "";
  notice.value = "";
}
function discard() {
  const value = JSON.parse(saved.value);
  form.value = value.form;
  labels.value = value.labels;
  authors.value = value.authors;
  error.value = "";
}
defineExpose({ discard });
async function load() {
  if (loading) return;
  loading = true;
  try {
    const [updated, available] = await Promise.all([
      client.triggers(controller.signal),
      client.runs(controller.signal),
    ]);
    state.value = updated;
    runs.value = available.filter(
      (run) => !run.deletedAt && ["draft", "completed"].includes(run.status),
    );
  } finally {
    loading = false;
  }
}
async function perform(action: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    busy.value = false;
  }
}
async function save() {
  const config = triggerConfigSchema.parse({
    ...form.value,
    labels: labels.value
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    authors: authors.value
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  });
  const trigger = await client.saveTrigger(
    config,
    selected.value?.id,
    selected.value?.revision,
  );
  selected.value = trigger;
  form.value = triggerConfigSchema.strip().parse(trigger);
  saved.value = serialized();
  await load();
  notice.value = trigger.enabled
    ? "Trigger enabled. Matching events will start this workflow automatically."
    : "Trigger saved and disabled. Test it before enabling.";
}
async function test() {
  if (!selected.value || !number.value) return;
  const job = await client.testTrigger(selected.value.id, number.value);
  await load();
  notice.value =
    job.status === "failed"
      ? (job.error ?? "Test failed")
      : "Test draft created. Open it from the event history to inspect and approve it. Test runs never publish a GitHub result comment.";
}
async function poll() {
  state.value = await client.pollTriggers();
}
async function jobAction(id: string, action: "retry" | "cancel") {
  await client.triggerEventAction(id, action);
  await load();
}
onMounted(() => {
  void perform(load);
  timer = setInterval(() => {
    void load().catch((failure) => {
      if (!controller.signal.aborted) error.value = String(failure);
    });
  }, 5000);
});
onScopeDispose(() => {
  controller.abort();
  clearInterval(timer);
  emit("dirty", false);
  emit("busy", false);
});
</script>

<template>
  <section>
    <div class="settings-section-title">
      <div>
        <h2>GitHub triggers</h2>
        <p>
          Run a saved workflow when new issues or pull requests appear. Workflow
          must remain running; the browser can be closed.
        </p>
      </div>
      <div class="button-row">
        <button :disabled="busy" @click="select()">New trigger</button
        ><button :disabled="busy" @click="perform(poll)">Poll now</button>
      </div>
    </div>
    <p>
      GitHub access uses GH_TOKEN, GITHUB_TOKEN, or your GitHub CLI sign-in.
      Public repositories can be read without signing in.
    </p>
    <div v-if="error || state.error" class="inline-error" role="alert">
      {{ error || state.error }}
    </div>
    <div v-if="notice" class="setup-notice" role="status">{{ notice }}</div>
    <div v-if="state.triggers.length" class="trigger-list">
      <button
        v-for="trigger in state.triggers"
        :key="trigger.id"
        :disabled="busy"
        :aria-pressed="selected?.id === trigger.id"
        @click="select(trigger)"
      >
        <strong>{{ trigger.name }}</strong
        ><span
          >{{ trigger.repository }} ·
          {{ trigger.enabled ? "Enabled" : "Disabled" }}</span
        >
        <small v-if="trigger.error">{{ trigger.error }}</small>
        <small v-else>{{
          trigger.lastPollAt
            ? `Last checked ${new Date(trigger.lastPollAt).toLocaleString()}`
            : "Not checked yet"
        }}</small>
      </button>
    </div>
    <form class="settings-card" @submit.prevent="perform(save)">
      <h3>{{ selected ? "Edit trigger" : "New trigger" }}</h3>
      <fieldset class="settings-fields" :disabled="busy">
        <div class="field-grid">
          <Field v-slot="{ id }" label="Trigger name"
            ><input
              :id="id"
              v-model="form.name"
              required
              placeholder="Review new pull requests"
          /></Field>
          <Field v-slot="{ id }" label="GitHub repository"
            ><input
              :id="id"
              v-model="form.repository"
              required
              placeholder="owner/repository"
          /></Field>
          <Field v-slot="{ id }" label="Event"
            ><select :id="id" v-model="form.event">
              <option value="pull_request.opened">New pull request</option>
              <option value="issue.opened">New issue</option>
            </select></Field
          >
          <Field
            v-slot="{ id }"
            label="Saved workflow"
            help="Captures this workflow's code, blocks, models and settings. Later edits do not change the captured version."
            ><select :id="id" v-model="form.workflowRunId" required>
              <option disabled value="">
                Choose a draft or completed workflow
              </option>
              <option
                v-if="
                  selected &&
                  !runs.some((run) => run.id === selected?.workflowRunId)
                "
                :value="selected.workflowRunId"
              >
                {{ selected.workflowTitle }} (captured)
              </option>
              <option v-for="run in runs" :key="run.id" :value="run.id">
                {{ run.title }} · {{ run.status }} · {{ run.id.slice(0, 8) }}
              </option>
            </select></Field
          >
          <Field
            v-slot="{ id }"
            label="Required labels"
            help="Comma separated. Every label must match when the event is observed."
            ><input
              :id="id"
              v-model="labels"
              placeholder="Optional: workflow, bug"
          /></Field>
          <Field
            v-slot="{ id }"
            label="Allowed authors"
            help="Comma separated GitHub logins. Empty allows every author."
            ><input :id="id" v-model="authors" placeholder="Optional: octocat"
          /></Field>
          <Field v-slot="{ id }" label="Polling interval (seconds)"
            ><input
              :id="id"
              v-model.number="form.pollSeconds"
              type="number"
              min="30"
              max="3600"
              required
          /></Field>
          <Field
            v-slot="{ id }"
            label="Spending limit per run (USD)"
            help="Empty inherits the saved workflow's budget."
            ><input
              :id="id"
              type="number"
              min="0.001"
              step="any"
              :value="form.maxCostUsd ?? ''"
              @input="
                form.maxCostUsd = ($event.target as HTMLInputElement).value
                  ? Number(($event.target as HTMLInputElement).value)
                  : undefined
              "
          /></Field>
          <Field v-slot="{ id }" label="Result destination"
            ><select :id="id" v-model="form.result">
              <option value="local">Workflow results only</option>
              <option value="github-comment">Also post a GitHub comment</option>
            </select></Field
          >
        </div>
        <label v-if="form.event === 'pull_request.opened'" class="toggle-row"
          ><input v-model="form.includeDrafts" type="checkbox" />Include draft
          pull requests</label
        >
        <label class="toggle-row"
          ><input v-model="form.enabled" type="checkbox" />Enable automatic
          execution</label
        >
        <p>
          New triggers watch items created from the time they are saved.
          Disabled triggers pause admission and queued work; enabling catches up
          from the saved checkpoint. Runs execute one at a time in this project.
        </p>
        <div class="button-row">
          <button type="submit" class="primary" :disabled="selected && !dirty">
            Save trigger</button
          ><button v-if="dirty" type="button" @click="discard">
            Discard trigger edits
          </button>
        </div>
      </fieldset>
    </form>
    <div v-if="selected" class="settings-card">
      <h3>Test this trigger</h3>
      <p>
        Choose an existing item to create a draft, without automatic execution
        or a GitHub result comment. Testing bypasses label, author and
        creation-time filters.
      </p>
      <Field v-slot="{ id }" label="Issue or pull request number"
        ><input :id="id" v-model.number="number" type="number" min="1"
      /></Field>
      <button :disabled="busy || dirty || !number" @click="perform(test)">
        Create test draft
      </button>
    </div>
    <div class="settings-section-title">
      <div>
        <h2>Event history</h2>
        <p>
          The latest 100 events, including queued work and test drafts. Open a
          run to inspect its results or resolve an interruption.
        </p>
      </div>
    </div>
    <p v-if="!state.jobs.length">No events yet.</p>
    <article
      v-for="job in state.jobs"
      :key="job.id"
      class="settings-card trigger-job"
    >
      <div class="card-title">
        <strong
          >{{ job.triggerName }} · {{ job.event.repository }}#{{
            job.event.number
          }}</strong
        ><span
          >{{ job.test ? "Test · " : "" }}{{ job.status
          }}{{
            job.runStatus && job.runStatus !== job.status
              ? ` · ${job.runStatus}`
              : ""
          }}</span
        >
      </div>
      <p>{{ job.event.title }}</p>
      <p v-if="job.error" class="inline-error">{{ job.error }}</p>
      <div class="button-row">
        <a
          v-if="job.status !== 'queued' && job.status !== 'failed'"
          :href="`#run=${job.runId}`"
          >Open workflow</a
        ><a :href="job.event.url" target="_blank" rel="noopener noreferrer"
          >View GitHub item</a
        ><a
          v-if="job.resultUrl"
          :href="job.resultUrl"
          target="_blank"
          rel="noopener noreferrer"
          >Published result</a
        >
        <button
          v-if="['failed', 'publishing'].includes(job.status)"
          :disabled="busy"
          @click="perform(() => jobAction(job.id, 'retry'))"
        >
          {{
            job.status === "publishing"
              ? "Check delivery again"
              : "Retry dispatch"
          }}
        </button>
        <button
          v-if="['queued', 'failed'].includes(job.status)"
          :disabled="busy"
          @click="perform(() => jobAction(job.id, 'cancel'))"
        >
          Cancel queued event
        </button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.trigger-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.trigger-list button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  padding: 16px;
  text-align: left;
  overflow-wrap: anywhere;
}
.trigger-list button[aria-pressed="true"] {
  border-color: var(--ctp-blue);
}
.trigger-list span,
.trigger-list small {
  color: var(--ctp-subtext0);
}
.trigger-job .card-title {
  flex-wrap: wrap;
}
.trigger-job p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.toggle-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 16px 0;
}
.toggle-row input {
  width: auto;
}
</style>
