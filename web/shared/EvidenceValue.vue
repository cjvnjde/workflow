<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import type { EvidenceIdentity, StoredEvidenceValue } from "../../src/contracts/index.js";
import { client } from "./api.js";
import Icon from "./Icon.vue";

const props = defineProps<{
  identity: EvidenceIdentity;
  value: StoredEvidenceValue;
  label: string;
  named?: boolean;
}>();
const text = ref<string>();
const error = ref("");
const notice = ref("");
const loading = ref(false);
const opened = ref(false);
const query = ref("");
const matchIndex = ref(0);
let controller: AbortController | undefined;
let version = 0;
const content = computed(() => (props.value.state === "captured" ? props.value.ref : undefined));
const url = computed(() =>
  content.value
    ? client.evidenceContentUrl(
        props.identity.runId,
        props.identity.nodeId,
        props.identity.visit,
        content.value.id,
      )
    : "",
);
const downloadUrl = computed(() =>
  content.value
    ? client.evidenceContentUrl(
        props.identity.runId,
        props.identity.nodeId,
        props.identity.visit,
        content.value.id,
        true,
      )
    : "",
);
const isImage = computed(() => content.value?.mediaType.startsWith("image/"));
const parsed = computed(() => {
  if (!content.value?.mediaType.includes("json") || text.value === undefined) return undefined;
  try {
    return JSON.parse(text.value) as unknown;
  } catch {
    return undefined;
  }
});
const displayed = computed(() =>
  parsed.value !== undefined ? JSON.stringify(parsed.value, null, 2) : (text.value ?? ""),
);
const fields = computed(() =>
  props.named && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
    ? Object.entries(parsed.value as Record<string, unknown>)
    : undefined,
);
const matches = computed(() => {
  if (!query.value) return [];
  const source = displayed.value.toLocaleLowerCase(),
    needle = query.value.toLocaleLowerCase();
  const found: number[] = [];
  for (
    let offset = source.indexOf(needle);
    offset !== -1 && found.length < 10000;
    offset = source.indexOf(needle, offset + Math.max(1, needle.length))
  )
    found.push(offset);
  return found;
});
const windowStart = computed(() =>
  query.value && matches.value.length
    ? Math.max(0, (matches.value[matchIndex.value] ?? matches.value[0]!) - 400)
    : 0,
);
const preview = computed(() => displayed.value.slice(windowStart.value, windowStart.value + 24000));
const pieces = computed(() => {
  if (!query.value) return [{ text: preview.value, match: false }];
  const result: { text: string; match: boolean }[] = [];
  const lower = preview.value.toLocaleLowerCase(),
    needle = query.value.toLocaleLowerCase();
  let start = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, start)) {
    result.push(
      { text: preview.value.slice(start, at), match: false },
      { text: preview.value.slice(at, at + needle.length), match: true },
    );
    start = at + needle.length;
  }
  result.push({ text: preview.value.slice(start), match: false });
  return result;
});
watch(query, () => {
  matchIndex.value = 0;
});
watch(
  () =>
    `${props.identity.runId}/${props.identity.nodeId}/${props.identity.visit}/${content.value?.id ?? props.value.state}`,
  () => {
    version++;
    controller?.abort();
    text.value = undefined;
    error.value = "";
    notice.value = "";
    query.value = "";
    loading.value = false;
    if (opened.value) void load();
  },
);
async function load() {
  if (!content.value || isImage.value || text.value !== undefined || loading.value) return;
  const current = ++version;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = "";
  try {
    const value = await client.evidenceContent(
      props.identity.runId,
      props.identity.nodeId,
      props.identity.visit,
      content.value.id,
      controller.signal,
    );
    if (current === version) text.value = value;
  } catch (failure) {
    if (current === version && !controller.signal.aborted)
      error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (current === version) loading.value = false;
  }
}
function toggle(event: Event) {
  opened.value = (event.target as HTMLDetailsElement).open;
  if (opened.value) void load();
}
async function copy() {
  try {
    await navigator.clipboard.writeText(
      isImage.value ? new URL(url.value, location.href).href : (text.value ?? ""),
    );
    notice.value = isImage.value ? "Image link copied" : "Full stored value copied";
  } catch {
    notice.value = "Clipboard unavailable. Download the stored value instead.";
  }
}
function move(direction: number) {
  if (matches.value.length)
    matchIndex.value = (matchIndex.value + direction + matches.value.length) % matches.value.length;
}
function fieldText(value: unknown) {
  return JSON.stringify(value, null, 2) ?? "undefined";
}
function type(value: unknown) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}
onScopeDispose(() => {
  version++;
  controller?.abort();
});
</script>

<template>
  <details class="evidence-value" @toggle="toggle">
    <summary>
      <strong>{{ label }}</strong
      ><span>{{
        value.state === "captured"
          ? `Exact stored value · ${value.ref.bytes.toLocaleString()} bytes`
          : value.state === "undefined"
            ? "No value (undefined)"
            : "Unavailable"
      }}</span>
    </summary>
    <p v-if="value.state === 'undefined'" class="evidence-empty">
      This invocation did not supply a value. It is distinct from null or an empty object.
    </p>
    <p v-else-if="value.state === 'unavailable'" class="evidence-unavailable">
      {{ value.reason }}
    </p>
    <template v-else>
      <p v-if="loading" role="status">Loading the stored value…</p>
      <div v-if="error" class="evidence-unavailable" role="status">
        {{ error }} <button class="quiet" @click="load">Retry loading</button>
      </div>
      <template v-if="text !== undefined || isImage">
        <div class="evidence-actions">
          <button class="quiet" :aria-label="`Copy ${label}`" @click="copy">
            <Icon name="copy" :size="13" />{{
              isImage ? "Copy image link" : "Copy full value"
            }}</button
          ><a :href="downloadUrl" download><Icon name="download" :size="13" />Download</a
          ><span v-if="notice" role="status">{{ notice }}</span>
        </div>
        <img v-if="isImage && opened" :src="url" :alt="label" class="evidence-image" />
        <template v-else-if="!isImage">
          <div class="evidence-search">
            <input
              v-model="query"
              type="search"
              :aria-label="`Search ${label}`"
              placeholder="Search the full stored value…"
            /><span v-if="query">{{
              matches.length
                ? `${matchIndex + 1} of ${matches.length}${matches.length === 10000 ? "+" : ""}`
                : "No matches"
            }}</span
            ><button
              v-if="query"
              class="quiet"
              :disabled="!matches.length"
              :aria-label="`Previous match in ${label}`"
              @click="move(-1)"
            >
              Previous</button
            ><button
              v-if="query"
              class="quiet"
              :disabled="!matches.length"
              :aria-label="`Next match in ${label}`"
              @click="move(1)"
            >
              Next
            </button>
          </div>
          <p v-if="fields && fields.length > 50 && !query" class="evidence-preview-note">
            Showing the first 50 named fields of {{ fields.length }}. Search, copy and download
            include every field.
          </p>
          <div v-if="fields?.length && !query" class="evidence-fields">
            <section v-for="[name, fieldValue] in fields.slice(0, 50)" :key="name">
              <h4>
                {{ name }}<small>{{ type(fieldValue) }}</small>
              </h4>
              <pre>{{ fieldText(fieldValue).slice(0, 6000) }}</pre>
              <p v-if="fieldText(fieldValue).length > 6000">
                Field preview shortened. Search, copy or download to inspect the full fieldValue.
              </p>
            </section>
          </div>
          <template v-else
            ><p v-if="displayed.length > preview.length" class="evidence-preview-note">
              Preview: characters {{ windowStart + 1 }}–{{ windowStart + preview.length }} of
              {{ displayed.length.toLocaleString() }}. Search, copy and download use the full stored
              value.
            </p>
            <pre
              class="evidence-text"
            ><template v-for="(piece, index) in pieces" :key="index"><mark v-if="piece.match">{{ piece.text }}</mark><template v-else>{{ piece.text }}</template></template></pre>
          </template>
        </template>
      </template>
    </template>
  </details>
</template>

<style scoped>
.evidence-value {
  border: 1px solid var(--ui-edge);
  border-radius: 9px;
  padding: 12px;
  min-width: 0;
  margin: 10px 0;
}
summary {
  display: list-item;
  cursor: pointer;
  font-size: 12px;
}
summary strong {
  font-weight: 500;
}
summary > span {
  display: block;
  margin: 5px 0 0 14px;
  color: var(--muted);
  font-size: 10px;
}
p {
  font-size: 11px;
  margin: 12px 0 0;
}
.evidence-unavailable {
  color: var(--ctp-yellow);
  font-size: 12px;
}
.evidence-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.evidence-actions button,
.evidence-actions a {
  font-size: 10px;
  padding: 5px;
}
.evidence-actions a {
  color: var(--accent);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.evidence-actions > span {
  color: var(--muted);
  font-size: 10px;
}
.evidence-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.evidence-search input {
  flex: 1;
  min-width: 150px;
  font-size: 11px;
  padding: 7px 9px;
}
.evidence-search > span,
.evidence-search button {
  font-size: 10px;
}
pre {
  margin: 0;
  padding: 12px;
  background: var(--ctp-mantle);
  border-radius: 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
  line-height: 1.7;
  max-height: 480px;
  overflow: auto;
}
mark {
  color: var(--ctp-base);
  background: var(--ctp-yellow);
}
.evidence-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 10px;
}
.evidence-fields > section {
  min-width: 0;
}
h4 {
  font-size: 11px;
  font-weight: 600;
  margin: 4px 0 7px;
  overflow-wrap: anywhere;
}
h4 small {
  color: var(--muted);
  font-size: 10px;
  font-weight: 400;
  margin-left: 8px;
}
.evidence-preview-note {
  color: var(--muted);
  margin: 5px 0 8px;
}
.evidence-image {
  max-width: 100%;
  max-height: 480px;
  object-fit: contain;
}
</style>
