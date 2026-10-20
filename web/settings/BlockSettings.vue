<script setup lang="ts">
import {
  computed,
  onMounted,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
  toRaw,
} from "vue";
import { z } from "zod";
import {
  bundleSchema,
  identifierSchema,
  type BlockBundle,
  type Library,
} from "../../src/domain.js";
import { libraryProposalSchema } from "../../src/library-editor-schema.js";
import type { OrchestrationSettings } from "../../src/orchestration-schema.js";
import { request } from "../api.js";
import { inputValue, inputChecked } from "../form-events.js";
import Field from "../components/Field.vue";
import Icon from "../components/Icon.vue";
const props = defineProps<{
  library: Library;
  settings: OrchestrationSettings;
  onSaved: () => Promise<void>;
}>();
const emit = defineEmits<{
  dirty: [value: boolean];
  busy: [value: boolean];
  design: [];
}>();
const libraryStateSchema = z.object({
  revision: z.string(),
  blocks: z.record(identifierSchema, bundleSchema),
});
const state = shallowRef<z.infer<typeof libraryStateSchema>>();
const selected = ref("");
const bundle = ref<BlockBundle>();
const busy = ref(false);
const error = ref("");
const notice = ref("");
const controller = new AbortController();
async function load() {
  const value = await request("/api/library", libraryStateSchema, {
    signal: controller.signal,
  });
  state.value = value;
  return value;
}
onMounted(() => {
  void load().catch((failure: unknown) => {
    if (!controller.signal.aborted) {
      error.value = String(failure);
    }
  });
});
const dirty = computed(
  () =>
    !!bundle.value &&
    JSON.stringify(bundle.value) !==
      JSON.stringify(state.value?.blocks[selected.value]),
);
watch(dirty, (value) => emit("dirty", value), { immediate: true });
onScopeDispose(() => {
  controller.abort();
  emit("dirty", false);
});
function canSwitch() {
  return !dirty.value || window.confirm("Discard unsaved block changes?");
}
function discard() {
  if (busy.value) return;
  bundle.value = state.value?.blocks[selected.value]
    ? structuredClone(toRaw(state.value.blocks[selected.value]))
    : undefined;
  if (!bundle.value) selected.value = "";
  error.value = "";
  notice.value = "";
}
defineExpose({ discard });
function choose(id: string) {
  if (!canSwitch()) {
    return;
  }
  selected.value = id;
  bundle.value = state.value?.blocks[id]
    ? structuredClone(state.value.blocks[id])
    : undefined;
  notice.value = "";
}
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
const definition = computed(() => bundle.value?.definition);
const selectedProfile = computed(() => {
  const agent = definition.value?.agent;
  return (
    props.settings.profiles.find(
      ({ agent: candidate }) =>
        candidate.provider === agent?.provider &&
        candidate.model === agent?.model &&
        candidate.thinking === agent?.thinking,
    )?.id ?? ""
  );
});
function selectProfile(id: string) {
  if (!definition.value) {
    return;
  }
  const {
    provider: _provider,
    model: _model,
    thinking: _thinking,
    ...limits
  } = definition.value.agent ?? {};
  const profile = props.settings.profiles.find(
    (candidate) => candidate.id === id,
  );
  const agent = { ...limits, ...profile?.agent };
  definition.value.agent = Object.keys(agent).length ? agent : undefined;
}
function add() {
  if (!canSwitch()) {
    return;
  }
  const id = `block-${crypto.randomUUID().slice(0, 8)}`;
  selected.value = id;
  bundle.value = {
    definition: {
      id,
      name: "New block",
      description: "Describe when this block should be used",
      skills: [],
      outputs: [],
      checks: [],
    },
    prompt: "Describe the work, acceptance criteria, and artifacts to publish.",
    skills: [],
  };
}
function execution(value: string) {
  if (definition.value) {
    definition.value.executor =
      value === "command"
        ? {
            kind: "command",
            command: Object.keys(props.library.config.commands)[0] ?? "test",
            expect: "success",
          }
        : value === "function"
          ? { kind: "function", function: "git-push" }
          : undefined;
    if (
      value === "function" &&
      !state.value?.blocks[selected.value] &&
      definition.value.name === "New block"
    ) {
      definition.value.name = "Push current branch";
      definition.value.description =
        "Push existing commits after verification and commit creation. Creates the remote branch and configures upstream when needed.";
      definition.value.outputs = ["publication"];
      bundle.value!.prompt =
        "Push existing commits from the current branch. Return failure diagnostics to the configured retry step; do not stage, commit, force push or fix changes.";
    }
  }
}
async function save() {
  const current = bundle.value;
  if (!current) {
    return;
  }
  const { permissions: _legacy, ...def } = current.definition;
  const normalized = {
    ...current,
    definition: {
      ...def,
      outputs: def.outputs.filter(Boolean),
    },
  };
  const proposal = await request(
    "/api/library/proposals",
    libraryProposalSchema,
    {
      method: "POST",
      body: {
        kind: "manual",
        baseHash: state.value?.revision,
        changes: {
          summary: `Update ${def.name}`,
          blocks: [{ bundle: normalized, rationale: "Configured in Settings" }],
        },
      },
    },
  );
  await request(
    `/api/library/proposals/${proposal.id}/apply`,
    libraryProposalSchema,
    { method: "POST", body: {} },
  );
  const updated = await load();
  selected.value = def.id;
  // The edit buffer must never share a mutable object with the saved baseline.
  bundle.value = updated.blocks[def.id]
    ? structuredClone(toRaw(updated.blocks[def.id]))
    : undefined;
  await props.onSaved();
  notice.value =
    "Block saved. New workflows use this definition; existing runs keep their snapshots.";
}
function remove() {
  const current = definition.value;
  const revision = state.value?.revision;
  const id = selected.value;
  if (
    !current ||
    !revision ||
    !window.confirm(
      `Remove “${current.name}” from the reusable library? Existing workflows keep their saved copy.`,
    )
  ) {
    return;
  }
  void perform(async () => {
    await request(
      `/api/library/blocks/${id}`,
      z.object({ removed: z.boolean() }),
      { method: "DELETE", body: { revision } },
    );
    await load();
    bundle.value = undefined;
    selected.value = "";
    await props.onSaved();
  });
}
function check(command: string, enabled: boolean) {
  if (definition.value) {
    definition.value.checks = enabled
      ? [...definition.value.checks, { command, expect: "success" }]
      : definition.value.checks.filter((item) => item.command !== command);
  }
}
</script>

<template>
  <section>
    <div class="settings-section-title">
      <div>
        <h2>Reusable blocks</h2>
        <p>
          Small units of work with instructions, outputs and pass/retry/fail
          routes.
        </p>
      </div>
      <div class="button-row">
        <button class="ai-button" :disabled="busy" @click="emit('design')">
          <Icon name="spark" />Design with AI</button
        ><button :disabled="busy" @click="add">
          <Icon name="plus" />Add block
        </button>
      </div>
    </div>
    <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
    <div v-if="notice" class="setup-notice" role="status">{{ notice }}</div>
    <div class="block-settings-layout">
      <div class="block-catalog">
        <button
          v-for="item in Object.values(state?.blocks ?? {})"
          :key="item.definition.id"
          :class="{ selected: selected === item.definition.id }"
          :disabled="busy"
          @click="choose(item.definition.id)"
        >
          <Icon :name="item.definition.executor ? 'terminal' : 'workflow'" />
          <div>
            <strong>{{ item.definition.name }}</strong
            ><small
              >{{
                item.definition.executor?.kind === "function"
                  ? "Function"
                  : item.definition.executor
                    ? "Command"
                    : "AI block"
              }}
              · {{ item.definition.outputs.length }} outputs</small
            >
          </div>
        </button>
      </div>
      <div v-if="bundle && definition" class="settings-card">
        <fieldset :disabled="busy">
          <div class="field-grid">
            <Field v-slot="{ id }" label="Block name"
              ><input :id="id" v-model="definition.name" /></Field
            ><Field
              v-slot="{ id }"
              label="Block ID"
              help="Referenced by workflow steps."
              ><input
                :id="id"
                v-model="definition.id"
                :disabled="!!state?.blocks[selected]"
            /></Field>
          </div>
          <Field v-slot="{ id }" label="When should this block be used?">
            <textarea
              v-autosize
              :id="id"
              v-model="definition.description"
              :rows="2"
            />
          </Field>
          <Field v-slot="{ id }" label="Execution"
            ><select
              :id="id"
              :value="definition.executor?.kind ?? 'ai'"
              @change="execution(inputValue($event))"
            >
              <option value="ai">AI agent</option>
              <option value="function">
                Built-in function · no model call
              </option>
              <option value="command">
                Configured command · no model call
              </option>
            </select></Field
          >
          <template v-if="definition.executor?.kind === 'function'">
            <Field v-slot="{ id }" label="Function">
              <select :id="id" v-model="definition.executor.function">
                <option value="git-push">Git · Push current branch</option>
              </select>
            </Field>
            <Field
              v-slot="{ id }"
              label="Git remote (optional)"
              help="Use an existing remote name, such as origin. Leave empty to follow Git push configuration or upstream, then origin or the sole remote."
            >
              <input
                :id="id"
                :value="definition.executor.remote ?? ''"
                placeholder="Automatic"
                @input="
                  definition.executor.remote =
                    inputValue($event).trim() || undefined
                "
              />
            </Field>
            <div class="function-description">
              <Icon name="terminal" :size="20" />
              <p>
                Pushes existing commits and sets upstream, creating the remote
                branch if needed. No AI call, staging, commit creation or force
                push. A failed push returns diagnostics to the workflow’s retry
                route.
              </p>
            </div>
          </template>
          <div
            v-else-if="definition.executor?.kind === 'command'"
            class="field-grid"
          >
            <Field v-slot="{ id }" label="Command"
              ><select :id="id" v-model="definition.executor.command">
                <option value="">Choose a configured command</option>
                <option
                  v-for="command in Object.keys(library.config.commands)"
                  :key="command"
                  :value="command"
                >
                  {{ command }}
                </option>
              </select></Field
            ><Field v-slot="{ id }" label="Success condition"
              ><select :id="id" v-model="definition.executor.expect">
                <option value="success">Exit code is zero</option>
                <option value="failure">
                  Exit code is nonzero (reproduction)
                </option>
              </select></Field
            >
          </div>
          <Field v-else v-slot="{ id }" label="Preferred model profile"
            ><select
              :id="id"
              :value="selectedProfile"
              @change="selectProfile(inputValue($event))"
            >
              <option value="">Let the orchestrator choose</option>
              <option
                v-for="profile in settings.profiles.filter(
                  (item) => item.enabled,
                )"
                :key="profile.id"
                :value="profile.id"
              >
                {{ profile.name }}
              </option>
            </select></Field
          >
          <Field
            v-slot="{ id }"
            :label="definition.executor ? 'Step notes' : 'Block instructions'"
            :help="
              definition.executor
                ? 'Documentation for the orchestrator. Execution follows the function or command settings above; no model interprets these notes.'
                : undefined
            "
          >
            <textarea
              v-autosize
              :id="id"
              v-model="bundle.prompt"
              :rows="definition.executor ? 3 : 7"
            />
          </Field>
          <Field
            v-slot="{ id }"
            label="Output artifacts"
            help="Comma-separated names. A summary is always available."
            ><input
              :id="id"
              :value="definition.outputs.join(', ')"
              @input="
                definition.outputs = inputValue($event)
                  .split(',')
                  .map((item) => item.trim())
              "
          /></Field>
          <details v-if="!definition.executor">
            <summary>Host checks</summary>
            <p class="muted">
              AI steps can use files, Bash, Git and enabled MCP servers.
              Describe each step’s responsibilities in its instructions.
            </p>
            <label
              v-for="command in Object.keys(library.config.commands)"
              :key="command"
              class="checkbox"
              ><input
                type="checkbox"
                :checked="
                  definition.checks.some((item) => item.command === command)
                "
                @change="check(command, inputChecked($event))"
              />Require {{ command }} to pass</label
            >
          </details>
          <div class="button-row">
            <button class="primary" :disabled="!dirty" @click="perform(save)">
              Save block</button
            ><button v-if="dirty" @click="discard">
              {{
                state?.blocks[selected]
                  ? "Discard block changes"
                  : "Cancel new block"
              }}</button
            ><button
              v-if="state?.blocks[selected]"
              class="danger-quiet"
              :disabled="Object.keys(state.blocks).length <= 1"
              @click="remove"
            >
              Remove block
            </button>
          </div>
        </fieldset>
      </div>
      <div v-else class="settings-empty">
        <Icon name="workflow" :size="32" />
        <h3>Select a block</h3>
        <p>
          Inspect its instructions and outputs, or create a new unit of work.
        </p>
      </div>
    </div>
  </section>
</template>
