<script setup lang="ts">
import {
  computed,
  onMounted,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
} from "vue";
import { z } from "zod";
import { resolveAgentSettings, type AgentSettings } from "../../src/contracts.js";
import {
  modelCatalogSchema,
  modelKey,
  type AvailableModel,
} from "../../src/contracts.js";
import { setupSchema, type Setup } from "../../src/contracts.js";
import { request } from "../api.js";
import { inputValue } from "../form-events.js";
import ProviderLogin from "./ProviderLogin.vue";
const props = defineProps<{ onSaved: () => Promise<void> }>();
const emit = defineEmits<{ busy: [value: boolean]; dirty: [value: boolean] }>();
const setup = shallowRef<Setup>();
const models = shallowRef<AvailableModel[]>([]);
const warnings = ref<string[]>([]);
const selection = ref("");
const thinking = ref<AgentSettings["thinking"]>("medium");
const busy = ref(false);
const error = ref("");
const notice = ref("");
const controller = new AbortController();
const dirty = computed(() => {
  if (!setup.value) return false;
  const saved = resolveAgentSettings(
    setup.value.userAgent,
    setup.value.projectAgent,
  );
  const key =
    saved.provider && saved.model
      ? modelKey({ provider: saved.provider, id: saved.model })
      : "";
  return selection.value !== key || thinking.value !== saved.thinking;
});
watch(dirty, (value) => emit("dirty", value), { immediate: true });
function acceptSetup(value: Setup, preserveEdits = false) {
  const keep = preserveEdits && dirty.value;
  setup.value = value;
  if (keep) return;
  const agent = resolveAgentSettings(value.userAgent, value.projectAgent);
  selection.value =
    agent.provider && agent.model
      ? modelKey({ provider: agent.provider, id: agent.model })
      : "";
  thinking.value = agent.thinking;
}
function discard() {
  if (busy.value || !setup.value) return;
  acceptSetup(setup.value);
  error.value = "";
  notice.value = "";
}
defineExpose({ discard });
onMounted(() => {
  void Promise.all([
    request("/api/setup", setupSchema, { signal: controller.signal }),
    request("/api/models", modelCatalogSchema, { signal: controller.signal }),
  ])
    .then(([value, catalog]) => {
      acceptSetup(value);
      models.value = catalog.models;
      warnings.value = catalog.warnings;
    })
    .catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        error.value = String(failure);
      }
    });
});
onScopeDispose(() => {
  controller.abort();
  emit("busy", false);
  emit("dirty", false);
});
async function perform(action: () => Promise<void>) {
  busy.value = true;
  emit("busy", true);
  error.value = "";
  notice.value = "";
  try {
    await action();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    busy.value = false;
    emit("busy", false);
  }
}
const model = computed(() =>
  models.value.find((item) => modelKey(item) === selection.value),
);
async function save(inherit: boolean) {
  if (!setup.value || (!inherit && !model.value)) {
    return;
  }
  const updated = await request("/api/project/model", setupSchema, {
    method: "PUT",
    body: {
      configRevision: setup.value.configRevision,
      agent: inherit
        ? null
        : {
            provider: model.value!.provider,
            model: model.value!.id,
            thinking: thinking.value,
          },
    },
  });
  acceptSetup(updated);
  await props.onSaved();
  notice.value =
    "Project defaults saved. New workflow proposals will use these settings; existing drafts and runs keep their saved models.";
}
async function refresh() {
  const catalog = await request("/api/models/refresh", modelCatalogSchema, {
    method: "POST",
    body: {},
  });
  models.value = catalog.models;
  warnings.value = catalog.warnings;
  acceptSetup(await request("/api/setup", setupSchema), true);
  await props.onSaved();
}
function disconnect(provider: Setup["providers"][number]) {
  if (
    !window.confirm(
      `Remove saved credentials for ${provider.name}? Existing runs using this provider may need you to sign in again.`,
    )
  ) {
    return;
  }
  void perform(async () => {
    await request(
      `/api/auth/providers/${encodeURIComponent(provider.id)}/logout`,
      z.object({ removed: z.boolean() }),
      { method: "POST", body: {} },
    );
    acceptSetup(await request("/api/setup", setupSchema), true);
    const catalog = await request("/api/models", modelCatalogSchema);
    models.value = catalog.models;
    warnings.value = catalog.warnings;
    await props.onSaved();
    notice.value =
      "Saved credentials removed. Provider-side access has not been revoked.";
  });
}
function choose(value: string) {
  selection.value = value;
  const selected = model.value;
  if (selected && !selected.thinkingLevels.includes(thinking.value)) {
    thinking.value = (
      selected.thinkingLevels.includes("off")
        ? "off"
        : (selected.thinkingLevels[0] ?? "off")
    ) as AgentSettings["thinking"];
  }
}
</script>

<template>
  <section class="model-settings" aria-labelledby="setup-title">
    <div class="eyebrow">PROJECT SETUP</div>
    <h1 id="setup-title">Providers & models</h1>
    <p>
      Start with ChatGPT, or connect another provider using an API key. Choose a
      default model for new workflows below.
    </p>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div v-if="notice" class="setup-notice" role="status">{{ notice }}</div>
    <div class="setup-grid">
      <section class="setup-card">
        <h2>Provider connections</h2>
        <ProviderLogin
          :loading="!setup"
          :chatgpt-connected="
            !!setup?.providers.some(
              (provider) =>
                provider.id === 'openai' && provider.method === 'oauth',
            )
          "
          :on-connected="() => perform(refresh)"
        />
        <p v-if="!setup" role="status">Loading provider status…</p>
        <ul v-else-if="setup.providers.length" class="provider-list">
          <li v-for="provider in setup.providers" :key="provider.id">
            <strong>{{ provider.name }}</strong
            ><span
              >{{ provider.method === "oauth" ? "Account sign-in" : "API key" }}
              ·
              {{
                provider.source === "stored"
                  ? "saved credentials"
                  : provider.source
              }}</span
            ><button
              v-if="provider.source === 'stored'"
              :disabled="busy"
              @click="disconnect(provider)"
            >
              Disconnect {{ provider.name }}
            </button>
          </li>
        </ul>
        <p v-else class="muted">No providers are configured yet.</p>
        <small
          >Credentials stay in Workflow's private local store. Status reflects
          configured credentials; model access is checked when a request
          runs.</small
        >
        <button
          :disabled="busy"
          @click="
            perform(async () => {
              await refresh();
              notice = 'Provider status and available models refreshed.';
            })
          "
        >
          {{ busy ? "Working…" : "Refresh connections & models" }}
        </button>
        <p v-for="warning in warnings" :key="warning" class="warning">
          {{ warning }}
        </p>
      </section>
      <section class="setup-card">
        <h2>Default for this project</h2>
        <label for="project-model">Model</label>
        <select
          id="project-model"
          :disabled="busy || !setup"
          :value="selection"
          @change="choose(inputValue($event))"
        >
          <option value="">Choose an available model</option>
          <option v-if="selection && !model" :value="selection">
            {{ selection }} · unavailable
          </option>
          <option
            v-for="item in models"
            :key="modelKey(item)"
            :value="modelKey(item)"
          >
            {{ item.name }} · {{ modelKey(item) }}
          </option>
        </select>
        <label for="project-thinking">Thinking level</label
        ><select
          id="project-thinking"
          v-model="thinking"
          :disabled="busy || !model"
        >
          <option
            v-if="!model?.thinkingLevels.includes(thinking)"
            :value="thinking"
          >
            {{ thinking }}{{ model ? " · unsupported" : "" }}
          </option>
          <option
            v-for="level in model?.thinkingLevels"
            :key="level"
            :value="level"
          >
            {{ level }}
          </option>
        </select>
        <p v-if="model" class="model-caption">
          {{ model.contextWindow.toLocaleString() }} token context ·
          {{
            model.cost
              ? `$${model.cost.input} input / $${model.cost.output} output per million tokens`
              : "Pricing unavailable"
          }}
        </p>
        <button
          class="primary"
          :disabled="busy || !model || !model.thinkingLevels.includes(thinking)"
          @click="perform(() => save(false))"
        >
          Save project model</button
        ><button :disabled="busy || !setup" @click="perform(() => save(true))">
          Use shared defaults
        </button>
        <button v-if="dirty" :disabled="busy" @click="discard">
          Discard model changes
        </button>
        <details class="shared-defaults">
          <summary>Shared defaults across projects</summary>
          <p class="muted">
            {{
              setup?.userAgent.provider && setup.userAgent.model
                ? `${setup.userAgent.provider}/${setup.userAgent.model}`
                : "No shared model selected"
            }}. Optional terminal command: <code>workflow model</code>.
          </p>
        </details>
        <small
          >These controls update this project's model and thinking overrides.
          Execution limits and existing run snapshots are preserved.</small
        >
      </section>
    </div>
  </section>
</template>
