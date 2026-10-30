<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from "vue";
import type { z } from "zod";
import type { Library } from "../../src/contracts.js";
import {
  modelCatalogSchema,
  type AvailableModel,
} from "../../src/contracts.js";
import {
  orchestrationStateSchema,
  type OrchestrationState,
} from "../../src/contracts.js";
import { executionSettingsSchema } from "../../src/contracts.js";
import { type DesignScope } from "../../src/contracts.js";
import { request } from "../api.js";
import Icon from "../components/Icon.vue";
import ModelSettings from "./ModelSettings.vue";
import ModelProfiles from "./ModelProfiles.vue";
import TaskCases from "./TaskCases.vue";
import BlockSettings from "./BlockSettings.vue";
import Capabilities from "./Capabilities.vue";
import ExecutionSettings from "./ExecutionSettings.vue";
import TriggerSettings from "./TriggerSettings.vue";
import MemorySettings from "./MemorySettings.vue";
import UsageSummary from "../components/UsageSummary.vue";
import SetupProgress from "../components/SetupProgress.vue";
import type { SetupJobsController } from "../composables/use-setup-jobs.js";
const props = defineProps<{
  library: Library;
  onSaved: () => Promise<void>;
  designRevision: number;
  applyingDesign: boolean;
  usageRevision: number;
  setupController: SetupJobsController;
  demo: boolean;
}>();
const emit = defineEmits<{
  dirty: [dirty: boolean];
  design: [scope: DesignScope, prompt?: string];
  context: [
    value: {
      section:
        | "providers"
        | "profiles"
        | "cases"
        | "blocks"
        | "capabilities"
        | "execution"
        | "triggers"
        | "memory";
      blockId?: string;
    },
  ];
}>();
const tabs = [
  ["providers", "Providers & models"],
  ["profiles", "Model profiles"],
  ["cases", "Task instructions"],
  ["blocks", "Blocks"],
  ["capabilities", "Skills & MCP"],
  ["execution", "Execution"],
  ["triggers", "Triggers"],
  ["memory", "Memory"],
] as const;
const tab = ref<(typeof tabs)[number][0]>("providers");
const selectedBlock = ref("");
watch(
  [tab, selectedBlock],
  () =>
    emit("context", {
      section: tab.value,
      ...(tab.value === "blocks" && selectedBlock.value
        ? { blockId: selectedBlock.value }
        : {}),
    }),
  { immediate: true },
);
const state = ref<OrchestrationState>();
const saved = ref("");
const models = ref<AvailableModel[]>([]);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const execution = ref<z.infer<typeof executionSettingsSchema>>();
const savedExecution = ref("");
const blockDirty = ref(false);
const modelDirty = ref(false);
const triggerDirty = ref(false);
const memoryDirty = ref(false);
const memoryEditor = ref<InstanceType<typeof MemorySettings>>();
const triggerEditor = ref<InstanceType<typeof TriggerSettings>>();
const blockEditor = ref<InstanceType<typeof BlockSettings>>();
const modelEditor = ref<InstanceType<typeof ModelSettings>>();
const loadedDesignRevision = ref(props.designRevision);
const editorRevision = ref(0);
const staleSettings = ref(false);
let loadSequence = 0;
const controller = new AbortController();
const refreshingDesign = computed(
  () => loadedDesignRevision.value !== props.designRevision,
);
const dirty = computed(
  () => !!state.value && JSON.stringify(state.value.settings) !== saved.value,
);
const executionDirty = computed(
  () =>
    !!execution.value &&
    JSON.stringify(execution.value) !== savedExecution.value,
);
const hasEdits = computed(
  () =>
    dirty.value ||
    executionDirty.value ||
    blockDirty.value ||
    modelDirty.value ||
    triggerDirty.value ||
    memoryDirty.value,
);
function discardSettings() {
  if (busy.value) return;
  if (state.value) state.value.settings = JSON.parse(saved.value);
  if (execution.value) execution.value = JSON.parse(savedExecution.value);
  error.value = "";
  notice.value = "";
}
function discardAll() {
  discardSettings();
  blockEditor.value?.discard();
  modelEditor.value?.discard();
  triggerEditor.value?.discard();
  memoryEditor.value?.discard();
}
async function load() {
  const version = ++loadSequence;
  const revision = props.designRevision;
  try {
    const options = { signal: controller.signal };
    const [loaded, catalog, config] = await Promise.all([
      request("/api/settings/orchestration", orchestrationStateSchema, options),
      request("/api/models", modelCatalogSchema, options),
      request("/api/settings/execution", executionSettingsSchema, options),
    ]);
    if (version !== loadSequence || controller.signal.aborted) {
      return;
    }
    if (hasEdits.value) {
      staleSettings.value = true;
      return;
    }
    state.value = loaded;
    saved.value = JSON.stringify(loaded.settings);
    models.value = catalog.models;
    execution.value = config;
    savedExecution.value = JSON.stringify(config);
    staleSettings.value = false;
    editorRevision.value++;
  } finally {
    if (version === loadSequence) {
      loadedDesignRevision.value = revision;
    }
  }
}
watch(
  () => props.designRevision,
  () => {
    if (hasEdits.value) {
      staleSettings.value = true;
      loadedDesignRevision.value = props.designRevision;
      return;
    }
    void load().catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        error.value = String(failure);
      }
    });
  },
  { immediate: true },
);
watch(
  hasEdits,
  (value) => {
    emit("dirty", value);
    if (
      !value &&
      error.value ===
        "Save or discard your form edits before designing with AI."
    )
      error.value = "";
  },
  { immediate: true },
);
const warn = (event: BeforeUnloadEvent) => {
  if (hasEdits.value) {
    event.preventDefault();
    event.returnValue = "";
  }
};
onMounted(() => window.addEventListener("beforeunload", warn));
onScopeDispose(() => {
  controller.abort();
  window.removeEventListener("beforeunload", warn);
  emit("dirty", false);
});
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
  if (dirty.value && state.value) {
    const updated = await request(
      "/api/settings/orchestration",
      orchestrationStateSchema,
      { method: "PUT", body: state.value },
    );
    state.value = updated;
    saved.value = JSON.stringify(updated.settings);
    await props.onSaved();
    notice.value =
      "Settings saved. New task requests use these instructions and capabilities.";
  }
  if (executionDirty.value && execution.value) {
    const updated = await request(
      "/api/settings/execution",
      executionSettingsSchema,
      { method: "PUT", body: execution.value },
    );
    execution.value = updated;
    savedExecution.value = JSON.stringify(updated);
    await props.onSaved();
    notice.value = "Execution settings saved.";
  }
}
function design(scope: DesignScope, prompt?: string) {
  if (hasEdits.value) {
    error.value = "Save or discard your form edits before designing with AI.";
    return;
  }
  error.value = "";
  emit("design", scope, prompt);
}
function changeTab(id: (typeof tabs)[number][0]) {
  if (
    id !== tab.value &&
    (blockDirty.value ||
      modelDirty.value ||
      triggerDirty.value ||
      memoryDirty.value) &&
    !window.confirm("Discard unsaved changes in this section?")
  ) {
    return;
  }
  tab.value = id;
  notice.value = "";
}
async function providersSaved() {
  models.value = (await request("/api/models", modelCatalogSchema)).models;
  // Provider defaults share config.json with execution settings. Preserve local edits.
  if (!executionDirty.value) {
    const config = await request(
      "/api/settings/execution",
      executionSettingsSchema,
    );
    execution.value = config;
    savedExecution.value = JSON.stringify(config);
  }
  await props.onSaved();
  await props.setupController.refresh();
}
async function reload() {
  if (
    !hasEdits.value ||
    window.confirm("Discard unsaved settings and reload?")
  ) {
    discardAll();
    await nextTick();
    void perform(load);
  }
}
</script>

<template>
  <div class="settings-page">
    <div class="page-heading">
      <span class="eyebrow">WORKSPACE</span>
      <h1>Settings</h1>
      <p>
        Shape how your orchestrator plans, chooses models, and executes work.
      </p>
    </div>
    <UsageSummary scope="project" :revision="usageRevision" active />
    <nav class="settings-tabs" aria-label="Settings sections">
      <button
        v-for="[id, label] in tabs"
        :key="id"
        :aria-current="tab === id ? 'page' : undefined"
        :disabled="busy || applyingDesign || refreshingDesign"
        @click="changeTab(id)"
      >
        {{ label }}
      </button>
    </nav>
    <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
    <div v-if="notice" class="setup-notice" role="status">{{ notice }}</div>
    <div v-if="staleSettings" class="setup-notice" role="status">
      Project settings changed while you were editing. Your unsaved edits are
      preserved.
      <button :disabled="busy || applyingDesign" @click="reload">
        Reload saved settings
      </button>
    </div>
    <div v-if="hasEdits" class="unsaved-bar" role="status">
      <span><Icon name="file" :size="15" />You have unsaved edits.</span>
      <button :disabled="busy || applyingDesign" @click="discardAll">
        Discard all edits
      </button>
    </div>
    <MemorySettings
      v-if="tab === 'memory'"
      ref="memoryEditor"
      @dirty="memoryDirty = $event"
      @busy="busy = $event"
    />
    <p v-else-if="!state" role="status">Loading settings…</p>
    <fieldset
      v-else
      class="settings-fields"
      :disabled="
        applyingDesign || refreshingDesign || (busy && tab !== 'providers')
      "
    >
      <ModelSettings
        v-if="tab === 'providers'"
        :key="editorRevision"
        ref="modelEditor"
        :on-saved="providersSaved"
        @busy="busy = $event"
        @dirty="modelDirty = $event"
      />
      <SetupProgress
        v-if="tab === 'providers'"
        :controller="setupController"
        :blocked="hasEdits || busy || applyingDesign"
        :default-limit="execution?.budget?.maxSetupCostUsd"
        :demo="demo"
      />
      <ModelProfiles
        v-if="tab === 'profiles'"
        v-model="state.settings"
        :models="models"
        :busy="busy"
        @generate="design('profiles', $event)"
      />
      <TaskCases v-if="tab === 'cases'" v-model="state.settings" />
      <BlockSettings
        v-if="tab === 'blocks'"
        ref="blockEditor"
        :key="editorRevision"
        :library="library"
        :settings="state.settings"
        :on-saved="onSaved"
        @dirty="blockDirty = $event"
        @busy="busy = $event"
        @selected="selectedBlock = $event"
      />
      <Capabilities
        v-if="tab === 'capabilities'"
        v-model="state.settings.capabilities"
        :project-capabilities="state.projectCapabilities"
      />
      <ExecutionSettings
        v-if="tab === 'execution' && execution"
        v-model="execution"
        v-model:approval="state.settings.approval"
      />
      <TriggerSettings
        v-if="tab === 'triggers'"
        ref="triggerEditor"
        @dirty="triggerDirty = $event"
        @busy="busy = $event"
      />
      <div
        v-if="!['providers', 'blocks', 'triggers'].includes(tab)"
        class="settings-save"
      >
        <span>{{
          dirty || executionDirty ? "Unsaved changes" : "All changes saved"
        }}</span
        ><button :disabled="busy" @click="reload">Reload settings</button
        ><button
          v-if="dirty || executionDirty"
          :disabled="busy"
          @click="discardSettings"
        >
          Discard settings changes</button
        ><button
          class="primary"
          :disabled="busy || (!dirty && !executionDirty)"
          @click="perform(save)"
        >
          {{ busy ? "Saving…" : "Save settings" }}
        </button>
      </div>
    </fieldset>
  </div>
</template>
