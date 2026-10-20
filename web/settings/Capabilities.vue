<script setup lang="ts">
import type { OrchestrationSettings } from "../../src/orchestration-schema.js";
import Field from "../components/Field.vue";
import Icon from "../components/Icon.vue";
import McpSettings from "./McpSettings.vue";
const capabilities = defineModel<OrchestrationSettings["capabilities"]>({
  required: true,
});
function addSkill() {
  capabilities.value.skills.push({
    id: `skill-${crypto.randomUUID().slice(0, 8)}`,
    name: "New skill",
    description: "",
    content: "Write the skill's instructions here.",
    enabled: true,
  });
}
function addServer() {
  capabilities.value.mcpServers.push({
    id: `mcp-${crypto.randomUUID().slice(0, 8)}`,
    name: "New MCP server",
    transport: "http",
    url: "http://localhost:3000/mcp",
    command: "",
    args: [],
    tools: [],
    planningTools: [],
    enabled: false,
  });
}
</script>

<template>
  <section>
    <div class="settings-section-title">
      <div>
        <h2>Skills</h2>
        <p>
          Explicit instructions available during planning and in execution
          steps. Enable only what this project needs.
        </p>
      </div>
      <button @click="addSkill"><Icon name="plus" />Add skill</button>
    </div>
    <article
      v-for="skill in capabilities.skills"
      :key="skill.id"
      class="settings-card"
    >
      <div class="card-title">
        <strong>{{ skill.name }}</strong
        ><label class="checkbox"
          ><input v-model="skill.enabled" type="checkbox" />Enabled</label
        ><button
          class="icon-button"
          :aria-label="`Remove ${skill.name}`"
          @click="
            capabilities.skills = capabilities.skills.filter(
              (item) => item.id !== skill.id,
            )
          "
        >
          <Icon name="close" />
        </button>
      </div>
      <Field v-slot="{ id }" label="Skill name"
        ><input :id="id" v-model="skill.name" /></Field
      ><Field v-slot="{ id }" label="Skill description"
        ><input :id="id" v-model="skill.description" /></Field
      ><Field v-slot="{ id }" label="Skill instructions">
        <textarea v-autosize :id="id" v-model="skill.content" :rows="6" />
      </Field>
    </article>
    <div class="settings-section-title">
      <div>
        <h2>MCP servers</h2>
        <p>
          Connect a local process or Streamable HTTP endpoint. All tools from
          enabled servers are available during planning and execution.
        </p>
      </div>
      <button @click="addServer"><Icon name="plus" />Add MCP server</button>
    </div>
    <McpSettings
      v-for="(server, index) in capabilities.mcpServers"
      :key="server.id"
      :model-value="server"
      @update:model-value="capabilities.mcpServers[index] = $event"
      @remove="
        capabilities.mcpServers = capabilities.mcpServers.filter(
          (item) => item.id !== server.id,
        )
      "
    />
  </section>
</template>
