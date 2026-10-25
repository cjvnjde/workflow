<script setup lang="ts">
import type { OrchestrationSettings } from "../../src/orchestration-schema.js";
import Field from "../components/Field.vue";
import Icon from "../components/Icon.vue";
import McpSettings from "./McpSettings.vue";
defineProps<{
  projectCapabilities?: import("zod").infer<
    typeof import("../../src/orchestration-schema.js").projectCapabilitiesSchema
  >;
}>();
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
    <article class="settings-card">
      <h2>From this project</h2>
      <p>
        Skills are discovered from .agents/skills, .claude/skills, .codex/skills
        and .pi/skills. MCP servers come from .mcp.json, .codex/config.toml,
        .vscode/mcp.json and .pi/mcp.json. New runs reload these files; existing
        runs keep their snapshot.
      </p>
      <p>
        Entries below with the same ID override project files, including
        disabling them. Edit discovered entries in their source files.
      </p>
      <p v-if="!projectCapabilities?.sources.length">
        No project skills or MCP servers found.
      </p>
      <ul v-else>
        <li
          v-for="source in projectCapabilities.sources"
          :key="source.kind + source.id"
        >
          <strong>{{ source.id }}</strong> · {{ source.kind }} ·
          {{ source.path }}
        </li>
      </ul>
      <p
        v-for="warning in projectCapabilities?.warnings"
        :key="warning"
        role="status"
      >
        {{ warning }}
      </p>
    </article>
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
          enabled servers are available to execution blocks. The coordinator
          composes graphs from supplied context without calling MCP tools.
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
