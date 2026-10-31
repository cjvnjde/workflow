import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { z } from "zod";
import {
  resolveAgentSettings,
  modelCatalogSchema,
  modelKey,
  setupSchema,
  type AgentSettings,
  type AvailableModel,
  type Setup,
} from "../../src/contracts/index.js";
import { request } from "../shared/api.js";
import ProviderLogin from "./ProviderLogin.js";

export interface ModelSettingsHandle {
  discard: () => void;
}
export interface ModelSettingsProps {
  onSaved: () => Promise<void>;
  onBusy?: (value: boolean) => void;
  onDirty?: (value: boolean) => void;
  ref?: Ref<ModelSettingsHandle>;
}
interface ModelForm {
  setup?: Setup;
  selection: string;
  thinking: AgentSettings["thinking"];
}
function hasChanges(form: ModelForm) {
  if (!form.setup) return false;
  const saved = resolveAgentSettings(form.setup.userAgent, form.setup.projectAgent);
  const key =
    saved.provider && saved.model ? modelKey({ provider: saved.provider, id: saved.model }) : "";
  return form.selection !== key || form.thinking !== saved.thinking;
}
function setupForm(setup: Setup): ModelForm {
  const agent = resolveAgentSettings(setup.userAgent, setup.projectAgent);
  return {
    setup,
    selection:
      agent.provider && agent.model ? modelKey({ provider: agent.provider, id: agent.model }) : "",
    thinking: agent.thinking,
  };
}

export default function ModelSettings({ onSaved, onBusy, onDirty, ref }: ModelSettingsProps) {
  const [initialValues] = useState<ModelForm>({ selection: "", thinking: "medium" });
  const form = useForm({
    defaultValues: initialValues,
    onSubmitMeta: { inherit: false },
    onSubmit: async ({ value, meta }) => {
      await perform((signal) => save(value, meta.inherit, signal));
    },
  });
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const values = useStore(form.store, (state) => state.values);
  const { setup, selection, thinking } = values;
  const dirty = hasChanges(values);
  const model = models.find((item) => modelKey(item) === selection);
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy?.(busy);
  }, [busy, onBusy]);
  useEffect(
    () => () => {
      onBusy?.(false);
      onDirty?.(false);
    },
    [onBusy, onDirty],
  );

  const resetForm = useCallback(
    (value: ModelForm) => form.reset(value, { keepDefaultValues: true }),
    [form],
  );
  function acceptSetup(value: Setup, preserveEdits = false) {
    const current = form.state.values;
    if (preserveEdits && hasChanges(current)) {
      form.setFieldValue("setup", value);
    } else {
      resetForm(setupForm(value));
    }
  }
  function discard() {
    if (busy || !setup) return;
    resetForm(setupForm(setup));
    setError("");
    setNotice("");
  }
  useImperativeHandle(ref, () => ({ discard }));

  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    void Promise.all([
      request("/api/setup", setupSchema, { signal: active.signal }),
      request("/api/models", modelCatalogSchema, { signal: active.signal }),
    ])
      .then(([value, catalog]) => {
        if (active.signal.aborted) return;
        resetForm(setupForm(value));
        setModels(catalog.models);
        setWarnings(catalog.warnings);
      })
      .catch((failure: unknown) => {
        if (!active.signal.aborted) setError(String(failure));
      });
    return () => active.abort();
  }, [resetForm]);

  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    const active = controller.current;
    if (!active || active.signal.aborted) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action(active.signal);
    } catch (failure) {
      if (!active.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!active.signal.aborted) setBusy(false);
    }
  }
  async function save(values: ModelForm, inherit: boolean, signal: AbortSignal) {
    const { setup, selection, thinking } = values;
    const selected = models.find((item) => modelKey(item) === selection);
    if (!setup || (!inherit && (!selected || !selected.thinkingLevels.includes(thinking)))) return;
    const updated = await request("/api/project/model", setupSchema, {
      method: "PUT",
      body: {
        configRevision: setup.configRevision,
        agent: inherit ? null : { provider: selected!.provider, model: selected!.id, thinking },
      },
      signal,
    });
    if (signal.aborted) return;
    acceptSetup(updated);
    await onSaved();
    if (!signal.aborted)
      setNotice(
        "Project defaults saved. New workflow proposals will use these settings; existing drafts and runs keep their saved models.",
      );
  }
  async function refresh(signal: AbortSignal) {
    const catalog = await request("/api/models/refresh", modelCatalogSchema, {
      method: "POST",
      body: {},
      signal,
    });
    if (signal.aborted) return;
    setModels(catalog.models);
    setWarnings(catalog.warnings);
    const updated = await request("/api/setup", setupSchema, { signal });
    if (signal.aborted) return;
    acceptSetup(updated, true);
    await onSaved();
  }
  function disconnect(provider: Setup["providers"][number]) {
    if (
      !window.confirm(
        `Remove saved credentials for ${provider.name}? Existing runs using this provider may need you to sign in again.`,
      )
    )
      return;
    void perform(async (signal) => {
      await request(
        `/api/auth/providers/${encodeURIComponent(provider.id)}/logout`,
        z.object({ removed: z.boolean() }),
        { method: "POST", body: {}, signal },
      );
      const updated = await request("/api/setup", setupSchema, { signal });
      if (signal.aborted) return;
      acceptSetup(updated, true);
      const catalog = await request("/api/models", modelCatalogSchema, { signal });
      if (signal.aborted) return;
      setModels(catalog.models);
      setWarnings(catalog.warnings);
      await onSaved();
      if (!signal.aborted)
        setNotice("Saved credentials removed. Provider-side access has not been revoked.");
    });
  }
  function choose(value: string) {
    const selected = models.find((item) => modelKey(item) === value);
    const thinking = form.state.values.thinking;
    form.setFieldValue("selection", value);
    if (selected && !selected.thinkingLevels.includes(thinking)) {
      form.setFieldValue(
        "thinking",
        (selected.thinkingLevels.includes("off")
          ? "off"
          : (selected.thinkingLevels[0] ?? "off")) as AgentSettings["thinking"],
      );
    }
  }
  return (
    <section className="model-settings" aria-labelledby="setup-title">
      <div className="eyebrow">PROJECT SETUP</div>
      <h1 id="setup-title">Providers &amp; models</h1>
      <p>
        Start with ChatGPT, or connect another provider using an API key. Choose a default model to
        plan new requests and generate your project library.
      </p>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="setup-notice" role="status">
          {notice}
        </div>
      )}
      <div className="setup-grid">
        <section className="setup-card">
          <h2>Provider connections</h2>
          <ProviderLogin
            loading={!setup}
            chatgptConnected={
              !!setup?.providers.some(
                (provider) => provider.id === "openai" && provider.method === "oauth",
              )
            }
            onConnected={() => perform(refresh)}
          />
          {!setup ? (
            <p role="status">Loading provider status…</p>
          ) : setup.providers.length ? (
            <ul className="provider-list">
              {setup.providers.map((provider) => (
                <li key={provider.id}>
                  <strong>{provider.name}</strong>
                  <span>
                    {provider.method === "oauth" ? "Account sign-in" : "API key"} ·{" "}
                    {provider.source === "stored" ? "saved credentials" : provider.source}
                  </span>
                  {provider.source === "stored" && (
                    <button disabled={busy} onClick={() => disconnect(provider)}>
                      Disconnect {provider.name}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No providers are configured yet.</p>
          )}
          <small>
            Credentials stay in Workflow's private store in your home directory and are shared
            across projects and interfaces. Status reflects configured credentials; model access is
            checked when a request runs.
          </small>
          <button
            disabled={busy}
            onClick={() => {
              void perform(async (signal) => {
                await refresh(signal);
                if (!signal.aborted) setNotice("Provider status and available models refreshed.");
              });
            }}
          >
            {busy ? "Working…" : "Refresh connections & models"}
          </button>
          {warnings.map((warning) => (
            <p key={warning} className="warning">
              {warning}
            </p>
          ))}
        </section>
        <form
          className="setup-card"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <h2>Default for this project</h2>
          <label htmlFor="project-model">Model</label>
          <select
            id="project-model"
            disabled={busy || !setup}
            value={selection}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">Choose an available model</option>
            {selection && !model && <option value={selection}>{selection} · unavailable</option>}
            {models.map((item) => (
              <option key={modelKey(item)} value={modelKey(item)}>
                {item.name} · {modelKey(item)}
              </option>
            ))}
          </select>
          <label htmlFor="project-thinking">Thinking level</label>
          <select
            id="project-thinking"
            value={thinking}
            disabled={busy || !model}
            onChange={(event) =>
              form.setFieldValue("thinking", event.target.value as AgentSettings["thinking"])
            }
          >
            {!model?.thinkingLevels.includes(thinking) && (
              <option value={thinking}>
                {thinking}
                {model ? " · unsupported" : ""}
              </option>
            )}
            {model?.thinkingLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          {model && (
            <p className="model-caption">
              {model.contextWindow.toLocaleString()} token context ·{" "}
              {model.cost
                ? `$${model.cost.input} input / $${model.cost.output} output per million tokens`
                : "Pricing unavailable"}
            </p>
          )}
          <button
            type="submit"
            className="primary"
            disabled={busy || !model || !model.thinkingLevels.includes(thinking)}
          >
            Save project model
          </button>
          <button
            type="button"
            disabled={busy || !setup}
            onClick={() => {
              void form.handleSubmit({ inherit: true });
            }}
          >
            Use shared defaults
          </button>
          {dirty && (
            <button type="button" disabled={busy} onClick={discard}>
              Discard model changes
            </button>
          )}
          <details className="shared-defaults">
            <summary>Shared defaults across projects</summary>
            <p className="muted">
              {setup?.userAgent.provider && setup.userAgent.model
                ? `${setup.userAgent.provider}/${setup.userAgent.model}`
                : "No shared model selected"}
              . Optional terminal command: <code>workflow model</code>.
            </p>
          </details>
          <small>
            These controls update this project's model and thinking overrides. Execution limits and
            existing run snapshots are preserved.
          </small>
        </form>
      </div>
    </section>
  );
}
