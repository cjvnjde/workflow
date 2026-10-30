<script setup lang="ts">
import { ref } from "vue";
import type { z } from "zod";
import { identifierSchema } from "../../src/contracts.js";
import type { executionSettingsSchema } from "../../src/contracts.js";
import type { OrchestrationSettings } from "../../src/contracts.js";
import { inputValue } from "../form-events.js";
import Field from "../components/Field.vue";
import Icon from "../components/Icon.vue";
const execution = defineModel<z.infer<typeof executionSettingsSchema>>({
  required: true,
});
const approval = defineModel<OrchestrationSettings["approval"]>("approval", {
  required: true,
});
const newCommand = ref("");
function setBudget(
  key: "maxCostUsd" | "maxTaskCostUsd" | "maxSetupCostUsd",
  value: string,
) {
  execution.value.budget = {
    inputTokensPerCall: 4000,
    outputTokensPerCall: 1000,
    callsPerVisit: 4,
    prices: {},
    ...execution.value.budget,
    [key]: value ? Number(value) : undefined,
  };
}
function addCommand() {
  execution.value.commands[newCommand.value] = {
    argv: [""],
    timeoutMs: 120_000,
  };
  newCommand.value = "";
}
</script>

<template>
  <section>
    <h2>Autonomy & execution</h2>
    <p>Keep planning flexible and execution bounded.</p>
    <div class="settings-card">
      <Field
        v-slot="{ id }"
        label="Workflow approval"
        help="Automatic mode starts generated workflows, including suggested blocks, without a review click."
        ><select :id="id" v-model="approval">
          <option value="review">Review each workflow before execution</option>
          <option value="automatic">Start automatically after planning</option>
        </select></Field
      >
    </div>
    <div class="settings-card">
      <Field v-slot="{ id }" label="Project instructions">
        <textarea
          v-autosize
          :id="id"
          v-model="execution.instructions"
          :rows="3"
        />
      </Field>
      <div class="field-grid">
        <Field v-slot="{ id }" label="Maximum steps per workflow"
          ><input
            :id="id"
            type="number"
            min="1"
            max="500"
            :value="execution.maxSteps"
            @input="execution.maxSteps = Number(inputValue($event))"
        /></Field>
      </div>
    </div>
    <div class="settings-card">
      <h2>AI spending limits</h2>
      <p>
        Defaults for new tasks and setup operations. Leave a limit blank to omit
        it. Reported usage stops further work at the limit; an in-flight
        response can exceed it.
      </p>
      <div class="field-grid">
        <Field
          v-slot="{ id }"
          label="Total task spending limit (USD)"
          help="Includes planning, workflow refinement, execution, retries and recovery. Requires known model prices."
        >
          <input
            :id="id"
            type="number"
            min="0.001"
            step="any"
            :value="execution.budget?.maxTaskCostUsd ?? ''"
            @input="setBudget('maxTaskCostUsd', inputValue($event))"
          />
        </Field>
        <Field
          v-slot="{ id }"
          label="Project setup spending limit (USD)"
          help="Covers one complete setup operation and its retries, including model roles, task instructions and blocks."
        >
          <input
            :id="id"
            type="number"
            min="0.001"
            step="any"
            :value="execution.budget?.maxSetupCostUsd ?? ''"
            @input="setBudget('maxSetupCostUsd', inputValue($event))"
          />
        </Field>
        <Field
          v-slot="{ id }"
          label="Execution spending limit (USD)"
          help="An additional limit for execution only. Planning and refinement count toward the total task limit above."
          ><input
            :id="id"
            type="number"
            min="0.001"
            step="any"
            :value="execution.budget?.maxCostUsd ?? ''"
            @input="setBudget('maxCostUsd', inputValue($event))"
        /></Field>
      </div>
    </div>
    <div class="settings-section-title">
      <div>
        <h2>Named commands</h2>
        <p>
          Functions such as tests or commits use these exact commands. They run
          with your process permissions.
        </p>
      </div>
    </div>
    <div
      v-for="(command, name) in execution.commands"
      :key="name"
      class="settings-card"
    >
      <div class="card-title">
        <Icon name="terminal" /><strong>{{ name }}</strong
        ><button
          class="icon-button"
          :aria-label="`Remove command ${name}`"
          @click="delete execution.commands[name]"
        >
          <Icon name="close" />
        </button>
      </div>
      <Field
        v-slot="{ id }"
        :label="`${name} arguments`"
        help="One argument per line. First line is the executable; no shell parsing."
      >
        <textarea
          v-autosize
          :id="id"
          :rows="4"
          :value="command.argv.join('\n')"
          @input="command.argv = inputValue($event).split('\n')"
        /></Field
      ><Field v-slot="{ id }" :label="`${name} timeout (seconds)`"
        ><input
          :id="id"
          type="number"
          min="1"
          max="600"
          :value="command.timeoutMs / 1000"
          @input="command.timeoutMs = Number(inputValue($event)) * 1000"
      /></Field>
    </div>
    <div class="inline-add">
      <input
        v-model="newCommand"
        aria-label="New command name"
        placeholder="test, lint, commit…"
      /><button
        :disabled="
          !identifierSchema.safeParse(newCommand).success ||
          !!execution.commands[newCommand]
        "
        @click="addCommand"
      >
        Add command
      </button>
    </div>
  </section>
</template>
