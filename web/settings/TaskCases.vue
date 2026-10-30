<script setup lang="ts">
import type { OrchestrationSettings } from "../../src/contracts/index.js";
import Field from "../shared/Field.vue";
import Icon from "../shared/Icon.vue";
const settings = defineModel<OrchestrationSettings>({ required: true });
function add() {
  settings.value.cases.push({
    id: `case-${crypto.randomUUID().slice(0, 8)}`,
    name: "New task case",
    description: "Describe which requests belong here.",
    instructions: "Describe how work of this type should be approached and verified.",
    enabled: true,
  });
}
</script>

<template>
  <section>
    <div class="settings-section-title">
      <div>
        <h2>Task cases & instructions</h2>
        <p>
          The orchestrator matches your request to a description, reads its instructions, and
          composes a fresh workflow.
        </p>
      </div>
      <button @click="add"><Icon name="plus" />Add task case</button>
    </div>
    <div class="settings-card">
      <Field v-slot="{ id }" label="Instructions for every task">
        <textarea
          :id="id"
          v-model="settings.instructions"
          v-autosize
          :rows="3"
          placeholder="Project priorities, planning preferences, and constraints…"
        /></Field
      ><label class="checkbox"
        ><input v-model="settings.suggestBlocks" type="checkbox" />Let the orchestrator suggest
        useful new blocks</label
      >
    </div>
    <article v-for="item in settings.cases" :key="item.id" class="settings-card">
      <div class="card-title">
        <Icon name="file" /><strong>{{ item.name }}</strong
        ><label class="checkbox"><input v-model="item.enabled" type="checkbox" />Enabled</label
        ><button
          class="icon-button"
          :aria-label="`Remove ${item.name}`"
          @click="settings.cases = settings.cases.filter((entry) => entry.id !== item.id)"
        >
          <Icon name="close" />
        </button>
      </div>
      <Field v-slot="{ id }" label="Case name"><input :id="id" v-model="item.name" /></Field>
      <Field v-slot="{ id }" label="When does this case apply?">
        <textarea :id="id" v-model="item.description" v-autosize :rows="2" />
      </Field>
      <Field v-slot="{ id }" label="Instructions for this case">
        <textarea :id="id" v-model="item.instructions" v-autosize :rows="5" />
      </Field>
    </article>
  </section>
</template>
