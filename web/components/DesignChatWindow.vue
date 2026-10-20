<script setup lang="ts">
import {
  computed,
  onMounted,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
} from "vue";
import {
  designScopes,
  designSessionSchema,
  type DesignSession,
} from "../../src/design-schema.js";
import { request } from "../api.js";
import Icon from "./Icon.vue";
import ProposalPreview from "./ProposalPreview.vue";
import MarkdownView from "./MarkdownView.vue";
import {
  resizeWindow,
  type WindowPoint,
  type WindowSize,
} from "../floating-window.js";
const props = defineProps<{
  initial: DesignSession;
  draft: string;
  minimized: boolean;
  focused: boolean;
  position: { x: number; y: number };
  size: WindowSize;
  layer: number;
  hasUnsavedSettings: boolean;
  applyingElsewhere: boolean;
  onApplied: () => Promise<void>;
}>();
const emit = defineEmits<{
  update: [value: DesignSession];
  draft: [value: string];
  move: [value: { x: number; y: number }];
  resize: [value: { size: WindowSize; position: WindowPoint }];
  new: [];
  minimize: [];
  close: [];
  focus: [];
  applyingChange: [value: boolean];
}>();
const session = shallowRef(props.initial);
const message = computed({
  get: () => props.draft,
  set: (value) => emit("draft", value),
});
const label = computed(() => designScopes[session.value.scope]);
const working = computed(() => session.value.status === "working");
const loading = false;
const busy = ref(false);
const error = ref("");
const input = ref<HTMLTextAreaElement>();
const conversation = ref<HTMLDivElement>();
const controller = new AbortController();
onScopeDispose(() => controller.abort());
function accept(value: DesignSession) {
  if (controller.signal.aborted || value.revision < session.value.revision)
    return;
  session.value = value;
  emit("update", value);
}
watch(
  working,
  (active, _old, onCleanup) => {
    if (!active) return;
    const pollController = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const loaded = await request(
          `/api/design/${session.value.id}`,
          designSessionSchema,
          { signal: pollController.signal },
        );
        if (!pollController.signal.aborted) accept(loaded);
      } catch (failure) {
        if (!pollController.signal.aborted) error.value = String(failure);
      } finally {
        if (!pollController.signal.aborted)
          timer = setTimeout(() => {
            void refresh();
          }, 700);
      }
    }
    void refresh();
    onCleanup(() => {
      pollController.abort();
      clearTimeout(timer);
    });
  },
  { immediate: true },
);
onMounted(() => {
  if (conversation.value)
    conversation.value.scrollTop = conversation.value.scrollHeight;
  if (props.focused && !props.minimized && !working.value) input.value?.focus();
});
watch(
  [() => props.minimized, working],
  () => {
    if (props.focused && !props.minimized && !working.value)
      input.value?.focus();
  },
  { flush: "post" },
);
watch(
  [() => session.value.messages.length, working],
  () => {
    if (conversation.value)
      conversation.value.scrollTop = conversation.value.scrollHeight;
  },
  { flush: "post" },
);
async function perform(action: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (failure) {
    if (!controller.signal.aborted)
      error.value =
        failure instanceof Error ? failure.message : String(failure);
  } finally {
    busy.value = false;
  }
}
async function send() {
  const content = message.value.trim();
  const current = session.value;
  if (!content || working.value || busy.value) return;
  await perform(async () => {
    accept(
      await request(`/api/design/${current.id}/messages`, designSessionSchema, {
        method: "POST",
        body: { message: content, revision: current.revision },
        signal: controller.signal,
      }),
    );
    if (message.value.trim() === content) message.value = "";
  });
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}
function apply() {
  if (props.hasUnsavedSettings || props.applyingElsewhere || busy.value) return;
  void perform(async () => {
    emit("applyingChange", true);
    try {
      accept(
        await request(
          `/api/design/${session.value.id}/apply`,
          designSessionSchema,
          {
            method: "POST",
            body: { revision: session.value.revision },
            signal: controller.signal,
          },
        ),
      );
      await props.onApplied();
    } finally {
      emit("applyingChange", false);
    }
  });
}
function stop() {
  void perform(async () =>
    accept(
      await request(
        `/api/design/${session.value.id}/cancel`,
        designSessionSchema,
        {
          method: "POST",
          body: {},
          signal: controller.signal,
        },
      ),
    ),
  );
}
function discardProposal() {
  void perform(async () =>
    accept(
      await request(
        `/api/design/${session.value.id}/discard`,
        designSessionSchema,
        {
          method: "POST",
          body: { revision: session.value.revision },
          signal: controller.signal,
        },
      ),
    ),
  );
}
let origin:
  | { pointer: number; x: number; y: number; left: number; top: number }
  | undefined;
function startDrag(event: PointerEvent) {
  if (event.button !== 0 || (event.target as Element).closest("button")) return;
  origin = {
    pointer: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: props.position.x,
    top: props.position.y,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}
function drag(event: PointerEvent) {
  if (origin?.pointer !== event.pointerId) return;
  emit("move", {
    x: origin.left + event.clientX - origin.x,
    y: origin.top + event.clientY - origin.y,
  });
}
function endDrag() {
  origin = undefined;
}
function moveWithKeys(event: KeyboardEvent) {
  if (event.target !== event.currentTarget || !event.key.startsWith("Arrow"))
    return;
  event.preventDefault();
  emit("move", {
    x:
      props.position.x +
      (event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0),
    y:
      props.position.y +
      (event.key === "ArrowDown" ? 20 : event.key === "ArrowUp" ? -20 : 0),
  });
}
let resizing:
  | {
      pointer: number;
      x: number;
      y: number;
      size: WindowSize;
      position: WindowPoint;
      left: boolean;
    }
  | undefined;
function startResize(event: PointerEvent, left: boolean) {
  if (event.button !== 0) return;
  resizing = {
    pointer: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    size: { ...props.size },
    position: { ...props.position },
    left,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}
function resize(event: PointerEvent) {
  if (resizing?.pointer !== event.pointerId) return;
  emit(
    "resize",
    resizeWindow(
      resizing.size,
      resizing.position,
      { x: event.clientX - resizing.x, y: event.clientY - resizing.y },
      resizing.left,
      { width: window.innerWidth, height: window.innerHeight },
    ),
  );
}
function resizeWithKeys(event: KeyboardEvent, left: boolean) {
  if (!event.key.startsWith("Arrow")) return;
  event.preventDefault();
  emit(
    "resize",
    resizeWindow(
      props.size,
      props.position,
      {
        x:
          event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0,
        y: event.key === "ArrowDown" ? 20 : event.key === "ArrowUp" ? -20 : 0,
      },
      left,
      { width: window.innerWidth, height: window.innerHeight },
    ),
  );
}
</script>

<template>
  <section
    v-show="!minimized"
    class="design-chat"
    :style="{
      left: `${position.x}px`,
      top: `${position.y}px`,
      width: `${size.width}px`,
      height: `${size.height}px`,
      zIndex: layer,
      '--chat-compose-max': `${Math.floor(size.height * 0.25)}px`,
    }"
    :id="`design-${session.id}`"
    @pointerdown="emit('focus')"
    role="dialog"
    :aria-label="`Design ${label.title.toLowerCase()} with AI`"
    @keydown.esc="emit('minimize')"
  >
    <header
      class="design-chat-heading"
      tabindex="0"
      aria-label="Move chat window with arrow keys or drag"
      @pointerdown="startDrag"
      @pointermove="drag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @keydown="moveWithKeys"
    >
      <span class="design-avatar"><Icon name="spark" :size="18" /></span>
      <div>
        <strong>Design with AI</strong><small>{{ label.title }}</small>
      </div>
      <button
        class="icon-button"
        aria-label="New design conversation"
        title="New conversation"
        :disabled="false"
        @click="emit('new')"
      >
        <Icon name="plus" :size="17" /></button
      ><button
        class="icon-button"
        aria-label="Minimize design chat"
        @click="emit('minimize')"
      >
        <Icon name="minus" :size="17" />
      </button>
      <button
        class="icon-button"
        aria-label="Close design chat"
        :disabled="busy"
        @click="emit('close')"
      >
        <Icon name="close" :size="17" />
      </button>
    </header>
    <div
      ref="conversation"
      class="design-conversation"
      aria-label="Design conversation"
      aria-live="polite"
    >
      <div class="design-intro">
        <Icon name="spark" :size="22" />
        <h3>Let’s shape {{ label.title.toLowerCase() }}</h3>
        <p>
          {{ label.description }} Describe what you want, then refine it
          together.
        </p>
        <small>Changes are saved when you apply a proposal.</small>
      </div>
      <p v-if="loading" class="design-progress" role="status">
        <span class="spinner" />Opening conversation…
      </p>
      <template v-else
        ><article
          v-for="(entry, index) in session?.messages"
          :key="`${session?.id}-${index}`"
          class="design-message"
          :class="entry.role"
        >
          <span>{{ entry.role === "user" ? "You" : "AI designer" }}</span>
          <MarkdownView :content="entry.content" /></article
      ></template>
      <div v-if="working" class="design-progress" role="status">
        <span class="spinner" />
        <div>
          <strong>Designing {{ label.title.toLowerCase() }}…</strong
          ><small>{{ session?.activity.slice(0, 160) }}</small>
          <details v-if="session?.text">
            <summary>Live response</summary>
            <MarkdownView :content="session.text" />
          </details>
        </div>
      </div>
      <div
        v-if="!loading && !working && session?.proposal"
        class="design-proposal"
      >
        <div class="design-proposal-title">
          <Icon
            :name="session.status === 'applied' ? 'check' : 'workflow'"
            :size="17"
          /><strong>{{
            session.status === "applied"
              ? "Changes applied"
              : "Proposed changes"
          }}</strong>
        </div>
        <p>{{ session.proposal.summary }}</p>
        <ProposalPreview :proposal="session.proposal" />
        <template v-if="session.status === 'ready'"
          ><button
            class="primary"
            :disabled="busy || hasUnsavedSettings || applyingElsewhere"
            @click="apply"
          >
            <Icon name="check" :size="16" />Apply changes
          </button>
          <button :disabled="busy" @click="discardProposal">
            Discard proposal
          </button>
          <p v-if="hasUnsavedSettings" class="muted">
            Save or discard your form edits before applying this proposal.
          </p></template
        >
      </div>
      <div v-if="error || session?.error" class="inline-error" role="alert">
        {{ error || session?.error }}
      </div>
    </div>
    <form class="design-compose" @submit.prevent="send">
      <textarea
        v-autosize="8"
        ref="input"
        v-model="message"
        aria-label="Message AI designer"
        :placeholder="
          session?.messages.length
            ? 'Refine the proposal, or ask a question…'
            : label.placeholder
        "
        :disabled="loading || busy || working"
        :rows="3"
        :maxlength="8000"
        @keydown="keydown"
      />
      <div>
        <small>Enter to send · Shift + Enter for a new line</small
        ><button
          v-if="!working && message"
          type="button"
          :disabled="busy"
          @click="message = ''"
        >
          Discard message</button
        ><button v-if="working" type="button" :disabled="busy" @click="stop">
          Stop</button
        ><button
          v-else
          type="submit"
          class="primary"
          aria-label="Send to AI designer"
          :disabled="loading || busy || !session || !message.trim()"
        >
          <Icon name="arrow" :size="17" />
        </button>
      </div>
    </form>
    <button
      v-for="edge in ['left', 'right']"
      :key="edge"
      type="button"
      class="chat-resize-handle"
      :class="edge"
      :aria-label="`Resize chat from bottom ${edge}`"
      title="Drag to resize · Arrow keys to adjust"
      @pointerdown="startResize($event, edge === 'left')"
      @pointermove="resize"
      @pointerup="resizing = undefined"
      @pointercancel="resizing = undefined"
      @keydown="resizeWithKeys($event, edge === 'left')"
    />
  </section>
</template>
