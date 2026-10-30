<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { resolveAgentSettings } from "../../../src/contracts/index.js";
import type { SetupJobsController } from "./use-setup-jobs.js";
import { setupActive, setupStageLabels, setupStatusLabels } from "./setup-presentation.js";
import Icon from "../../shared/Icon.vue";
import UsageSummary from "../usage/UsageSummary.vue";

const props = withDefaults(
  defineProps<{
    controller: SetupJobsController;
    compact?: boolean;
    blocked?: boolean;
    defaultLimit?: number;
    demo?: boolean;
  }>(),
  { compact: false, blocked: false, demo: false },
);
const emit = defineEmits<{ settings: [] }>();
const state = props.controller.state;
const job = computed(() => state.job);
const active = computed(() => setupActive(job.value));
const completed = computed(() => state.setup?.completedSetup);
const agent = computed(
  () => state.setup && resolveAgentSettings(state.setup.userAgent, state.setup.projectAgent),
);
const hasDefault = computed(() => !!(agent.value?.provider && agent.value.model));
const connected = computed(
  () =>
    !!agent.value?.provider &&
    !!state.setup?.providers.some((provider) => provider.id === agent.value?.provider),
);
const resumeConnected = computed(
  () =>
    !!job.value &&
    !!state.setup?.providers.some((provider) => provider.id === job.value?.model.provider),
);
const needsModelToResume = computed(
  () =>
    !!job.value?.stages.some(
      (stage) => ["profiles", "cases", "blocks"].includes(stage.id) && stage.status !== "completed",
    ),
);
const instructions = ref("");
const showForm = ref(false);
const copied = ref(false);
const resumeLimit = ref("");
const validResumeLimit = computed(
  () =>
    !resumeLimit.value ||
    (Number.isFinite(Number(resumeLimit.value)) &&
      Number(resumeLimit.value) > 0 &&
      Number(resumeLimit.value) >= (job.value?.maxSetupCostUsd ?? 0)),
);
const needsAttention = computed(
  () =>
    !!job.value && ["failed", "interrupted", "cancelled", "conflicted"].includes(job.value.status),
);
const showInitialForm = computed(() => !job.value && !completed.value);
watch(
  () => job.value?.id,
  () => {
    showForm.value = false;
    copied.value = false;
    resumeLimit.value = "";
  },
);
function newSetup() {
  instructions.value = job.value?.instructions ?? "";
  showForm.value = true;
}
async function start() {
  await props.controller.start({
    instructions: instructions.value,
    regenerate: !!(completed.value || job.value),
  });
  if (!state.error) showForm.value = false;
}
async function copyId() {
  if (!job.value) return;
  try {
    await navigator.clipboard.writeText(job.value.id);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}
async function resume() {
  if (needsModelToResume.value && !validResumeLimit.value) return;
  await props.controller.resume(
    needsModelToResume.value && resumeLimit.value ? Number(resumeLimit.value) : undefined,
  );
  if (!state.error) resumeLimit.value = "";
}
function date(value: string) {
  return new Date(value).toLocaleString();
}
</script>

<template>
  <section
    v-if="!demo || job || !compact"
    class="setup-progress"
    :class="{ compact }"
    aria-label="Project setup"
  >
    <div class="setup-progress-heading">
      <Icon name="workflow" :size="compact ? 19 : 23" />
      <div>
        <strong>{{
          job
            ? setupStatusLabels[job.status]
            : completed
              ? "Project setup saved"
              : "Set up this project"
        }}</strong>
        <p v-if="compact">
          {{
            active && job
              ? setupStageLabels[job.stage]
              : hasDefault
                ? `Default model: ${agent?.model}`
                : "Connect a provider, save a default model, then generate your reusable library."
          }}
        </p>
      </div>
      <button v-if="compact" class="quiet" @click="emit('settings')">
        {{ job ? "View setup" : "Configure" }}
      </button>
      <button
        v-else
        class="quiet"
        :disabled="state.loading || state.pending"
        @click="controller.refresh"
      >
        Refresh setup
      </button>
    </div>
    <template v-if="compact">
      <p v-if="completed && job?.status !== 'completed'" class="setup-saved-note">
        Your previous saved setup remains available.
      </p>
      <p v-else-if="completed?.counts" class="setup-saved-note">
        {{ completed.counts.profiles }} model roles · {{ completed.counts.cases }} task presets ·
        {{ completed.counts.blocks }} blocks
      </p>
      <p v-else-if="!completed && !active" class="setup-saved-note">
        {{
          hasDefault && connected
            ? "Generate project-specific roles, task instructions and blocks in Settings."
            : "Save a default model from a connected provider in Settings."
        }}
      </p>
    </template>
    <template v-else>
      <p class="setup-description">
        Your saved default model inspects this project and creates reusable model roles, task
        instructions and TypeScript blocks. Project settings update together after validation. You
        can follow the same setup in the browser and terminal.
      </p>
      <p v-if="demo" class="setup-readiness">
        Project setup requires a live project host. Demo mode does not generate or apply AI setup.
      </p>
      <div v-if="completed" class="setup-saved-note" aria-label="Last successful setup">
        <Icon name="check" :size="15" /><span
          >Last saved {{ date(completed.completedAt)
          }}<template v-if="completed.counts">
            · {{ completed.counts.profiles }} model roles · {{ completed.counts.cases }} task
            presets · {{ completed.counts.blocks }} blocks</template
          >.<template v-if="job && job.status !== 'completed'">
            This saved setup remains available while the new setup is unfinished.</template
          ></span
        >
      </div>
      <p v-if="!hasDefault || !connected" class="setup-readiness" role="status">
        {{
          !hasDefault
            ? "Save a default model above before starting setup."
            : `Connect ${agent?.provider} or save a model from a connected provider before starting a new setup.`
        }}
      </p>
      <p v-if="blocked" class="setup-readiness" role="status">
        Save or discard your settings edits before starting or resuming setup.
      </p>
      <details v-if="job" class="setup-job-details" :open="active || needsAttention">
        <summary>
          {{ setupStatusLabels[job.status] }} ·
          {{ job.stages.filter((stage) => stage.status === "completed").length }}/{{
            job.stages.length
          }}
          stages complete
        </summary>
        <div class="setup-job-identity">
          <span
            >Setup ID <code>{{ job.id }}</code></span
          ><button class="quiet" @click="copyId">
            {{ copied ? "Copied" : "Copy setup ID" }}
          </button>
        </div>
        <p class="setup-model">
          {{ job.model.provider }}/{{ job.model.model }} · {{ job.model.thinking }} thinking
        </p>
        <ol class="setup-stage-list" aria-label="Setup stages">
          <li v-for="stage in job.stages" :key="stage.id" :class="stage.status">
            <span class="setup-stage-icon"
              ><Icon v-if="stage.status === 'completed'" name="check" :size="15" /><span
                v-else-if="stage.status === 'running' && active"
                class="spinner" /><Icon
                v-else-if="['failed', 'interrupted'].includes(stage.status)"
                name="alert"
                :size="15" /><span v-else class="setup-stage-dot"
            /></span>
            <div>
              <strong>{{ setupStageLabels[stage.id] }}</strong
              ><small
                >{{
                  stage.status === "completed"
                    ? stage.id === "applying"
                      ? "Saved"
                      : "Ready"
                    : stage.status === "pending"
                      ? "Waiting"
                      : stage.status === "running"
                        ? "In progress"
                        : stage.status === "interrupted"
                          ? "Interrupted"
                          : "Needs attention"
                }}<template v-if="stage.attempt > 1">
                  · attempt {{ stage.attempt }}</template
                ></small
              >
              <p v-if="stage.summary">{{ stage.summary }}</p>
              <p v-if="stage.error" class="setup-job-error">
                {{ stage.error }}
              </p>
            </div>
          </li>
        </ol>
        <p v-if="job.activity && active" class="setup-activity" role="status">
          {{ job.activity }}
        </p>
        <div v-if="job.error || job.conflict" class="setup-job-error" role="status">
          <p>{{ job.conflict?.message ?? job.error }}</p>
          <ul v-if="job.conflict?.paths?.length">
            <li v-for="path in job.conflict.paths" :key="path">
              <code>{{ path }}</code>
            </li>
          </ul>
        </div>
        <p v-if="job.conflict?.requiresRegeneration">
          Settings changed after this setup began. Start a new setup to use the current project
          settings.
        </p>
        <p v-else-if="job.actions.canResume">
          {{
            needsModelToResume
              ? "Completed stages are retained. Resume retries the unfinished stage with the same model and spending limit."
              : "Completed generation is retained. Resume finishes validation and saving without new model calls."
          }}
        </p>
        <p
          v-if="job.actions.canResume && needsModelToResume && !resumeConnected"
          class="setup-readiness"
        >
          Connect {{ job.model.provider }} to resume this setup.
        </p>
        <div
          v-if="job.actions.canResume && needsModelToResume && job.maxSetupCostUsd !== undefined"
          class="setup-resume-limit"
        >
          <label for="setup-resume-limit">Increase setup limit (USD) <span>optional</span></label>
          <input
            id="setup-resume-limit"
            v-model="resumeLimit"
            type="number"
            :min="job.maxSetupCostUsd"
            step="any"
            :placeholder="String(job.maxSetupCostUsd)"
            :disabled="state.pending || blocked || demo"
          />
          <small
            >Leave blank to keep ${{ job.maxSetupCostUsd }}. A higher limit keeps the same setup and
            its completed stages.</small
          >
          <p v-if="!validResumeLimit" class="setup-job-error">
            Enter a limit of at least ${{ job.maxSetupCostUsd }}.
          </p>
        </div>
        <div class="setup-job-actions">
          <button
            v-if="job.actions.canResume"
            class="primary"
            :disabled="
              state.pending ||
              blocked ||
              (needsModelToResume && !resumeConnected) ||
              demo ||
              (needsModelToResume && !validResumeLimit)
            "
            @click="resume"
          >
            Resume setup
          </button>
          <button v-if="job.actions.canCancel" :disabled="state.pending" @click="controller.cancel">
            Cancel setup
          </button>
          <span v-if="active">{{
            job.stage === "applying" && !job.actions.canCancel
              ? "Finishing the saved setup. This stage cannot be cancelled."
              : "You can leave this screen. The project host saves progress."
          }}</span>
        </div>
        <UsageSummary scope="setup" :scope-id="job.id" :revision="job.revision" :active="active" />
      </details>
      <button
        v-if="!active && !showInitialForm && !showForm"
        class="quiet setup-restart"
        :disabled="state.pending || blocked || !hasDefault || !connected || demo"
        @click="newSetup"
      >
        {{ completed ? "Regenerate project setup" : "Start a new setup" }}
      </button>
      <form
        v-if="(showInitialForm || showForm) && !active"
        class="setup-start-form"
        @submit.prevent="start"
      >
        <label for="setup-preferences">Setup preferences <span>optional</span></label>
        <textarea
          id="setup-preferences"
          v-model="instructions"
          v-autosize
          :rows="2"
          maxlength="8000"
          placeholder="For example: prioritize low cost, keep publication manual, use the existing test commands…"
          :disabled="state.pending || blocked"
        />
        <p>
          Uses
          {{ hasDefault ? `${agent?.provider}/${agent?.model}` : "your saved default model" }}.
          <template v-if="defaultLimit !== undefined"
            >Setup spending limit: ${{ defaultLimit }}.</template
          ><template v-else>No setup spending limit is configured.</template>
          Set a limit in Execution settings.
        </p>
        <div>
          <button
            class="primary"
            :disabled="state.pending || blocked || !hasDefault || !connected || demo"
          >
            {{
              state.pending
                ? "Starting…"
                : completed
                  ? "Regenerate setup"
                  : "Generate project setup"
            }}</button
          ><button
            v-if="showForm"
            type="button"
            class="quiet"
            :disabled="state.pending"
            @click="showForm = false"
          >
            Keep current setup
          </button>
        </div>
      </form>
    </template>
    <p v-if="state.error" class="setup-job-error" role="status">
      Could not update setup: {{ state.error }}
    </p>
    <p v-else-if="!state.setup" class="setup-loading" role="status">Loading saved setup…</p>
  </section>
</template>

<style scoped>
.setup-progress {
  border: 1px solid var(--ui-edge);
  border-radius: var(--ui-card-radius);
  background: var(--ui-raised);
  padding: 20px;
  margin: 24px 0;
  min-width: 0;
}
.setup-progress-heading {
  display: flex;
  align-items: center;
  gap: 12px;
}
.setup-progress-heading > svg {
  flex-shrink: 0;
  color: var(--accent);
}
.setup-progress-heading > div {
  flex: 1;
  min-width: 0;
}
.setup-progress-heading strong {
  font-size: 14px;
  font-weight: 600;
}
.setup-progress-heading p {
  font-size: 11px;
  margin: 4px 0 0;
}
.setup-description {
  margin: 14px 0;
  font-size: 12px;
}
.setup-saved-note {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--ctp-green);
  font-size: 11px;
  line-height: 1.7;
  margin: 12px 0;
}
.setup-saved-note svg {
  flex-shrink: 0;
}
.setup-readiness {
  font-size: 12px;
  color: var(--ctp-yellow);
  margin: 12px 0;
}
.setup-job-details {
  border-top: 1px solid var(--ui-edge);
  padding-top: 14px;
  margin-top: 16px;
}
.setup-job-details > summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}
.setup-job-identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  margin-top: 16px;
  font-size: 11px;
  color: var(--muted);
}
.setup-job-identity code {
  user-select: all;
  overflow-wrap: anywhere;
  color: var(--ctp-text);
  margin-left: 5px;
}
.setup-job-identity button {
  font-size: 10px;
  padding: 5px;
}
.setup-model {
  font-size: 11px;
  margin: 5px 0 16px;
  overflow-wrap: anywhere;
}
.setup-stage-list {
  list-style: none;
  padding: 0;
  margin: 16px 0;
  display: grid;
  gap: 12px;
}
.setup-stage-list li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.setup-stage-icon {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ui-edge);
  border-radius: 50%;
  flex-shrink: 0;
}
.setup-stage-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--muted);
}
.setup-stage-list .completed .setup-stage-icon {
  color: var(--ctp-green);
  background: color-mix(in srgb, var(--ctp-green) 8%, transparent);
}
.setup-stage-list .running .setup-stage-icon {
  color: var(--accent);
}
.setup-stage-list .failed .setup-stage-icon,
.setup-stage-list .interrupted .setup-stage-icon {
  color: var(--ctp-yellow);
}
.setup-stage-list strong {
  display: inline;
  font-size: 12px;
  font-weight: 500;
}
.setup-stage-list small {
  display: inline;
  margin-left: 10px;
  font-size: 10px;
  color: var(--muted);
}
.setup-stage-list p {
  margin: 3px 0 0;
  font-size: 11px;
}
.setup-activity {
  font-size: 12px;
  border-left: 2px solid var(--accent);
  padding-left: 12px;
}
.setup-job-error {
  color: var(--ctp-peach);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.setup-job-error p {
  color: inherit;
}
.setup-job-details > p {
  font-size: 12px;
}
.setup-job-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 16px 0;
}
.setup-job-actions > span {
  font-size: 11px;
  color: var(--muted);
  flex: 1;
  min-width: 180px;
}
.setup-start-form {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--ui-edge);
}
.setup-start-form label {
  display: block;
  font-size: 12px;
  margin-bottom: 8px;
}
.setup-start-form label span {
  color: var(--muted);
  font-size: 11px;
}
.setup-start-form p {
  font-size: 11px;
  margin: 10px 0;
}
.setup-start-form > div {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.setup-resume-limit {
  max-width: 420px;
  margin-top: 14px;
}
.setup-resume-limit label {
  display: block;
  font-size: 12px;
  margin-bottom: 7px;
}
.setup-resume-limit label span,
.setup-resume-limit small {
  color: var(--muted);
  font-size: 11px;
}
.setup-resume-limit small {
  display: block;
  margin-top: 7px;
  line-height: 1.7;
}
.setup-restart {
  margin-top: 12px;
}
.setup-loading {
  font-size: 12px;
  margin: 12px 0 0;
}
.compact {
  padding: 16px;
  margin: 0 0 20px;
  text-align: left;
}
.compact .setup-saved-note {
  margin-bottom: 0;
}
@media (max-width: 600px) {
  .setup-progress {
    padding: 16px;
  }
  .setup-progress-heading {
    gap: 8px;
    flex-wrap: wrap;
  }
  .setup-progress-heading strong {
    font-size: 13px;
  }
  .setup-stage-list small {
    display: block;
    margin-left: 0;
    margin-top: 2px;
  }
  .setup-job-identity code {
    display: block;
    margin-left: 0;
  }
}
</style>
