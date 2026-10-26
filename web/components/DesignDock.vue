<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import {
  designScopes,
  designSessionSchema,
  type DesignScope,
  type DesignSession,
  type DesignPageContext,
} from "../../src/contracts.js";
import type { DesignRequest } from "../design-types.js";
import { request } from "../api.js";
import Icon from "./Icon.vue";
import DesignChatWindow from "./DesignChatWindow.vue";
import {
  defaultChatSize,
  fitWindow,
  type WindowSize,
  type WindowPoint,
} from "../floating-window.js";
const props = defineProps<{
  pageContext: DesignPageContext;
  requested?: DesignRequest;
  hasUnsavedSettings: boolean;
  onApplied: () => Promise<void>;
}>();
const emit = defineEmits<{
  applyingChange: [value: boolean];
  chatsChange: [count: number];
}>();
type Chat = {
  session: DesignSession;
  draft: string;
  minimized: boolean;
  position: { x: number; y: number };
  size: WindowSize;
  layer: number;
};
const chats = ref<Chat[]>([]);
watch(
  () => chats.value.length,
  (count) => emit("chatsChange", count),
  { immediate: true },
);
const focusedId = computed(
  () =>
    chats.value
      .filter((chat) => !chat.minimized)
      .sort((a, b) => b.layer - a.layer)[0]?.session.id,
);
const error = ref("");
const opening = ref(0);
const applying = ref(new Set<string>());
const controller = new AbortController();
let layer = 40;
const storageKey = "workflow:design-windows:v2";
const pending = new Map<DesignScope, Promise<void>>();
function bounds(size: WindowSize, point: WindowPoint) {
  return fitWindow(size, point, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}
function persist() {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(
        chats.value.map((c) => ({
          id: c.session.id,
          draft: c.draft,
          minimized: c.minimized,
          position: c.position,
          size: c.size,
        })),
      ),
    );
  } catch {
    /* Optional local window layout. */
  }
}
function focus(chat: Chat) {
  chat.layer = ++layer;
}
function show(chat: Chat) {
  chat.minimized = false;
  focus(chat);
  persist();
}
function add(session: DesignSession, draft = "", saved?: Partial<Chat>) {
  if (controller.signal.aborted) return;
  const existing = chats.value.find((c) => c.session.id === session.id);
  if (existing) {
    if (saved) return; // A late restoration must not replace a draft the user is already editing.
    show(existing);
    if (draft) existing.draft = draft;
    return;
  }
  const offset = (chats.value.length % 3) * 48;
  chats.value.push({
    session,
    draft,
    minimized: saved?.minimized ?? false,
    layer: ++layer,
    ...bounds(
      saved?.size ?? defaultChatSize,
      saved?.position ?? {
        x: window.innerWidth - 464 - offset,
        y: window.innerHeight - 764 + offset,
      },
    ),
  });
  persist();
}
async function open(scope: DesignScope, fresh = false, prompt?: string) {
  if (!fresh) {
    const existing = chats.value.findLast((c) => c.session.scope === scope);
    if (existing) {
      if (prompt) existing.draft = prompt;
      show(existing);
      return;
    }
    if (pending.has(scope)) {
      await pending.get(scope);
      if (prompt) {
        const found = chats.value.findLast((c) => c.session.scope === scope);
        if (found) found.draft = prompt;
      }
      return;
    }
  }
  const job = (async () => {
    opening.value++;
    error.value = "";
    try {
      const latest = fresh
        ? null
        : await request(
            `/api/design/${scope}/latest`,
            designSessionSchema.nullable(),
            { signal: controller.signal },
          );
      const session =
        latest ??
        (await request("/api/design", designSessionSchema, {
          method: "POST",
          body: { scope },
          signal: controller.signal,
        }));
      add(session, prompt);
    } catch (failure) {
      if (!controller.signal.aborted)
        error.value =
          failure instanceof Error ? failure.message : String(failure);
    } finally {
      opening.value--;
    }
  })();
  if (!fresh) pending.set(scope, job);
  await job;
  if (pending.get(scope) === job) pending.delete(scope);
}
watch(
  () => props.requested,
  (value) => {
    if (value) void open(value.scope, false, value.prompt);
  },
  { immediate: true },
);
function move(chat: Chat, point: { x: number; y: number }) {
  chat.position = bounds(chat.size, point).position;
  persist();
}
function resizeChat(
  chat: Chat,
  geometry: { size: WindowSize; position: WindowPoint },
) {
  Object.assign(chat, bounds(geometry.size, geometry.position));
  persist();
}
function minimize(chat: Chat) {
  chat.minimized = !chat.minimized;
  if (!chat.minimized) focus(chat);
  persist();
}
function close(chat: Chat) {
  if (applying.value.has(chat.session.id)) return;
  chats.value = chats.value.filter((c) => c !== chat);
  persist();
}
function applyingChange(chat: Chat, value: boolean) {
  if (value) applying.value.add(chat.session.id);
  else applying.value.delete(chat.session.id);
  emit("applyingChange", applying.value.size > 0);
}
function resize() {
  chats.value.forEach((chat) => {
    Object.assign(chat, bounds(chat.size, chat.position));
  });
  persist();
}
onMounted(async () => {
  window.addEventListener("resize", resize);
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
  } catch {
    return;
  }
  if (!Array.isArray(saved)) return;
  for (const item of saved) {
    if (!item || typeof item.id !== "string" || !/^[\w-]+$/.test(item.id))
      continue;
    try {
      const session = await request(
        `/api/design/${item.id}`,
        designSessionSchema,
        { signal: controller.signal },
      );
      const position =
        item.position &&
        Number.isFinite(item.position.x) &&
        Number.isFinite(item.position.y)
          ? item.position
          : undefined;
      const size =
        item.size &&
        Number.isFinite(item.size.width) &&
        Number.isFinite(item.size.height)
          ? item.size
          : undefined;
      add(
        session,
        typeof item.draft === "string" ? item.draft.slice(0, 8000) : "",
        { minimized: Boolean(item.minimized), position, size },
      );
    } catch {
      /* Closed servers or deleted sessions must not block the workspace. */
    }
  }
});
onScopeDispose(() => {
  controller.abort();
  window.removeEventListener("resize", resize);
});
</script>

<template>
  <div class="design-dock">
    <DesignChatWindow
      v-for="chat in chats"
      :key="chat.session.id"
      :initial="chat.session"
      :page-context="pageContext"
      :draft="chat.draft"
      :position="chat.position"
      :size="chat.size"
      :layer="chat.layer"
      :minimized="chat.minimized"
      :focused="focusedId === chat.session.id"
      :has-unsaved-settings="hasUnsavedSettings"
      :on-applied="onApplied"
      :applying-elsewhere="applying.size > 0"
      @update="chat.session = $event"
      @draft="
        chat.draft = $event;
        persist();
      "
      @move="move(chat, $event)"
      @resize="resizeChat(chat, $event)"
      @focus="focus(chat)"
      @new="open(chat.session.scope, true)"
      @minimize="minimize(chat)"
      @close="close(chat)"
      @applying-change="applyingChange(chat, $event)"
    />
    <div v-if="opening" class="dock-status" role="status">
      <span class="spinner" />Opening conversation…
    </div>
    <div v-if="error" class="inline-error" role="alert">
      {{ error }}<button @click="error = ''">Dismiss</button>
    </div>
    <div v-if="chats.length" class="design-launchers" aria-label="Design chats">
      <button
        v-for="chat in chats"
        :key="chat.session.id"
        :class="{ active: !chat.minimized }"
        :aria-expanded="!chat.minimized"
        :aria-label="
          designScopes[chat.session.scope].title +
          (chats
            .filter((c) => c.session.scope === chat.session.scope)
            .indexOf(chat)
            ? ` ${chats.filter((c) => c.session.scope === chat.session.scope).indexOf(chat) + 1}`
            : '')
        "
        :title="
          chat.session.messages.find((m) => m.role === 'user')?.content ??
          designScopes[chat.session.scope].title
        "
        @click="focusedId === chat.session.id ? minimize(chat) : show(chat)"
      >
        <Icon name="spark" :size="15" /><span
          >{{ designScopes[chat.session.scope].title
          }}<small v-if="chat.session.messages.length">{{
            chat.session.messages
              .find((m) => m.role === "user")
              ?.content.slice(0, 28)
          }}</small></span
        >
        <span v-if="chat.session.status === 'working'" class="spinner" />
      </button>
    </div>
  </div>
</template>
