<script setup lang="ts">
import { onScopeDispose, ref } from "vue";
import {
  programSourceSchema,
  type ProgramSource,
} from "../../src/program-schema.js";
const props = defineProps<{
  onSubmit: (
    value: ProgramSource & { title: string; task: string },
    signal: AbortSignal,
  ) => Promise<void>;
}>();
const title = ref("My workflow");
const filename = ref("workflow.ts");
const template = `import { workflow, script, z } from "workflow";

export default workflow({
  name: "Project check",
  input: z.object({ request: z.string() }),
  async run(ctx) {
    const result = await ctx.step("check", script({
      language: "bash",
      code: "git status --short",
    }), { prompt: ctx.input.request });
    if (result.outcome !== "pass") throw new Error(result.summary);
    return result.summary;
  },
});
`;
const source = ref(template);
const input = ref('{\n  "request": "Inspect the working tree"\n}');
const error = ref(""),
  busy = ref(false),
  picker = ref<HTMLInputElement>();
const panel = ref<HTMLDetailsElement>();
const open = ref(false);
let controller: AbortController | undefined;
onScopeDispose(() => controller?.abort());
function discard() {
  source.value = template;
  title.value = "My workflow";
  filename.value = "workflow.ts";
  input.value = '{\n  "request": "Inspect the working tree"\n}';
  error.value = "";
  if (panel.value) panel.value.open = false;
}
async function load(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!file.name.endsWith(".ts") || file.size > 256_000) {
    error.value = "Choose a TypeScript file below 256 KB.";
    return;
  }
  source.value = await file.text();
  filename.value = file.name;
  error.value = "";
  (event.target as HTMLInputElement).value = "";
}
async function submit() {
  busy.value = true;
  error.value = "";
  const current = new AbortController();
  controller = current;
  try {
    const program = programSourceSchema.parse({
      source: source.value,
      filename: filename.value,
      input: JSON.parse(input.value),
    });
    await props.onSubmit({
      ...program,
      title: title.value,
      task:
        typeof program.input.request === "string"
          ? program.input.request
          : title.value,
    }, current.signal);
  } catch (failure) {
    error.value = current.signal.aborted ? "Workflow creation cancelled." : failure instanceof Error ? failure.message : String(failure);
  } finally {
    busy.value = false;
    if (controller === current) controller = undefined;
  }
}
</script>
<template>
  <details
    ref="panel"
    class="program-import"
    @toggle="open = ($event.target as HTMLDetailsElement).open"
  >
    <summary>Use a TypeScript workflow</summary>
    <p>
      Paste or import a workflow, then review its source before starting it.
    </p>
    <fieldset v-if="open" :disabled="busy">
      <label class="editor-field"
        >Workflow name<input v-model="title" maxlength="200"
      /></label>
      <div class="editor-actions">
        <input
          ref="picker"
          type="file"
          accept=".ts"
          hidden
          aria-label="Import TypeScript file"
          @change="load"
        />
        <button @click="picker?.click()">Import .ts file</button
        ><small>{{ filename }}</small>
      </div>
      <label class="editor-field"
        >New workflow TypeScript<textarea
          v-autosize="24"
          v-model="source"
          class="program-source"
          :spellcheck="false"
          :rows="6"
        />
      </label>
      <label class="editor-field"
        >New workflow inputs (JSON)<textarea
          v-autosize
          v-model="input"
          class="script-source"
          :spellcheck="false"
          :rows="3"
        />
      </label>
      <div class="editor-actions">
        <button class="primary" @click="submit">
          {{ busy ? "Checking TypeScript…" : "Create workflow draft" }}</button
        ><button @click="discard">Discard TypeScript draft</button>
      </div>
    </fieldset>
    <button v-if="busy" @click="controller?.abort()">Cancel workflow creation</button>
    <pre v-if="error" class="validation-error" role="alert">{{ error }}</pre>
  </details>
</template>
