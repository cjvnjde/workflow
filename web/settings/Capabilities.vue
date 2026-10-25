<script setup lang="ts">
import { ref, onScopeDispose, toRaw } from "vue";
import { z } from "zod";
import { request } from "../api.js";
import type { McpServer } from "../../src/capability-schema.js";
import type { OrchestrationSettings } from "../../src/orchestration-schema.js";
import Field from "../components/Field.vue";
import Icon from "../components/Icon.vue";
import McpSettings from "./McpSettings.vue";
const props = defineProps<{
  projectCapabilities?: import("zod").infer<
    typeof import("../../src/orchestration-schema.js").projectCapabilitiesSchema
  >;
}>();
const capabilities = defineModel<OrchestrationSettings["capabilities"]>({
  required: true,
});
const connectionStatus = ref<Record<string, string>>({});
const inspecting = ref<string>();
const controller = new AbortController();
onScopeDispose(() => controller.abort());
function projectName(kind: string, id: string) {
  const key = kind === "skill" ? "skills" : "mcpServers";
  return (
    props.projectCapabilities?.capabilities[key].find((item) => item.id === id)
      ?.name ?? id
  );
}
function enabled(kind: string, id: string) {
  const key = kind === "skill" ? "skills" : "mcpServers";
  return (
    capabilities.value[key].find((item) => item.id === id)?.enabled ??
    props.projectCapabilities?.capabilities[key].find((item) => item.id === id)
      ?.enabled ??
    false
  );
}
function override(kind: string, id: string) {
  if (kind === "skill") {
    if (capabilities.value.skills.some((item) => item.id === id)) return;
    const item = props.projectCapabilities?.capabilities.skills.find(
      (item) => item.id === id,
    );
    if (item) capabilities.value.skills.push(structuredClone(toRaw(item)));
  } else {
    if (capabilities.value.mcpServers.some((item) => item.id === id)) return;
    const item = props.projectCapabilities?.capabilities.mcpServers.find(
      (item) => item.id === id,
    );
    if (item) capabilities.value.mcpServers.push(structuredClone(toRaw(item)));
  }
}
async function inspect(id: string) {
  const server: McpServer | undefined =
    capabilities.value.mcpServers.find((item) => item.id === id) ??
    props.projectCapabilities?.capabilities.mcpServers.find(
      (item) => item.id === id,
    );
  if (!server) return;
  inspecting.value = id;
  connectionStatus.value[id] = "Connecting…";
  try {
    const result = await request(
      "/api/settings/mcp/inspect",
      z.object({
        tools: z.array(
          z.object({
            name: z.string(),
            description: z.string(),
            readOnly: z.boolean(),
          }),
        ),
      }),
      { method: "POST", body: server, signal: controller.signal },
    );
    connectionStatus.value[id] =
      `Connected · ${result.tools.length} tools: ${result.tools.map((tool) => tool.name).join(", ")}`;
  } catch (error) {
    connectionStatus.value[id] =
      error instanceof Error ? error.message : String(error);
  } finally {
    inspecting.value = undefined;
  }
}
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
          <strong>{{ projectName(source.kind, source.id) }}</strong> ·
          {{ enabled(source.kind, source.id) ? "Enabled" : "Disabled" }} ·
          {{ source.kind }} ·
          {{ source.path }}
          <button @click="override(source.kind, source.id)">
            Customize in Workflow
          </button>
          <button
            v-if="source.kind === 'mcp'"
            :disabled="!!inspecting"
            @click="inspect(source.id)"
          >
            Test connection
          </button>
          <p v-if="connectionStatus[source.id]" role="status">
            {{ connectionStatus[source.id] }}
          </p>
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
