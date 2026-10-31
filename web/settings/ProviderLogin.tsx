import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import type { z } from "zod";
import {
  authOptionsSchema,
  authSessionSchema,
  type AuthSession,
} from "../../src/contracts/index.js";
import { request } from "../shared/api.js";
import Icon from "../shared/Icon.js";
import AuthLink from "../shared/AuthLink.js";

export interface ProviderLoginProps {
  onConnected: () => Promise<void>;
  chatgptConnected: boolean;
  loading: boolean;
}

export default function ProviderLogin({
  onConnected,
  chatgptConnected,
  loading,
}: ProviderLoginProps) {
  const [options, setOptions] = useState<z.infer<typeof authOptionsSchema>>([]);
  const [session, setSession] = useState<AuthSession | null>(null);
  const providerForm = useForm({
    defaultValues: { provider: "" },
    onSubmit: async ({ value }) => {
      if (value.provider) await start(value.provider, "api_key");
    },
  });
  const provider = useStore(providerForm.store, (state) => state.values.provider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const prompt = session?.prompt;
  const responseForm = useForm({
    formId: `provider-auth-${session?.id ?? "none"}-${prompt?.id ?? "none"}`,
    defaultValues: { answer: "" },
    onSubmit: async ({ value, formApi }) => {
      if (!value.answer || busy) return;
      formApi.reset();
      await respond(value.answer);
    },
  });
  const answer = useStore(responseForm.store, (state) => state.values.answer);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const connected = useEffectEvent(onConnected);

  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshed: string | undefined;
    async function poll() {
      const version = sequence.current;
      try {
        const value = await request("/api/auth/session", authSessionSchema.nullable(), {
          signal: active.signal,
        });
        if (active.signal.aborted || version !== sequence.current || version % 2 === 1) return;
        setSession(value);
        if (value?.status === "succeeded" && refreshed !== value.id) {
          refreshed = value.id;
          await connected();
        }
      } catch (failure) {
        if (!active.signal.aborted) setError(String(failure));
      } finally {
        if (!active.signal.aborted)
          timer = setTimeout(() => {
            void poll();
          }, 750);
      }
    }
    void request("/api/auth/options", authOptionsSchema, { signal: active.signal })
      .then((value) => {
        if (!active.signal.aborted) setOptions(value);
      })
      .catch((failure: unknown) => {
        if (!active.signal.aborted) setError(String(failure));
      });
    void poll();
    return () => {
      active.abort();
      clearTimeout(timer);
    };
  }, []);

  async function perform(action: (signal: AbortSignal) => Promise<AuthSession>) {
    const active = controller.current;
    if (!active || active.signal.aborted) return;
    sequence.current++;
    setBusy(true);
    setError("");
    try {
      const result = await action(active.signal);
      if (!active.signal.aborted) setSession(result);
    } catch (failure) {
      if (!active.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      sequence.current++;
      if (!active.signal.aborted) setBusy(false);
    }
  }
  function start(id: string, method: "oauth" | "api_key") {
    return perform((signal) =>
      request("/api/auth/session", authSessionSchema, {
        method: "POST",
        body: { provider: id, method },
        signal,
      }),
    );
  }
  const pending = session?.status === "pending";
  const promptOptions = prompt?.options;
  async function respond(answer: string) {
    if (!session || !prompt) return;
    const current = session;
    const question = prompt;
    await perform((signal) =>
      request(`/api/auth/session/${current.id}/respond`, authSessionSchema, {
        method: "POST",
        body: { promptId: question.id, value: answer },
        signal,
      }),
    );
  }
  function cancel() {
    if (!session) return;
    const current = session;
    responseForm.reset();
    void perform((signal) =>
      request(`/api/auth/session/${current.id}/cancel`, authSessionSchema, {
        method: "POST",
        body: {},
        signal,
      }),
    );
  }
  const eventOccurrences = new Map<string, number>();
  return (
    <div className="provider-login">
      {chatgptConnected ? (
        <div className="chatgpt-connected">
          <Icon name="check" size={22} />
          <div>
            <strong>ChatGPT connected</strong>
            <small>Your account is ready to use.</small>
          </div>
        </div>
      ) : (
        !loading && (
          <div className="chatgpt-login">
            <h3>ChatGPT</h3>
            <p>Connect your ChatGPT account to use eligible models with your plan.</p>
            <button
              className="primary"
              disabled={
                busy ||
                pending ||
                !options.some((item) => item.id === "openai" && item.methods.includes("oauth"))
              }
              onClick={() => void start("openai", "oauth")}
            >
              Continue with ChatGPT
            </button>
          </div>
        )
      )}
      <details className="api-key-setup">
        <summary>Use an API key</summary>
        <label htmlFor="api-key-provider">API-key provider</label>
        <select
          id="api-key-provider"
          value={provider}
          disabled={busy || pending}
          onChange={(event) => providerForm.setFieldValue("provider", event.target.value)}
        >
          <option value="">Choose a provider</option>
          {options
            .filter((item) => item.methods.includes("api_key"))
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
        <button
          disabled={busy || pending || !provider}
          onClick={() => void providerForm.handleSubmit()}
        >
          Connect with API key
        </button>
      </details>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {session && session.status !== "succeeded" && (
        <div className="auth-session" aria-label="Provider sign-in">
          {pending &&
            session.events.map((event) => {
              const identity = JSON.stringify(event);
              const occurrence = eventOccurrences.get(identity) ?? 0;
              eventOccurrences.set(identity, occurrence + 1);
              const links = event.type === "info" ? event.links : undefined;
              return (
                <div key={`${session.id}:${identity}:${occurrence}`}>
                  {event.type === "auth_url" ? (
                    <>
                      <AuthLink url={event.url}>Open ChatGPT sign-in</AuthLink>
                      <p>{event.instructions}</p>
                    </>
                  ) : event.type === "device_code" ? (
                    <>
                      <p>
                        Enter code <code>{event.userCode}</code>
                      </p>
                      <AuthLink url={event.verificationUri}>Open verification page</AuthLink>
                    </>
                  ) : (
                    <>
                      <p>{event.message}</p>
                      {links?.map((link) => (
                        <AuthLink key={link.url} url={link.url}>
                          {link.label ?? "Open provider page"}
                        </AuthLink>
                      ))}
                    </>
                  )}
                </div>
              );
            })}
          {prompt && pending && (
            <form
              key={prompt.id}
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void responseForm.handleSubmit();
              }}
            >
              <label htmlFor="auth-answer">{prompt.message}</label>
              {prompt.type === "select" ? (
                <select
                  id="auth-answer"
                  value={answer}
                  onChange={(event) => responseForm.setFieldValue("answer", event.target.value)}
                  disabled={busy}
                  required
                >
                  <option value="">Choose an option</option>
                  {promptOptions?.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="auth-answer"
                  value={answer}
                  onChange={(event) => responseForm.setFieldValue("answer", event.target.value)}
                  type={prompt.type === "text" ? "text" : "password"}
                  disabled={busy}
                  placeholder={prompt.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              )}
              <button type="submit" disabled={busy || !answer}>
                Continue sign-in
              </button>
            </form>
          )}
          {pending ? (
            <>
              {!prompt && <p role="status">Waiting for the provider…</p>}
              <button disabled={busy} onClick={cancel}>
                Cancel sign-in
              </button>
            </>
          ) : (
            <p role="status">{session.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
