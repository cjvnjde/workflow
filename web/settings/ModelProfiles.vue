<script setup lang="ts">
import { agentSchema } from "../../src/contracts.js";
import type { OrchestrationSettings } from "../../src/contracts.js";
import { modelKey, type AvailableModel } from "../../src/contracts.js";
import { inputValue, inputChecked } from "../form-events.js";
import Field from "../components/Field.vue";
import Icon from "../components/Icon.vue";
const settings = defineModel<OrchestrationSettings>({ required: true });
const props = defineProps<{ models: AvailableModel[]; busy: boolean }>();
const emit = defineEmits<{ generate: [prompt: string] }>();
type Profile = OrchestrationSettings["profiles"][number];
function add() {
  const model =
    props.models.find(
      (item) => item.provider === "openai" && item.id === "gpt-6.1-sol",
    ) ?? props.models[0];
  if (!model) {
    return;
  }
  settings.value.profiles.push({
    id: `model-${crypto.randomUUID().slice(0, 8)}`,
    name: "New model profile",
    description:
      "Describe when to use this model, its strengths and tradeoffs.",
    enabled: true,
    agent: {
      provider: model.provider,
      model: model.id,
      thinking: agentSchema.shape.thinking.parse(
        model.thinkingLevels.includes("high")
          ? "high"
          : (model.thinkingLevels[0] ?? "off"),
      ),
    },
  });
}
function remove(profile: Profile) {
  if (settings.value.coordinatorProfile === profile.id) {
    settings.value.coordinatorProfile = "";
  }
  settings.value.profiles = settings.value.profiles.filter(
    (item) => item.id !== profile.id,
  );
}
function enable(profile: Profile, enabled: boolean) {
  profile.enabled = enabled;
  if (!enabled && settings.value.coordinatorProfile === profile.id) {
    settings.value.coordinatorProfile = "";
  }
}
function selected(profile: Profile) {
  return props.models.find(
    (model) =>
      model.provider === profile.agent.provider &&
      model.id === profile.agent.model,
  );
}
function choose(profile: Profile, key: string) {
  const model = props.models.find((item) => modelKey(item) === key);
  if (model) {
    profile.agent = {
      ...profile.agent,
      provider: model.provider,
      model: model.id,
      thinking: agentSchema.shape.thinking.parse(
        model.thinkingLevels.includes(profile.agent.thinking)
          ? profile.agent.thinking
          : (model.thinkingLevels[0] ?? "off"),
      ),
    };
  }
}
function generate() {
  emit(
    "generate",
    `${settings.value.profiles.length ? "Regenerate" : "Generate"} model profiles for this project. Inspect the project and connected catalog. Create a concise set of useful roles for coding, careful review, and routine work with cost-aware model choices. Preserve the project default as the planning model unless I explicitly ask to change it.`,
  );
}
</script>

<template>
  <section>
    <div class="settings-section-title">
      <div>
        <h2>A model for each kind of work</h2>
        <p>
          {{ settings.profiles.length }} configured role profiles ·
          {{ models.length }} models available from connected providers. Add a
          profile to use another model, such as Terra. These cards are roles,
          not the full model catalog.
        </p>
      </div>
      <button :disabled="busy || !models.length" @click="add">
        <Icon name="plus" />Add model profile
      </button>
    </div>
    <p v-if="!models.length" class="muted">
      Connect ChatGPT or another provider in Providers & models first.
    </p>
    <div class="profile-generation">
      <Icon name="spark" :size="23" />
      <div>
        <strong>{{
          settings.profiles.length
            ? "Refresh your model lineup"
            : "Let AI set up your models"
        }}</strong>
        <p>
          Use this project and the connected catalog to assign routine work to
          efficient models and demanding work to stronger ones.
        </p>
      </div>
      <button :disabled="busy || !models.length" @click="generate">
        {{
          settings.profiles.length ? "Regenerate with AI" : "Generate with AI"
        }}
      </button>
    </div>
    <div class="settings-card">
      <Field
        v-slot="{ id }"
        label="Planning model"
        help="Use the project default to plan requests, or explicitly choose a profile here. The planner chooses execution models from your enabled profiles."
        ><select :id="id" v-model="settings.coordinatorProfile">
          <option value="">Project default model</option>
          <option
            v-for="profile in settings.profiles.filter((item) => item.enabled)"
            :key="profile.id"
            :value="profile.id"
          >
            {{ profile.name }}
          </option>
        </select></Field
      >
    </div>
    <div v-if="!settings.profiles.length" class="settings-empty">
      <Icon name="spark" :size="28" />
      <h3>Give your models a role</h3>
      <p>
        For example: “Careful reviewer — use for complex code and security
        checks” or “Fast helper — use for summaries and simple changes.” Without
        profiles, the full connected catalog is available.
      </p>
    </div>
    <article
      v-for="profile in settings.profiles"
      :key="profile.id"
      class="settings-card"
    >
      <div class="card-title">
        <Icon name="spark" /><strong>{{ profile.name }}</strong
        ><label class="checkbox"
          ><input
            type="checkbox"
            :checked="profile.enabled"
            @change="enable(profile, inputChecked($event))"
          />Enabled</label
        ><button
          class="icon-button"
          :aria-label="`Remove ${profile.name}`"
          @click="remove(profile)"
        >
          <Icon name="close" />
        </button>
      </div>
      <Field v-slot="{ id }" label="Profile name"
        ><input :id="id" v-model="profile.name"
      /></Field>
      <Field v-slot="{ id }" label="When should this model be used?">
        <textarea v-autosize :id="id" v-model="profile.description" :rows="3" />
      </Field>
      <div class="field-grid">
        <Field v-slot="{ id }" label="Profile model"
          ><select
            :id="id"
            :value="`${profile.agent.provider}/${profile.agent.model}`"
            @change="choose(profile, inputValue($event))"
          >
            <option
              v-if="!selected(profile)"
              :value="`${profile.agent.provider}/${profile.agent.model}`"
            >
              {{ profile.agent.model }} · unavailable
            </option>
            <option
              v-for="model in models"
              :key="modelKey(model)"
              :value="modelKey(model)"
            >
              {{ model.name }} · {{ model.provider
              }}{{ model.imageInput ? " · images" : "" }}
            </option>
          </select></Field
        >
        <Field v-slot="{ id }" label="Profile thinking"
          ><select
            :id="id"
            :value="profile.agent.thinking"
            @change="
              profile.agent.thinking = agentSchema.shape.thinking.parse(
                inputValue($event),
              )
            "
          >
            <option
              v-for="level in [
                ...new Set([
                  profile.agent.thinking,
                  ...(selected(profile)?.thinkingLevels ?? []),
                ]),
              ]"
              :key="level"
              :value="level"
            >
              {{ level }}
            </option>
          </select></Field
        >
      </div>
      <details>
        <summary>Session limits</summary>
        <p>
          Leave blank to inherit project defaults. A longer code-block timeout
          does not extend an AI session.
        </p>
        <div class="field-grid">
          <Field v-slot="{ id }" label="Session timeout (minutes)">
            <input
              :id="id"
              type="number"
              min="1"
              max="60"
              step="1"
              placeholder="Project default"
              :value="
                profile.agent.timeoutMs === undefined
                  ? ''
                  : profile.agent.timeoutMs / 60000
              "
              @input="
                profile.agent.timeoutMs =
                  inputValue($event) === ''
                    ? undefined
                    : Number(inputValue($event)) * 60000
              "
            />
          </Field>
          <Field v-slot="{ id }" label="Maximum tool calls">
            <input
              :id="id"
              type="number"
              min="1"
              max="1000"
              step="1"
              placeholder="Project default"
              :value="profile.agent.maxToolCalls"
              @input="
                profile.agent.maxToolCalls =
                  inputValue($event) === ''
                    ? undefined
                    : Number(inputValue($event))
              "
            />
          </Field>
        </div>
      </details>
    </article>
  </section>
</template>
