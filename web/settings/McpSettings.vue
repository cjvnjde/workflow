<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { z } from "zod";
import type { McpServer } from "../../src/capability-schema.js";
import { request } from "../api.js";
import { inputValue } from "../form-events.js";
import Field from "../components/Field.vue";
import Icon from "../components/Icon.vue";
const server = defineModel<McpServer>({ required: true });
const emit = defineEmits<{ remove: [] }>();
const catalog = ref<{ name: string; description: string; readOnly: boolean }[]>(
  [],
);
const busy = ref(false);
const error = ref("");
let controller: AbortController | undefined;
function cancel() {
  controller?.abort();
}
onScopeDispose(cancel);
watch(
  () => server.value,
  () => {
    cancel();
    catalog.value = [];
    error.value = "";
  },
);
const tools = computed(() => [
  ...new Map(
    [
      ...catalog.value,
      ...server.value.tools
        .filter((name) => !catalog.value.some((tool) => tool.name === name))
        .map((name) => ({
          name,
          description: "Previously discovered · reconnect to refresh",
          readOnly: false,
        })),
    ].map((tool) => [tool.name, tool]),
  ).values(),
]);
async function inspect() {
  const current = server.value;
  const active = new AbortController();
  controller = active;
  busy.value = true;
  error.value = "";
  try {
    const result = (
      await request(
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
        { method: "POST", body: current, signal: active.signal },
      )
    ).tools;
    if (active.signal.aborted || server.value !== current) return;
    catalog.value = result;
    server.value.tools = catalog.value.map((tool) => tool.name);
    server.value.planningTools = [];
  } catch (failure) {
    if (!active.signal.aborted)
      error.value =
        failure instanceof Error ? failure.message : String(failure);
  } finally {
    busy.value = false;
    if (controller === active) controller = undefined;
  }
}
</script>

<template>
  <article class="settings-card">
    <fieldset :disabled="busy">
      <div class="card-title">
        <Icon name="workflow" /><strong>{{ server.name }}</strong
        ><label class="checkbox"
          ><input
            v-model="server.enabled"
            type="checkbox"
            :aria-label="`Enable ${server.name}`"
          />Enabled</label
        ><button
          class="icon-button"
          :aria-label="`Remove ${server.name}`"
          @click="emit('remove')"
        >
          <Icon name="close" />
        </button>
      </div>
      <div class="field-grid">
        <Field v-slot="{ id }" label="MCP server name"
          ><input :id="id" v-model="server.name" /></Field
        ><Field v-slot="{ id }" label="MCP transport"
          ><select :id="id" v-model="server.transport">
            <option value="http">Streamable HTTP</option>
            <option value="stdio">Local command (stdio)</option>
          </select></Field
        >
      </div>
      <Field
        v-if="server.transport === 'http'"
        v-slot="{ id }"
        label="MCP endpoint"
        ><input :id="id" v-model="server.url"
      /></Field>
      <template v-else
        ><Field v-slot="{ id }" label="MCP executable"
          ><input :id="id" v-model="server.command" placeholder="npx" /></Field
        ><Field
          v-slot="{ id }"
          label="MCP arguments"
          help="One argument per line."
        >
          <textarea
            v-autosize
            :id="id"
            :value="server.args.join('\n')"
            :rows="3"
            @input="
              server.args = inputValue($event)
                ? inputValue($event).split('\n')
                : []
            "
          /></Field
      ></template>
      <Field
        v-slot="{ id }"
        label="Token environment variable (optional)"
        help="Name of a server-side environment variable. Its value is never returned to the browser."
        ><input
          :id="id"
          :value="server.tokenEnv ?? ''"
          placeholder="MY_MCP_TOKEN"
          @input="server.tokenEnv = inputValue($event) || undefined"
      /></Field>
    </fieldset>
    <button :disabled="busy" @click="inspect">
      {{ busy ? "Connecting…" : "Connect & discover tools" }}
    </button>
    <button v-if="busy" @click="cancel">Cancel discovery</button>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <p class="muted">
      All tools from an enabled server are available to execution blocks. The
      coordinator does not call MCP tools while planning. Local servers inherit
      the application’s environment.
    </p>
    <div v-if="tools.length" class="mcp-tools">
      <div v-for="tool in tools" :key="tool.name">
        <strong>{{ tool.name }}</strong>
        <small>{{ tool.description }}</small>
      </div>
    </div>
  </article>
</template>
