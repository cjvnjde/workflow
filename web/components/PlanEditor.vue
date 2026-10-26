<script setup lang="ts">
import CodeEditor from "./CodeEditor.vue";
import { computed, onMounted, onScopeDispose, ref } from "vue";
import {
  agentSchema,
  resolveAgentSettings,
  type WorkflowNode,
  type WorkflowPlan,
  type WorkflowRun,
} from "../../src/contracts.js";
import {
  modelCatalogSchema,
  modelKey,
  type AvailableModel,
} from "../../src/contracts.js";
import { request } from "../api.js";
import type { PlanDraft } from "../composables/use-draft.js";
import { inputValue, inputChecked } from "../form-events.js";
import Field from "./Field.vue";
import { executionLabel } from "../execution-label.js";
const props = defineProps<{
  run: WorkflowRun;
  draft: PlanDraft;
  busy: boolean;
  live: boolean;
  coordinatorActivity: string;
  coordinatorText: string;
  refining: boolean;
}>();
const emit = defineEmits<{
  save: [];
  refine: [instructions: string];
  cancelRefinement: [];
  setup: [];
}>();
const mode = ref<"steps" | "json">("steps");
const selected = ref(props.run.plan.entry);
const models = ref<AvailableModel[]>([]);
const modelError = ref("");
const refinement = ref("");
const controller = new AbortController();
onMounted(() => {
  void request("/api/models", modelCatalogSchema, { signal: controller.signal })
    .then((catalog) => {
      models.value = catalog.models;
      modelError.value = catalog.warnings.join(" ");
    })
    .catch((error: unknown) => {
      if (!controller.signal.aborted) {
        modelError.value =
          error instanceof Error ? error.message : String(error);
      }
    });
});
onScopeDispose(() => controller.abort());
const plan = computed(() => props.draft.plan);
const node = computed(
  () =>
    plan.value?.nodes.find((item) => item.id === selected.value) ??
    plan.value?.nodes[0],
);
const executor = computed(
  () => node.value && props.run.blocks[node.value.block]?.definition.executor,
);
const canCallAI = computed(() => !executor.value || executor.value.kind === "code");
const locked = computed(() => props.busy || props.run.status !== "draft");
function edit(value: Partial<WorkflowPlan>) {
  if (plan.value) {
    props.draft.edit(JSON.stringify({ ...plan.value, ...value }, null, 2));
  }
}
function editNode(value: Partial<WorkflowNode>) {
  if (plan.value && node.value) {
    edit({
      nodes: plan.value.nodes.map((item) =>
        item.id === node.value!.id ? { ...item, ...value } : item,
      ),
    });
  }
}
const inherited = computed(() =>
  node.value
    ? resolveAgentSettings(
        props.run.config.agent,
        props.run.blocks[node.value.block]?.definition.agent,
      )
    : props.run.config.agent,
);
const effective = computed(() =>
  resolveAgentSettings(inherited.value, node.value?.agent),
);
const model = computed(() =>
  models.value.find(
    (item) =>
      item.provider === effective.value.provider &&
      item.id === effective.value.model,
  ),
);
const overrideModel = computed(() =>
  node.value?.agent?.model || node.value?.agent?.provider
    ? `${effective.value.provider ?? ""}/${effective.value.model ?? ""}`
    : "",
);
const thinkingLevels = computed(
  () =>
    model.value?.thinkingLevels.filter(
      (level) => agentSchema.shape.thinking.safeParse(level).success,
    ) ?? agentSchema.shape.thinking.unwrap().options,
);
function setModel(key: string) {
  if (!node.value) {
    return;
  }
  const agent = { ...node.value.agent };
  delete agent.provider;
  delete agent.model;
  const chosen = models.value.find((item) => modelKey(item) === key);
  if (chosen) {
    agent.provider = chosen.provider;
    agent.model = chosen.id;
    if (
      !chosen.thinkingLevels.includes(
        agent.thinking ?? inherited.value.thinking,
      )
    ) {
      agent.thinking = agentSchema.shape.thinking.parse(
        chosen.thinkingLevels.includes("off")
          ? "off"
          : (chosen.thinkingLevels[0] ?? "off"),
      );
    }
  }
  editNode({ agent: Object.keys(agent).length ? agent : undefined });
}
function setThinking(value: string) {
  const agent = { ...node.value?.agent };
  if (value) {
    agent.thinking = agentSchema.shape.thinking.parse(value);
  } else {
    delete agent.thinking;
  }
  editNode({ agent: Object.keys(agent).length ? agent : undefined });
}
function artifacts(sourceId: string) {
  const source = plan.value?.nodes.find((item) => item.id === sourceId);
  return [
    ...new Set([
      "summary",
      ...(source && props.run.blocks[source.block]?.definition.executor?.kind === "code" ? ["data"] : []),
      ...(source
        ? (props.run.blocks[source.block]?.definition.outputs ?? [])
        : []),
    ]),
  ];
}
function changeInput(
  index: number,
  patch: Partial<WorkflowNode["inputs"][number]>,
) {
  if (node.value) {
    editNode({
      inputs: node.value.inputs.map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    });
  }
}
function addInput() {
  if (!node.value || !plan.value) {
    return;
  }
  const source =
    plan.value.nodes.find((item) => item.id !== node.value!.id) ?? node.value;
  const aliases = new Set(
    node.value.inputs.map((input) => input.as ?? input.artifact),
  );
  let alias = "summary";
  for (let suffix = 2; aliases.has(alias); suffix++) {
    alias = `summary-${suffix}`;
  }
  editNode({
    inputs: [
      ...node.value.inputs,
      {
        node: source.id,
        artifact: "summary",
        required: false,
        ...(alias === "summary" ? {} : { as: alias }),
      },
    ],
  });
}
const outcomes = ["pass", "retry", "fail"] as const;
</script>

<template>
  <div class="plan-editor">
    <div class="editor-heading">
      <div>
        <h2>Workflow editor</h2>
        <p>
          Adjust steps before approval. Changes stay in this draft until you
          save.
        </p>
      </div>
      <div class="editor-switch" role="group" aria-label="Graph editing mode">
        <button :aria-pressed="mode === 'steps'" @click="mode = 'steps'">
          Step controls</button
        ><button :aria-pressed="mode === 'json'" @click="mode = 'json'">
          JSON
        </button>
      </div>
    </div>
    <div v-if="draft.error" class="validation-error" role="alert">
      {{ draft.error }}
    </div>
    <template v-if="mode === 'steps' && plan && node">
      <fieldset :disabled="locked" class="editor-fields">
        <div class="field-grid">
          <Field v-slot="{ id }" class="editor-field" label="Workflow title"
            ><input
              :id="id"
              :value="plan.title"
              :maxlength="200"
              @input="edit({ title: inputValue($event) })"
          /></Field>
          <Field v-slot="{ id }" class="editor-field" label="Starting step"
            ><select
              :id="id"
              :value="plan.entry"
              @change="edit({ entry: inputValue($event) })"
            >
              <option
                v-for="item in plan.nodes"
                :key="item.id"
                :value="item.id"
              >
                {{ item.label || item.id }}
              </option>
            </select></Field
          >
        </div>
        <div class="editor-field">
          <label for="editor-workflow-task">Workflow task</label
          ><textarea
            v-autosize
            id="editor-workflow-task"
            :rows="3"
            :maxlength="32_000"
            :value="plan.task"
            @input="edit({ task: inputValue($event) })"
          />
        </div>
      </fieldset>
      <div class="step-editor-layout">
        <nav class="step-list" aria-label="Workflow steps">
          <button
            v-for="(item, index) in plan.nodes"
            :key="item.id"
            :aria-current="node.id === item.id ? 'step' : undefined"
            @click="selected = item.id"
          >
            <span>{{ String(index + 1).padStart(2, "0") }}</span>
            <div>
              <strong>{{ item.label || "Untitled step" }}</strong
              ><small
                >{{ item.block
                }}{{ item.id === plan.entry ? " · start" : "" }}</small
              >
            </div>
          </button>
        </nav>
        <fieldset :disabled="locked" class="editor-fields step-fields">
          <div class="step-heading">
            <h3>{{ node.block }} step</h3>
            <code>{{ node.id }}</code>
          </div>
          <Field v-slot="{ id }" class="editor-field" label="Step name"
            ><input
              :id="id"
              :maxlength="120"
              :value="node.label"
              @input="editNode({ label: inputValue($event) })"
          /></Field>
          <div class="editor-field">
            <label for="editor-step-goal">Step goal</label
            ><textarea
              v-autosize
              id="editor-step-goal"
              :rows="4"
              :maxlength="8000"
              :value="node.goal"
              @input="editNode({ goal: inputValue($event) })"
            />
          </div>
          <div class="field-grid">
            <Field v-slot="{ id }" class="editor-field" label="Maximum visits"
              ><input
                :id="id"
                type="number"
                min="1"
                max="30"
                step="1"
                :value="node.maxVisits || ''"
                @input="editNode({ maxVisits: Number(inputValue($event)) })"
            /></Field>
            <Field
              v-if="canCallAI"
              v-slot="{ id }"
              class="editor-field"
              label="Step model"
              ><select
                :id="id"
                :value="overrideModel"
                @change="setModel(inputValue($event))"
              >
                <option value="">
                  Use block / project default{{
                    inherited.model ? ` · ${inherited.model}` : ""
                  }}
                </option>
                <option
                  v-if="
                    overrideModel &&
                    !models.some((item) => modelKey(item) === overrideModel)
                  "
                  :value="overrideModel"
                >
                  {{ overrideModel }} · unavailable
                </option>
                <option
                  v-for="item in models"
                  :key="modelKey(item)"
                  :value="modelKey(item)"
                >
                  {{ item.name }} · {{ modelKey(item) }}
                </option>
              </select></Field
            >
          </div>
          <p v-if="executor && !canCallAI" class="muted">
            {{ executionLabel(executor) }} · no model call
          </p>
          <p v-if="executor?.kind === 'code'" class="muted">
            This model is the default for ctx.ai calls in this step. An explicit
            ctx.ai({ model: ... }) in the block source takes precedence. Code without AI calls uses no model.
          </p>
          <Field
            v-if="canCallAI"
            v-slot="{ id }"
            class="editor-field"
            label="Step thinking"
            ><select
              :id="id"
              :value="node.agent?.thinking ?? ''"
              @change="setThinking(inputValue($event))"
            >
              <option value="">
                Use block / project default · {{ inherited.thinking }}
              </option>
              <option
                v-if="
                  node.agent?.thinking &&
                  !thinkingLevels.includes(node.agent.thinking)
                "
                :value="node.agent.thinking"
              >
                {{ node.agent.thinking }} · unsupported
              </option>
              <option
                v-for="level in thinkingLevels"
                :key="level"
                :value="level"
              >
                {{ level }}
              </option>
            </select></Field
          >
          <p
            v-if="
              canCallAI &&
              model &&
              !model.thinkingLevels.includes(effective.thinking)
            "
            class="warning"
          >
            This model does not support {{ effective.thinking }} thinking.
            Select a supported level before execution.
          </p>
          <h3>Where to go next</h3>
          <div class="route-fields">
            <Field
              v-for="outcome in outcomes"
              :key="outcome"
              v-slot="{ id }"
              class="editor-field"
              :label="`On ${outcome}`"
              ><select
                :id="id"
                :value="node.on[outcome]"
                @change="
                  editNode({
                    on: { ...node.on, [outcome]: inputValue($event) },
                  })
                "
              >
                <option value="$complete">Complete workflow</option>
                <option value="$failed">Stop as failed</option>
                <option
                  v-for="item in plan.nodes"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.label || item.id
                  }}{{ item.id === node.id ? " (repeat this step)" : "" }}
                </option>
              </select></Field
            >
          </div>
          <h3>Context handoffs</h3>
          <p class="muted">
            Choose which artifacts this step receives. Optional inputs can be
            missing on the first visit.
          </p>
          <p v-if="!node.inputs.length" class="muted">
            No artifacts are passed to this step.
          </p>
          <div
            v-for="(input, index) in node.inputs"
            :key="`${node.id}-${index}`"
            class="handoff-fields"
          >
            <div class="field-grid">
              <Field
                v-slot="{ id }"
                class="editor-field"
                :label="`Source step ${index + 1}`"
                ><select
                  :id="id"
                  :value="input.node"
                  @change="
                    changeInput(index, {
                      node: inputValue($event),
                      artifact: 'summary',
                    })
                  "
                >
                  <option
                    v-for="item in plan.nodes"
                    :key="item.id"
                    :value="item.id"
                  >
                    {{ item.label || item.id }}
                  </option>
                </select></Field
              >
              <Field
                v-slot="{ id }"
                class="editor-field"
                :label="`Artifact ${index + 1}`"
                ><select
                  :id="id"
                  :value="input.artifact"
                  @change="changeInput(index, { artifact: inputValue($event) })"
                >
                  <option
                    v-if="!artifacts(input.node).includes(input.artifact)"
                    :value="input.artifact"
                  >
                    {{ input.artifact }} · unavailable
                  </option>
                  <option
                    v-for="artifact in artifacts(input.node)"
                    :key="artifact"
                    :value="artifact"
                  >
                    {{ artifact }}
                  </option>
                </select></Field
              >
            </div>
            <Field
              v-slot="{ id }"
              class="editor-field"
              :label="`Input alias ${index + 1}`"
              ><input
                :id="id"
                :value="input.as ?? ''"
                :placeholder="input.artifact"
                @input="
                  changeInput(index, { as: inputValue($event) || undefined })
                "
            /></Field>
            <div class="handoff-actions">
              <label class="checkbox"
                ><input
                  type="checkbox"
                  :checked="input.required"
                  @change="
                    changeInput(index, { required: inputChecked($event) })
                  "
                />Required</label
              ><button
                @click="
                  editNode({
                    inputs: node.inputs.filter((_, i) => i !== index),
                  })
                "
              >
                Remove handoff {{ index + 1 }}
              </button>
            </div>
          </div>
          <button @click="addInput">Add handoff</button>
        </fieldset>
      </div>
      <div v-if="canCallAI" class="editor-help">
        <span>{{
          modelError ||
          (models.length
            ? "Model choices come from your connected providers."
            : "Connect ChatGPT or add an API key to choose models here.")
        }}</span
        ><button :disabled="busy" @click="emit('setup')">
          Providers & models
        </button>
      </div>
    </template>
    <template v-else
      ><p>
        Edit the complete graph, including step IDs and blocks. Block
        instructions and required checks stay fixed to this run's saved library.
      </p>
      <CodeEditor label="Workflow graph JSON" language="json" :model-value="draft.text" :readonly="locked" :min-lines="12" @update:model-value="draft.edit($event)" />
    </template>
    <div class="editor-actions">
      <button
        class="primary"
        :disabled="locked || !draft.dirty || draft.stale || !draft.validPlan"
        @click="emit('save')"
      >
        Validate & save draft</button
      ><button v-if="draft.dirty" :disabled="busy" @click="draft.reset()">
        {{
          draft.stale
            ? "Discard edits & load latest draft"
            : "Discard graph edits"
        }}</button
      ><small>{{
        run.status === "draft"
          ? "Saving does not execute the workflow."
          : "This workflow is read only. Create a new draft to make changes."
      }}</small>
    </div>
    <details v-if="live && run.status === 'draft'" class="refinement-editor">
      <summary>Refine this workflow with AI</summary>
      <label for="workflow-refinement"
        >Tell AI what to change in this draft</label
      ><textarea
        v-autosize
        id="workflow-refinement"
        v-model="refinement"
        :maxlength="8000"
        :disabled="busy"
        :rows="3"
        placeholder="Split implementation into smaller steps, or add another verification step…"
      /><button
        :disabled="busy || draft.dirty || !refinement.trim()"
        @click="emit('refine', refinement)"
      >
        Update draft with AI
      </button>
      <button v-if="refining" @click="emit('cancelRefinement')">
        Cancel refinement
      </button>
      <button v-else-if="refinement" :disabled="busy" @click="refinement = ''">
        Discard refinement
      </button>
      <div v-if="busy" class="coordinator-progress">
        <pre>{{ coordinatorActivity }}</pre>
        <pre>{{ coordinatorText }}</pre>
      </div>
    </details>
  </div>
</template>
