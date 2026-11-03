import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { useBlocker } from "@tanstack/react-router";
import type { z } from "zod";
import {
  modelCatalogSchema,
  orchestrationStateSchema,
  executionSettingsSchema,
  type Library,
  type AvailableModel,
  type OrchestrationState,
} from "../../src/contracts/index.js";
import { request } from "../shared/api.js";
import { useWorkspaceLocation, type SettingsSection } from "../app/workspace-location.js";
import ModelSettings from "./ModelSettings.js";
import ModelProfiles from "./ModelProfiles.js";
import TaskCases from "./TaskCases.js";
import BlockSettings from "./BlockSettings.js";
import Capabilities from "./Capabilities.js";
import ExecutionSettings from "./ExecutionSettings.js";
import TriggerSettings from "./TriggerSettings.js";
import MemorySettings from "./MemorySettings.js";
import AutomationSettings from "./AutomationSettings.js";
import UsageSummary from "../features/usage/UsageSummary.js";
import SetupProgress from "../features/setup/SetupProgress.js";
import type { SetupJobsController } from "../features/setup/use-setup-jobs.js";

const tabs = [
  ["providers", "Providers & models"],
  ["profiles", "Model profiles"],
  ["cases", "Task instructions"],
  ["blocks", "Blocks"],
  ["capabilities", "Skills & MCP"],
  ["execution", "Execution"],
  ["triggers", "Triggers"],
  ["automations", "Automations"],
  ["memory", "Memory"],
] as const;
type Section = SettingsSection;
type EditorHandle = { discard: () => void };
type ExecutionConfig = z.infer<typeof executionSettingsSchema>;
type SettingsValues = {
  state: OrchestrationState | undefined;
  execution: ExecutionConfig | undefined;
};
export interface SettingsContext {
  section: Section;
  blockId?: string;
}
interface SettingsPageProps {
  library: Library;
  onSaved: () => Promise<void>;
  designRevision: number;
  applyingDesign: boolean;
  usageRevision: number;
  setupController: SetupJobsController;
  demo: boolean;
  onDirty?: (dirty: boolean) => void;
  onContext?: (value: SettingsContext) => void;
}

export default function SettingsPage({
  library,
  onSaved,
  designRevision,
  applyingDesign,
  usageRevision,
  setupController,
  demo,
  onDirty,
  onContext,
}: SettingsPageProps) {
  const { section: tab, setSettingsSection } = useWorkspaceLocation();
  const [selectedBlock, setSelectedBlock] = useState("");
  const [defaults, setDefaults] = useState<SettingsValues>({
    state: undefined,
    execution: undefined,
  });
  const form = useForm({
    defaultValues: defaults,
    onSubmit: async () => {
      await perform(save);
    },
  });
  const { state, execution } = useStore(form.store, (state) => state.values);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [blockDirty, setBlockDirty] = useState(false);
  const [modelDirty, setModelDirty] = useState(false);
  const [triggerDirty, setTriggerDirty] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [automationDirty, setAutomationDirty] = useState(false);
  const automationEditor = useRef<EditorHandle>(null);
  const memoryEditor = useRef<EditorHandle>(null);
  const triggerEditor = useRef<EditorHandle>(null);
  const blockEditor = useRef<EditorHandle>(null);
  const modelEditor = useRef<EditorHandle>(null);
  const [loadedDesignRevision, setLoadedDesignRevision] = useState(designRevision);
  const [editorRevision, setEditorRevision] = useState(0);
  const [staleSettings, setStaleSettings] = useState(false);
  const requests = useRef<{ controller: AbortController | undefined }>({ controller: undefined });
  const catalogRequest = useRef<AbortController | undefined>(undefined);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const dirty =
    !!state && JSON.stringify(state.settings) !== JSON.stringify(defaults.state?.settings);
  const executionDirty =
    !!execution && JSON.stringify(execution) !== JSON.stringify(defaults.execution);
  const hasEdits =
    dirty ||
    executionDirty ||
    blockDirty ||
    modelDirty ||
    triggerDirty ||
    memoryDirty ||
    automationDirty;
  const latest = useRef({ hasEdits, dirty, executionDirty });
  useEffect(() => {
    latest.current = { hasEdits, dirty, executionDirty };
  }, [hasEdits, dirty, executionDirty]);
  const refreshingDesign = loadedDesignRevision !== designRevision;

  const emitContext = useEffectEvent((value: SettingsContext) => onContext?.(value));
  const emitDirty = useEffectEvent((value: boolean) => onDirty?.(value));
  useEffect(() => {
    emitContext({
      section: tab,
      ...(tab === "blocks" && selectedBlock ? { blockId: selectedBlock } : {}),
    });
  }, [tab, selectedBlock]);
  useEffect(() => {
    emitDirty(hasEdits);
  }, [hasEdits]);
  useEffect(
    () => () => {
      emitDirty(false);
    },
    [],
  );
  useEffect(() => {
    const session = new AbortController();
    lifetime.current = session;
    const pending = requests.current;
    const warn = (event: BeforeUnloadEvent) => {
      if (latest.current.hasEdits) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      session.abort();
      pending.controller?.abort();
      catalogRequest.current?.abort();
      window.removeEventListener("beforeunload", warn);
    };
  }, []);

  const loadCatalog = useCallback(async () => {
    catalogRequest.current?.abort();
    const lookup = new AbortController();
    catalogRequest.current = lookup;
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const catalog = await request("/api/models", modelCatalogSchema, { signal: lookup.signal });
      if (!lookup.signal.aborted) setModels(catalog.models);
    } catch (failure) {
      if (!lookup.signal.aborted) setCatalogError(String(failure));
    } finally {
      if (!lookup.signal.aborted) setCatalogLoading(false);
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => {
      if (!disposed) return loadCatalog();
    });
    return () => {
      disposed = true;
      catalogRequest.current?.abort();
    };
  }, [loadCatalog]);

  const load = useCallback(
    async (revision: number, force = false) => {
      const pending = requests.current;
      pending.controller?.abort();
      const lookup = new AbortController();
      pending.controller = lookup;
      setLoading(true);
      setLoadError("");
      try {
        const options = { signal: lookup.signal };
        const [loaded, config] = await Promise.allSettled([
          request("/api/settings/orchestration", orchestrationStateSchema, options),
          request("/api/settings/execution", executionSettingsSchema, options),
        ]);
        if (lookup.signal.aborted) return;
        const preserveState = !force && latest.current.dirty;
        const preserveExecution = !force && latest.current.executionDirty;
        if (loaded.status === "fulfilled" && !preserveState) {
          setDefaults((current) => ({ ...current, state: loaded.value }));
          form.setFieldValue("state", loaded.value);
        }
        if (config.status === "fulfilled" && !preserveExecution) {
          setDefaults((current) => ({ ...current, execution: config.value }));
          form.setFieldValue("execution", config.value);
        }
        const failures = [loaded, config].flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : [],
        );
        setLoadError(failures.join("\n"));
        setStaleSettings(preserveState || preserveExecution);
        if (force || !latest.current.hasEdits) setEditorRevision((value) => value + 1);
      } finally {
        if (!lookup.signal.aborted) {
          setLoading(false);
          setLoadedDesignRevision(revision);
        }
      }
    },
    [form],
  );
  useEffect(() => {
    let disposed = false;
    const pending = requests.current;
    void Promise.resolve().then(async () => {
      if (disposed) return;
      if (latest.current.hasEdits) {
        setStaleSettings(true);
        setLoadedDesignRevision(designRevision);
        return;
      }
      try {
        await load(designRevision);
      } catch (failure) {
        if (!disposed) setError(String(failure));
      }
    });
    return () => {
      disposed = true;
      pending.controller?.abort();
    };
  }, [designRevision, load]);

  function discardSettings() {
    if (busy) return;
    form.reset(defaults);
    setError("");
    setNotice("");
  }
  function discardAll() {
    discardSettings();
    blockEditor.current?.discard();
    modelEditor.current?.discard();
    triggerEditor.current?.discard();
    memoryEditor.current?.discard();
    automationEditor.current?.discard();
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      if (!lifetime.current?.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false);
    }
  }
  async function save() {
    if (dirty && state) {
      const updated = await request("/api/settings/orchestration", orchestrationStateSchema, {
        method: "PUT",
        body: state,
        signal: lifetime.current?.signal,
      });
      setDefaults((current) => ({ ...current, state: updated }));
      form.setFieldValue("state", updated);
      await onSaved();
      setNotice("Settings saved. New task requests use these instructions and capabilities.");
    }
    if (executionDirty && execution) {
      const updated = await request("/api/settings/execution", executionSettingsSchema, {
        method: "PUT",
        body: execution,
        signal: lifetime.current?.signal,
      });
      setDefaults((current) => ({ ...current, execution: updated }));
      form.setFieldValue("execution", updated);
      await onSaved();
      setNotice("Execution settings saved.");
    }
  }
  useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (
        !("view" in current.search) ||
        current.search.view !== "settings" ||
        !("view" in next.search) ||
        next.search.view !== "settings" ||
        current.search.section === next.search.section ||
        !(blockDirty || modelDirty || triggerDirty || memoryDirty || automationDirty)
      )
        return false;
      if (!window.confirm("Discard unsaved changes in this section?")) return true;
      setBlockDirty(false);
      setModelDirty(false);
      setTriggerDirty(false);
      setMemoryDirty(false);
      setAutomationDirty(false);
      return false;
    },
    enableBeforeUnload: false,
  });
  function changeTab(id: Section) {
    setSettingsSection(id);
    setNotice("");
  }
  async function providersSaved() {
    const signal = lifetime.current?.signal;
    const baseline = defaults.execution;
    const config = await request("/api/settings/execution", executionSettingsSchema, { signal });
    if (signal?.aborted) return;
    const draft = form.state.values.execution;
    const fields = ["instructions", "commands", "maxSteps", "budget"] as const;
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    const conflicts =
      baseline && draft
        ? fields.filter(
            (field) =>
              !same(draft[field], baseline[field]) &&
              !same(config[field], baseline[field]) &&
              !same(draft[field], config[field]),
          )
        : [];
    if (conflicts.length) {
      // Keep the original revision so a save cannot overwrite a concurrent execution edit.
      setStaleSettings(true);
      setError(
        `Execution settings changed elsewhere (${conflicts.join(", ")}). Your edits are preserved; reload saved settings before saving.`,
      );
    } else {
      const rebased =
        baseline && draft
          ? {
              ...config,
              instructions: same(draft.instructions, baseline.instructions)
                ? config.instructions
                : draft.instructions,
              commands: same(draft.commands, baseline.commands) ? config.commands : draft.commands,
              maxSteps: same(draft.maxSteps, baseline.maxSteps) ? config.maxSteps : draft.maxSteps,
              budget: same(draft.budget, baseline.budget) ? config.budget : draft.budget,
            }
          : config;
      setDefaults((current) => ({ ...current, execution: config }));
      form.setFieldValue("execution", rebased);
    }
    await loadCatalog();
    await onSaved();
    await setupController.refresh();
  }
  function reload() {
    if (!hasEdits || window.confirm("Discard unsaved settings and reload?")) {
      discardAll();
      void perform(() => load(designRevision, true));
    }
  }
  function updateSettings(settings: OrchestrationState["settings"]) {
    form.setFieldValue("state", (current) => (current ? { ...current, settings } : current));
  }
  return (
    <div className="settings-page">
      <div className="page-heading">
        <span className="eyebrow">WORKSPACE</span>
        <h1>Settings</h1>
        <p>Shape how your orchestrator plans, chooses models, and executes work.</p>
      </div>
      <nav className="settings-tabs" aria-label="Settings sections">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            disabled={busy || applyingDesign || refreshingDesign}
            onClick={() => changeTab(id)}
          >
            {label}
            {(id === "triggers" || id === "memory") && <span className="alpha-badge">Alpha</span>}
          </button>
        ))}
      </nav>
      {loadError && (
        <div className="inline-error" role="alert">
          Settings could not be fully loaded: {loadError}{" "}
          <button
            disabled={loading || busy || applyingDesign}
            onClick={() => void load(designRevision)}
          >
            Retry loading settings
          </button>
        </div>
      )}
      {catalogError && (
        <div className="inline-error" role="alert">
          Model catalog unavailable: {catalogError}. Other settings are still available.{" "}
          <button disabled={catalogLoading} onClick={() => void loadCatalog()}>
            Retry model catalog
          </button>
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="setup-notice" role="status">
          {notice}
        </div>
      )}
      {staleSettings && (
        <div className="setup-notice" role="status">
          Project settings changed while you were editing. Your unsaved edits are preserved.{" "}
          <button disabled={busy || applyingDesign} onClick={reload}>
            Reload saved settings
          </button>
        </div>
      )}
      {tab === "memory" ? (
        <MemorySettings ref={memoryEditor} onDirty={setMemoryDirty} onBusy={setBusy} />
      ) : tab === "automations" ? (
        <AutomationSettings
          ref={automationEditor}
          library={library}
          onDirty={setAutomationDirty}
          onBusy={setBusy}
        />
      ) : !state ? (
        <p role="status">
          {loading
            ? "Loading settings…"
            : "Settings are unavailable. Retry loading settings to recover."}
        </p>
      ) : (
        <fieldset
          className="settings-fields"
          disabled={applyingDesign || refreshingDesign || (busy && tab !== "providers")}
        >
          {tab === "providers" && (
            <>
              <ModelSettings
                key={editorRevision}
                ref={modelEditor}
                onSaved={providersSaved}
                onBusy={setBusy}
                onDirty={setModelDirty}
              />
              <SetupProgress
                controller={setupController}
                blocked={hasEdits || busy || applyingDesign}
                defaultLimit={execution?.budget?.maxSetupCostUsd}
                demo={demo}
              />
            </>
          )}
          {tab === "profiles" && (
            <ModelProfiles
              value={state.settings}
              onChange={updateSettings}
              models={models}
              busy={busy}
            />
          )}
          {tab === "cases" && <TaskCases value={state.settings} onChange={updateSettings} />}
          {tab === "blocks" && (
            <BlockSettings
              key={editorRevision}
              ref={blockEditor}
              library={library}
              settings={state.settings}
              onSaved={onSaved}
              onDirty={setBlockDirty}
              onBusy={setBusy}
              onSelected={setSelectedBlock}
            />
          )}
          {tab === "capabilities" && (
            <Capabilities
              value={state.settings.capabilities}
              onChange={(capabilities) => updateSettings({ ...state.settings, capabilities })}
              projectCapabilities={state.projectCapabilities}
            />
          )}
          {tab === "execution" && !execution && (
            <p role="status">
              {loading
                ? "Loading execution settings…"
                : "Execution settings are unavailable. Retry loading settings to recover."}
            </p>
          )}
          {tab === "execution" && execution && (
            <>
              <ExecutionSettings
                value={execution}
                onChange={(value) => form.setFieldValue("execution", value)}
                approval={state.settings.approval}
                onUpdateApproval={(approval) => updateSettings({ ...state.settings, approval })}
              />
              <UsageSummary scope="project" revision={usageRevision} active />
            </>
          )}
          {tab === "triggers" && (
            <TriggerSettings ref={triggerEditor} onDirty={setTriggerDirty} onBusy={setBusy} />
          )}
          {!["providers", "blocks", "triggers"].includes(tab) && (
            <div className="settings-save">
              <span>{dirty || executionDirty ? "Unsaved changes" : "All changes saved"}</span>
              <button disabled={busy} onClick={reload}>
                Reload settings
              </button>
              {(dirty || executionDirty) && (
                <button disabled={busy} onClick={discardSettings}>
                  Discard settings changes
                </button>
              )}
              <button
                className="primary"
                disabled={busy || (!dirty && !executionDirty)}
                onClick={() => void form.handleSubmit()}
              >
                {busy ? "Saving…" : "Save settings"}
              </button>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}
