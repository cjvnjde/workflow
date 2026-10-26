<script setup lang="ts">
import {
  computed,
  onMounted,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
} from "vue";
import type { z } from "zod";
import {
  authOptionsSchema,
  authSessionSchema,
  type AuthSession,
} from "../../src/contracts.js";
import { request } from "../api.js";
import Icon from "../components/Icon.vue";
import AuthLink from "../components/AuthLink.vue";
const props = defineProps<{
  onConnected: () => Promise<void>;
  chatgptConnected: boolean;
  loading: boolean;
}>();
const options = shallowRef<z.infer<typeof authOptionsSchema>>([]);
const session = shallowRef<AuthSession | null>(null);
const provider = ref("");
const answer = ref("");
const busy = ref(false);
const error = ref("");
let refreshed: string | undefined;
let sequence = 0;
let timer: ReturnType<typeof setTimeout>;
const controller = new AbortController();
async function poll() {
  const version = sequence;
  try {
    const value = await request(
      "/api/auth/session",
      authSessionSchema.nullable(),
      { signal: controller.signal },
    );
    if (
      controller.signal.aborted ||
      version !== sequence ||
      version % 2 === 1
    ) {
      return;
    }
    session.value = value;
    if (value?.status === "succeeded" && refreshed !== value.id) {
      refreshed = value.id;
      await props.onConnected();
    }
  } catch (failure) {
    if (!controller.signal.aborted) {
      error.value = String(failure);
    }
  } finally {
    if (!controller.signal.aborted) {
      timer = setTimeout(() => {
        void poll();
      }, 750);
    }
  }
}
onMounted(() => {
  void request("/api/auth/options", authOptionsSchema, {
    signal: controller.signal,
  })
    .then((value) => {
      options.value = value;
    })
    .catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        error.value = String(failure);
      }
    });
  void poll();
});
onScopeDispose(() => {
  controller.abort();
  clearTimeout(timer);
  answer.value = "";
});
watch(
  () => session.value?.prompt?.id,
  () => {
    answer.value = "";
  },
);
async function perform(action: () => Promise<AuthSession>) {
  sequence++;
  busy.value = true;
  error.value = "";
  try {
    const result = await action();
    if (!controller.signal.aborted) {
      session.value = result;
    }
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    sequence++;
    busy.value = false;
  }
}
function start(id: string, method: "oauth" | "api_key") {
  void perform(() =>
    request("/api/auth/session", authSessionSchema, {
      method: "POST",
      body: { provider: id, method },
    }),
  );
}
const pending = computed(() => session.value?.status === "pending");
const prompt = computed(() => session.value?.prompt);
function respond() {
  const current = session.value;
  const question = prompt.value;
  const value = answer.value;
  if (!current || !question) {
    return;
  }
  answer.value = "";
  void perform(() =>
    request(`/api/auth/session/${current.id}/respond`, authSessionSchema, {
      method: "POST",
      body: { promptId: question.id, value },
    }),
  );
}
function cancel() {
  const current = session.value;
  if (!current) {
    return;
  }
  answer.value = "";
  void perform(() =>
    request(`/api/auth/session/${current.id}/cancel`, authSessionSchema, {
      method: "POST",
      body: {},
    }),
  );
}
</script>

<template>
  <div class="provider-login">
    <div v-if="chatgptConnected" class="chatgpt-connected">
      <Icon name="check" :size="22" />
      <div>
        <strong>ChatGPT connected</strong
        ><small>Your account is ready to use.</small>
      </div>
    </div>
    <div v-else-if="!loading" class="chatgpt-login">
      <h3>ChatGPT</h3>
      <p>Connect your ChatGPT account to use eligible models with your plan.</p>
      <button
        class="primary"
        :disabled="
          busy ||
          pending ||
          !options.some(
            (item) => item.id === 'openai' && item.methods.includes('oauth'),
          )
        "
        @click="start('openai', 'oauth')"
      >
        Continue with ChatGPT
      </button>
    </div>
    <details class="api-key-setup">
      <summary>Use an API key</summary>
      <label for="api-key-provider">API-key provider</label
      ><select
        id="api-key-provider"
        v-model="provider"
        :disabled="busy || pending"
      >
        <option value="">Choose a provider</option>
        <option
          v-for="item in options.filter((item) =>
            item.methods.includes('api_key'),
          )"
          :key="item.id"
          :value="item.id"
        >
          {{ item.name }}
        </option></select
      ><button
        :disabled="busy || pending || !provider"
        @click="start(provider, 'api_key')"
      >
        Connect with API key
      </button>
    </details>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div
      v-if="session && session.status !== 'succeeded'"
      class="auth-session"
      aria-label="Provider sign-in"
    >
      <template v-if="pending"
        ><div v-for="(event, index) in session.events" :key="index">
          <template v-if="event.type === 'auth_url'"
            ><AuthLink :url="event.url">Open ChatGPT sign-in</AuthLink>
            <p>{{ event.instructions }}</p></template
          >
          <template v-else-if="event.type === 'device_code'"
            ><p>
              Enter code <code>{{ event.userCode }}</code>
            </p>
            <AuthLink :url="event.verificationUri"
              >Open verification page</AuthLink
            ></template
          >
          <template v-else
            ><p>{{ event.message }}</p>
            <template v-if="event.type === 'info'"
              ><AuthLink
                v-for="link in event.links"
                :key="link.url"
                :url="link.url"
                >{{ link.label ?? "Open provider page" }}</AuthLink
              ></template
            ></template
          >
        </div></template
      >
      <form v-if="prompt && pending" :key="prompt.id" @submit.prevent="respond">
        <label for="auth-answer">{{ prompt.message }}</label>
        <select
          v-if="prompt.type === 'select'"
          id="auth-answer"
          v-model="answer"
          :disabled="busy"
          required
        >
          <option value="">Choose an option</option>
          <option
            v-for="option in prompt.options"
            :key="option.id"
            :value="option.id"
          >
            {{ option.label }}
          </option>
        </select>
        <input
          v-else
          id="auth-answer"
          v-model="answer"
          :type="prompt.type === 'text' ? 'text' : 'password'"
          :disabled="busy"
          :placeholder="prompt.placeholder"
          autocomplete="off"
          :spellcheck="false"
          required
        />
        <button type="submit" :disabled="busy || !answer">
          Continue sign-in
        </button>
      </form>
      <template v-if="pending"
        ><p v-if="!prompt" role="status">Waiting for the provider…</p>
        <button :disabled="busy" @click="cancel">
          Cancel sign-in
        </button></template
      >
      <p v-else role="status">{{ session.message }}</p>
    </div>
  </div>
</template>
