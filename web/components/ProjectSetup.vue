<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import {
  resolveAgentSettings,
  setupSchema,
  orchestrationStateSchema,
} from "../../src/contracts.js";
import type { Setup } from "../../src/contracts.js";
import { request } from "../api.js";
import Icon from "./Icon.vue";
const props = defineProps<{
  revision?: string;
  blocks: number;
  demo: boolean;
}>();
const emit = defineEmits<{ settings: []; generate: [] }>();
const setup = ref<Setup>();
const profileCount = ref(0);
const error = ref("");
const controller = new AbortController();
let version = 0;
watch(
  () => props.revision,
  async () => {
    const current = ++version;
    try {
      const [value, orchestration] = await Promise.all([
        request("/api/setup", setupSchema, { signal: controller.signal }),
        request("/api/settings/orchestration", orchestrationStateSchema, {
          signal: controller.signal,
        }),
      ]);
      if (current !== version || controller.signal.aborted) return;
      setup.value = value;
      profileCount.value = orchestration.settings.profiles.length;
      error.value = "";
    } catch (failure) {
      if (!controller.signal.aborted)
        error.value =
          failure instanceof Error ? failure.message : String(failure);
    }
  },
  { immediate: true },
);
onScopeDispose(() => controller.abort());
const agent = computed(() =>
  setup.value
    ? resolveAgentSettings(setup.value.userAgent, setup.value.projectAgent)
    : undefined,
);
const connected = computed(() => !!setup.value?.providers.length);
const hasDefault = computed(
  () => !!(agent.value?.provider && agent.value?.model),
);
const ready = computed(
  () => connected.value && hasDefault.value && profileCount.value > 0,
);
</script>

<template>
  <section
    v-if="setup && !demo"
    class="project-setup"
    :class="{ ready }"
    aria-label="Project setup"
  >
    <template v-if="ready">
      <div class="setup-ready-model">
        <Icon name="spark" :size="16" /><span
          >Default model <strong>{{ agent?.model }}</strong></span
        >
      </div>
      <span class="setup-library-count"
        >{{ profileCount }} model profiles · {{ blocks }} blocks</span
      >
      <button class="quiet" @click="emit('settings')">Configure</button>
    </template>
    <template v-else>
      <div class="project-setup-heading">
        <strong>Make this project yours</strong
        ><span>Set up once, work from either interface.</span>
      </div>
      <div class="setup-steps">
        <button :class="{ complete: connected }" @click="emit('settings')">
          <span class="setup-step-number"
            ><Icon v-if="connected" name="check" :size="14" /><template v-else
              >1</template
            ></span
          ><span
            ><strong>Connect a provider</strong
            ><small>{{
              connected
                ? "Shared across your projects"
                : "Sign in once on this machine"
            }}</small></span
          >
        </button>
        <button :class="{ complete: hasDefault }" @click="emit('settings')">
          <span class="setup-step-number"
            ><Icon v-if="hasDefault" name="check" :size="14" /><template v-else
              >2</template
            ></span
          ><span
            ><strong>Choose a default</strong
            ><small>{{
              hasDefault ? agent?.model : "Your model plans the work"
            }}</small></span
          >
        </button>
        <button :disabled="!connected || !hasDefault" @click="emit('generate')">
          <span class="setup-step-number">3</span
          ><span
            ><strong>Design your library</strong
            ><small>Review one section at a time</small></span
          >
        </button>
      </div>
    </template>
  </section>
  <div v-else-if="error && !demo" class="inline-error" role="alert">
    Could not load project setup: {{ error }}
  </div>
</template>
