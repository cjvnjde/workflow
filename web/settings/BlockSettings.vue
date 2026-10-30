<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch, toRaw } from "vue";
import { z } from "zod";
import {
  bundleSchema,
  runSchema,
  identifierSchema,
  type BlockBundle,
  type Library,
} from "../../src/contracts/index.js";
import { libraryProposalSchema } from "../../src/contracts/index.js";
import type { OrchestrationSettings } from "../../src/contracts/index.js";
import { request } from "../shared/api.js";
import Field from "../shared/Field.vue";
import CodeEditor from "../shared/CodeEditor.vue";
import Icon from "../shared/Icon.vue";

const props = defineProps<{
  library: Library;
  settings: OrchestrationSettings;
  onSaved: () => Promise<void>;
}>();
const emit = defineEmits<{
  dirty: [value: boolean];
  busy: [value: boolean];
  selected: [id: string];
}>();
const libraryStateSchema = z.object({
  revision: z.string(),
  blocks: z.record(identifierSchema, bundleSchema),
  codeBlocks: z.record(identifierSchema, bundleSchema),
});
const state = shallowRef<z.infer<typeof libraryStateSchema>>();
const selected = ref("");
watch(selected, (id) => emit("selected", id), { immediate: true });
const bundle = ref<BlockBundle>();
const busy = ref(false),
  error = ref(""),
  notice = ref("");
const controller = new AbortController();
async function load() {
  const value = await request("/api/library", libraryStateSchema, {
    signal: controller.signal,
  });
  state.value = value;
  return value;
}
onMounted(() => {
  void load().catch((failure) => {
    if (!controller.signal.aborted) error.value = String(failure);
  });
});
const baseline = computed(() => state.value?.codeBlocks[selected.value]);
const dirty = computed(
  () => !!bundle.value && JSON.stringify(bundle.value) !== JSON.stringify(baseline.value),
);
watch(dirty, (value) => emit("dirty", value), { immediate: true });
onScopeDispose(() => {
  controller.abort();
  emit("dirty", false);
});
const definition = computed(() => bundle.value?.definition);
function discard() {
  if (busy.value) return;
  bundle.value = baseline.value ? structuredClone(toRaw(baseline.value)) : undefined;
  if (!bundle.value) selected.value = "";
  error.value = "";
  notice.value = "";
}
defineExpose({ discard });
function canSwitch() {
  return !dirty.value || window.confirm("Discard unsaved block changes?");
}
function choose(id: string) {
  if (!canSwitch()) return;
  selected.value = id;
  bundle.value = state.value?.codeBlocks[id]
    ? structuredClone(toRaw(state.value.codeBlocks[id]))
    : undefined;
  error.value = "";
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
const testInput = ref("{}"),
  testPrompt = ref("Test this block with the supplied inputs.");
async function playground() {
  const inputs = z.record(z.string(), z.json()).parse(JSON.parse(testInput.value));
  const run = await request("/api/programs", runSchema, {
    method: "POST",
    body: {
      title: `Test ${definition.value!.name}`,
      task: testPrompt.value,
      source: `import {workflow,step} from "workflow"; export default workflow({name:${JSON.stringify(`Test ${definition.value!.name}`)},flow:step("test-block",${JSON.stringify(selected.value)},{inputs:${JSON.stringify(inputs)},prompt:${JSON.stringify(testPrompt.value)}})});`,
    },
  });
  window.location.hash = `run=${run.id}`;
}
const template = `import { block, z } from "workflow";

export default block({
  output: z.object({ exitCode: z.number().nullable(), output: z.string() }),
  async run(ctx) {
    const result = await ctx.exec("git status --short");
    ctx.summary(result.output || "Working tree is clean.");
    return { exitCode: result.exitCode, output: result.output };
  },
});
`;
function add() {
  if (!canSwitch()) return;
  selected.value = `block-${crypto.randomUUID().slice(0, 8)}`;
  bundle.value = bundleSchema.parse({
    definition: {
      id: selected.value,
      name: "New block",
      description: "Describe when this block should be used",
      executor: { kind: "code", source: template },
    },
    prompt: "Behavior, models, inputs and outputs are defined in TypeScript.",
    skills: [],
  });
  error.value = "";
  notice.value = "";
}
async function save() {
  const current = bundle.value;
  if (!current) return;
  const proposal = await request("/api/library/proposals", libraryProposalSchema, {
    method: "POST",
    body: {
      kind: "manual",
      baseHash: state.value?.revision,
      changes: {
        summary: `Update ${current.definition.name}`,
        blocks: [{ bundle: current, rationale: "Configured in Settings" }],
      },
    },
  });
  await request(`/api/library/proposals/${proposal.id}/apply`, libraryProposalSchema, {
    method: "POST",
    body: {},
  });
  await load();
  selected.value = current.definition.id;
  bundle.value = structuredClone(toRaw(state.value!.codeBlocks[selected.value]!));
  await props.onSaved();
  notice.value =
    "Block saved. New workflows use this definition; existing runs keep their snapshots.";
}
function remove() {
  const id = selected.value,
    current = state.value?.blocks[id];
  if (
    !current ||
    !window.confirm(
      `Remove “${current.definition.name}” from the reusable library? Existing workflows keep their saved copy.`,
    )
  )
    return;
  void perform(async () => {
    await request(`/api/library/blocks/${id}`, z.object({ removed: z.boolean() }), {
      method: "DELETE",
      body: { revision: state.value!.revision },
    });
    await load();
    bundle.value = undefined;
    selected.value = "";
    await props.onSaved();
  });
}
async function copy() {
  if (definition.value?.executor?.kind !== "code") return;
  try {
    await navigator.clipboard.writeText(definition.value.executor.source);
    notice.value = "TypeScript copied.";
  } catch {
    error.value = "Clipboard unavailable. Download the source instead.";
  }
}
function download() {
  if (definition.value?.executor?.kind !== "code") return;
  const url = URL.createObjectURL(
    new Blob([definition.value.executor.source], {
      type: "text/typescript;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${definition.value.id}.ts`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <section>
    <div class="settings-section-title">
      <div>
        <h2>Reusable blocks</h2>
        <p>
          TypeScript functions with typed inputs and outputs. Call AI, run commands, or combine both
          in the same block.
        </p>
      </div>
      <div class="button-row">
        <button :disabled="busy" @click="add"><Icon name="plus" />Add block</button>
      </div>
    </div>
    <pre v-if="error" class="inline-error" role="alert">{{ error }}</pre>
    <p v-if="notice" class="setup-notice" role="status">{{ notice }}</p>
    <div class="block-settings-layout">
      <div class="block-catalog">
        <button
          v-for="item in Object.values(state?.blocks ?? library.blocks)"
          :key="item.definition.id"
          :class="{ selected: selected === item.definition.id }"
          :disabled="busy"
          @click="choose(item.definition.id)"
        >
          <Icon name="code" />
          <div>
            <strong>{{ item.definition.name }}</strong
            ><small>TypeScript block</small>
          </div>
        </button>
      </div>
      <div
        v-if="bundle && definition?.executor?.kind === 'code'"
        class="settings-card block-code-card"
      >
        <fieldset :disabled="busy">
          <div class="field-grid">
            <Field v-slot="{ id }" label="Block name"
              ><input :id="id" v-model="definition.name"
            /></Field>
            <Field v-slot="{ id }" label="Block ID" help="Referenced by workflow steps."
              ><input :id="id" v-model="definition.id" :disabled="!!state?.blocks[selected]"
            /></Field>
          </div>
          <Field v-slot="{ id }" label="When should this block be used?">
            <textarea :id="id" v-model="definition.description" v-autosize :rows="2" />
          </Field>
          <details class="script-contract block-code-help">
            <summary>Block contract</summary>
            <p>
              Document the handoff and effects for callers. Input/output schemas and
              capability/ownership restrictions in TypeScript enforce the contract; these notes
              describe it.
            </p>
            <button
              v-if="!definition.contract"
              class="quiet"
              @click="
                definition.contract = {
                  inputs: '',
                  outputs: '',
                  effects: '',
                  failure: '',
                }
              "
            >
              Add contract notes
            </button>
            <template v-if="definition.contract">
              <Field v-slot="{ id }" label="Required inputs">
                <textarea :id="id" v-model="definition.contract.inputs" maxlength="2000" />
              </Field>
              <Field v-slot="{ id }" label="Returned outputs">
                <textarea :id="id" v-model="definition.contract.outputs" maxlength="2000" />
              </Field>
              <Field v-slot="{ id }" label="Tools, file ownership and side effects">
                <textarea :id="id" v-model="definition.contract.effects" maxlength="2000" />
              </Field>
              <Field v-slot="{ id }" label="Failure and retry behavior">
                <textarea :id="id" v-model="definition.contract.failure" maxlength="2000" />
              </Field>
            </template>
          </details>
          <div class="editor-actions">
            <strong>Block TypeScript</strong>
            <button class="quiet" @click="copy"><Icon name="copy" :size="14" />Copy code</button>
            <button class="quiet" @click="download">
              <Icon name="download" :size="14" />Download .ts
            </button>
          </div>
          <CodeEditor
            :key="selected"
            v-model="definition.executor.source"
            label="Block TypeScript"
            :readonly="busy"
            :min-lines="12"
            :max-lines="32"
          />
          <details class="script-contract block-code-help">
            <summary>Test this block</summary>
            <p>
              Create a one-step draft using the saved block. Review and approve it before execution.
              This uses real project tools and records outputs, checks and model calls in the run
              history.
            </p>
            <Field v-slot="{ id }" label="Test request">
              <textarea :id="id" v-model="testPrompt" />
            </Field>
            <Field v-slot="{ id }" label="Input JSON">
              <textarea :id="id" v-model="testInput" rows="5" spellcheck="false" />
            </Field>
            <button
              :disabled="busy || dirty || !baseline || !testPrompt.trim()"
              @click="perform(playground)"
            >
              Create block test
            </button>
            <p v-if="dirty">Save changes before testing this version.</p>
          </details>
          <details class="script-contract block-code-help">
            <summary>Block API & examples</summary>
            <p>
              Import <code>block, z</code> from <code>"workflow"</code> and export
              <code>block({ input, output, async run(ctx) { … } })</code>. Schemas are optional;
              returning a value passes it to the next step.
            </p>
            <p>
              <code>await ctx.ai({ prompt, model, output: z.object({ … }) })</code>
              returns a typed AI result. Omit <code>output</code> for Markdown. Set a model in code,
              accept one through inputs, or use <code>ctx.model</code> for the step’s default.
              Omitting <code>model</code> uses the model assigned by the orchestrator or in the
              workflow editor. An explicit model here takes precedence.
            </p>
            <p v-if="settings.profiles.some((profile) => profile.enabled)">
              Available profiles:
              <code
                v-for="profile in settings.profiles.filter((item) => item.enabled)"
                :key="profile.id"
                >ctx.models[{{ JSON.stringify(profile.id) }}]
              </code>
            </p>
            <p>
              <code>await ctx.exec("bun test")</code> returns
              <code>exitCode, stdout, stderr, output, timedOut</code>. Return failure feedback for
              the workflow to route to implementation. Run project TypeScript files with
              <code>ctx.exec("bun scripts/check.ts")</code>.
            </p>
            <p>
              <code>ctx.readFile(path)</code>, <code>ctx.writeFile(path, text)</code> and
              <code>ctx.log(message)</code> are awaited operations.
              <code>ctx.summary(markdown)</code> and <code>ctx.artifact(name, text)</code> make
              results easy to find. Set <code>timeoutMs</code> and <code>maxOperations</code> on the
              block when needed.
            </p>
            <p>
              Source and imports are frozen with each workflow. Commands run in the project with its
              environment. Use context operations for host effects so the engine can record and
              recover work.
            </p>
          </details>
          <div class="button-row">
            <button class="primary" :disabled="!dirty" @click="perform(save)">
              {{ busy ? "Typechecking…" : "Save block" }}
            </button>
            <button v-if="dirty" @click="discard">
              {{ state?.blocks[selected] ? "Discard block changes" : "Cancel new block" }}
            </button>
            <button v-if="state?.blocks[selected]" class="danger-quiet" @click="remove">
              Remove block
            </button>
          </div>
        </fieldset>
      </div>
      <div v-else class="settings-card empty-state">
        <Icon name="code" />
        <h2>Choose a block</h2>
        <p>Edit a reusable TypeScript function or design one with AI.</p>
      </div>
    </div>
  </section>
</template>
<style scoped>
.block-code-help {
  margin-top: 18px;
}
.block-code-card .editor-actions > strong {
  margin-right: auto;
  font-size: 12px;
}
.block-code-help code {
  overflow-wrap: anywhere;
}
</style>
