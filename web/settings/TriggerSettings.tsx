import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { z } from "zod";
import {
  triggerConfigSchema,
  type runListSchema,
  type Trigger,
  type TriggerConfig,
  type TriggerState,
} from "../../src/contracts/index.js";
import { client } from "../shared/api.js";
import Field from "../shared/Field.js";
import "./TriggerSettings.css";

type SavedWorkflow = z.infer<typeof runListSchema>[number];
const defaults = (): TriggerConfig => ({
  name: "",
  repository: "",
  event: "pull_request.opened",
  workflowRunId: "",
  enabled: false,
  pollSeconds: 60,
  labels: [],
  authors: [],
  includeDrafts: false,
  result: "local",
});
const serialize = (form: TriggerConfig, labels: string, authors: string) =>
  JSON.stringify({ form, labels, authors });
interface Props {
  ref?: Ref<{ discard(): void }>;
  onDirty?: (value: boolean) => void;
  onBusy?: (value: boolean) => void;
}
interface Lifecycle {
  controller: AbortController;
  readController?: AbortController;
  loading: boolean;
  version: number;
}

export default function TriggerSettings({ ref, onDirty, onBusy }: Props) {
  const [state, setState] = useState<TriggerState>({ triggers: [], jobs: [] });
  const [runs, setRuns] = useState<SavedWorkflow[]>([]);
  const [selected, setSelected] = useState<Trigger>();
  const [form, setForm] = useState(defaults);
  const [labels, setLabels] = useState("");
  const [authors, setAuthors] = useState("");
  const [number, setNumber] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(() => serialize(defaults(), "", ""));
  const dirty = serialize(form, labels, authors) !== saved;
  const lifecycle = useRef<Lifecycle | null>(null);

  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy?.(busy);
  }, [busy, onBusy]);
  useEffect(
    () => () => {
      onDirty?.(false);
      onBusy?.(false);
    },
    [onDirty, onBusy],
  );

  function select(trigger?: Trigger) {
    if (dirty && !window.confirm("Discard unsaved trigger changes?")) return;
    const value = trigger ? triggerConfigSchema.strip().parse(trigger) : defaults();
    const nextLabels = value.labels.join(", ");
    const nextAuthors = value.authors.join(", ");
    setSelected(trigger);
    setForm(value);
    setLabels(nextLabels);
    setAuthors(nextAuthors);
    setSaved(serialize(value, nextLabels, nextAuthors));
    setNumber(undefined);
    setError("");
    setNotice("");
  }
  const discard = useCallback(() => {
    const value = JSON.parse(saved) as { form: TriggerConfig; labels: string; authors: string };
    setForm(value.form);
    setLabels(value.labels);
    setAuthors(value.authors);
    setError("");
  }, [saved]);
  useImperativeHandle(ref, () => ({ discard }), [discard]);

  const load = useCallback(async (force = false) => {
    const active = lifecycle.current;
    if (!active || active.controller.signal.aborted || (active.loading && !force)) return;
    active.readController?.abort();
    const readController = new AbortController();
    active.readController = readController;
    active.loading = true;
    const version = ++active.version;
    try {
      const [updated, available] = await Promise.all([
        client.triggers(readController.signal),
        client.runs(readController.signal),
      ]);
      if (active.controller.signal.aborted || version !== active.version) return;
      setState(updated);
      setRuns(
        available.filter((run) => !run.deletedAt && ["draft", "completed"].includes(run.status)),
      );
    } catch (failure) {
      if (!active.controller.signal.aborted && !readController.signal.aborted) throw failure;
    } finally {
      if (version === active.version) active.loading = false;
    }
  }, []);
  const perform = useCallback(async (action: () => Promise<void>) => {
    const active = lifecycle.current;
    if (!active || active.controller.signal.aborted) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      if (!active.controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!active.controller.signal.aborted) setBusy(false);
    }
  }, []);
  useEffect(() => {
    const active: Lifecycle = { controller: new AbortController(), loading: false, version: 0 };
    lifecycle.current = active;
    void perform(load);
    const timer = setInterval(() => {
      void load().catch((failure: unknown) => {
        if (!active.controller.signal.aborted) setError(String(failure));
      });
    }, 5000);
    return () => {
      active.controller.abort();
      active.readController?.abort();
      clearInterval(timer);
    };
  }, [load, perform]);

  async function save() {
    const active = lifecycle.current;
    if (!active) return;
    const config = triggerConfigSchema.parse({
      ...form,
      labels: labels
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      authors: authors
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    });
    const trigger = await client.saveTrigger(config, selected?.id, selected?.revision);
    if (active.controller.signal.aborted) return;
    const value = triggerConfigSchema.strip().parse(trigger);
    setSelected(trigger);
    setForm(value);
    setSaved(serialize(value, labels, authors));
    await load(true);
    if (!active.controller.signal.aborted)
      setNotice(
        trigger.enabled
          ? "Trigger enabled. Matching events will start this workflow automatically."
          : "Trigger saved and disabled. Test it before enabling.",
      );
  }
  async function test() {
    const active = lifecycle.current;
    if (!selected || !number || !active) return;
    const job = await client.testTrigger(selected.id, number);
    if (active.controller.signal.aborted) return;
    await load(true);
    if (!active.controller.signal.aborted)
      setNotice(
        job.status === "failed"
          ? (job.error ?? "Test failed")
          : "Test draft created. Open it from the event history to inspect and approve it. Test runs never publish a GitHub result comment.",
      );
  }
  async function poll() {
    const active = lifecycle.current;
    if (!active) return;
    const updated = await client.pollTriggers();
    if (active.controller.signal.aborted) return;
    active.version++;
    active.readController?.abort();
    active.loading = false;
    setState(updated);
  }
  async function jobAction(id: string, action: "retry" | "cancel") {
    const active = lifecycle.current;
    if (!active) return;
    await client.triggerEventAction(id, action);
    if (!active.controller.signal.aborted) await load(true);
  }

  return (
    <section className="trigger-settings">
      <div className="settings-section-title">
        <div>
          <h2>GitHub triggers</h2>
          <p>
            Run a saved workflow when new issues or pull requests appear. Workflow must remain
            running; the browser can be closed.
          </p>
        </div>
        <div className="button-row">
          <button disabled={busy} onClick={() => select()}>
            New trigger
          </button>
          <button disabled={busy} onClick={() => void perform(poll)}>
            Poll now
          </button>
        </div>
      </div>
      <p>
        GitHub access uses GH_TOKEN, GITHUB_TOKEN, or your GitHub CLI sign-in. Public repositories
        can be read without signing in.
      </p>
      {(error || state.error) && (
        <div className="inline-error" role="alert">
          {error || state.error}
        </div>
      )}
      {notice && (
        <div className="setup-notice" role="status">
          {notice}
        </div>
      )}
      {state.triggers.length > 0 && (
        <div className="trigger-list">
          {state.triggers.map((trigger) => (
            <button
              key={trigger.id}
              disabled={busy}
              aria-pressed={selected?.id === trigger.id}
              onClick={() => select(trigger)}
            >
              <strong>{trigger.name}</strong>
              <span>
                {trigger.repository} · {trigger.enabled ? "Enabled" : "Disabled"}
              </span>
              {trigger.error ? (
                <small>{trigger.error}</small>
              ) : (
                <small>
                  {trigger.lastPollAt
                    ? `Last checked ${new Date(trigger.lastPollAt).toLocaleString()}`
                    : "Not checked yet"}
                </small>
              )}
            </button>
          ))}
        </div>
      )}
      <form
        className="settings-card"
        onSubmit={(event) => {
          event.preventDefault();
          void perform(save);
        }}
      >
        <h3>{selected ? "Edit trigger" : "New trigger"}</h3>
        <fieldset className="settings-fields" disabled={busy}>
          <div className="field-grid">
            <Field label="Trigger name">
              {({ id }) => (
                <input
                  id={id}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  required
                  placeholder="Review new pull requests"
                />
              )}
            </Field>
            <Field label="GitHub repository">
              {({ id }) => (
                <input
                  id={id}
                  value={form.repository}
                  onChange={(event) => setForm({ ...form, repository: event.target.value })}
                  required
                  placeholder="owner/repository"
                />
              )}
            </Field>
            <Field label="Event">
              {({ id }) => (
                <select
                  id={id}
                  value={form.event}
                  onChange={(event) =>
                    setForm({ ...form, event: event.target.value as TriggerConfig["event"] })
                  }
                >
                  <option value="pull_request.opened">New pull request</option>
                  <option value="issue.opened">New issue</option>
                </select>
              )}
            </Field>
            <Field
              label="Saved workflow"
              help="Captures this workflow's code, blocks, models and settings. Later edits do not change the captured version."
            >
              {({ id }) => (
                <select
                  id={id}
                  value={form.workflowRunId}
                  onChange={(event) => setForm({ ...form, workflowRunId: event.target.value })}
                  required
                >
                  <option disabled value="">
                    Choose a draft or completed workflow
                  </option>
                  {selected && !runs.some((run) => run.id === selected.workflowRunId) && (
                    <option value={selected.workflowRunId}>
                      {selected.workflowTitle} (captured)
                    </option>
                  )}
                  {runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.title} · {run.status} · {run.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              label="Required labels"
              help="Comma separated. Every label must match when the event is observed."
            >
              {({ id }) => (
                <input
                  id={id}
                  value={labels}
                  onChange={(event) => setLabels(event.target.value)}
                  placeholder="Optional: workflow, bug"
                />
              )}
            </Field>
            <Field
              label="Allowed authors"
              help="Comma separated GitHub logins. Empty allows every author."
            >
              {({ id }) => (
                <input
                  id={id}
                  value={authors}
                  onChange={(event) => setAuthors(event.target.value)}
                  placeholder="Optional: octocat"
                />
              )}
            </Field>
            <Field label="Polling interval (seconds)">
              {({ id }) => (
                <input
                  id={id}
                  value={form.pollSeconds}
                  onChange={(event) =>
                    setForm({ ...form, pollSeconds: event.target.valueAsNumber })
                  }
                  type="number"
                  min={30}
                  max={3600}
                  required
                />
              )}
            </Field>
            <Field
              label="Spending limit per run (USD)"
              help="Empty inherits the saved workflow's budget."
            >
              {({ id }) => (
                <input
                  id={id}
                  type="number"
                  min={0.001}
                  step="any"
                  value={form.maxCostUsd ?? ""}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      maxCostUsd: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              )}
            </Field>
            <Field label="Result destination">
              {({ id }) => (
                <select
                  id={id}
                  value={form.result}
                  onChange={(event) =>
                    setForm({ ...form, result: event.target.value as TriggerConfig["result"] })
                  }
                >
                  <option value="local">Workflow results only</option>
                  <option value="github-comment">Also post a GitHub comment</option>
                </select>
              )}
            </Field>
          </div>
          {form.event === "pull_request.opened" && (
            <label className="toggle-row">
              <input
                checked={form.includeDrafts}
                onChange={(event) => setForm({ ...form, includeDrafts: event.target.checked })}
                type="checkbox"
              />
              Include draft pull requests
            </label>
          )}
          <label className="toggle-row">
            <input
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              type="checkbox"
            />
            Enable automatic execution
          </label>
          <p>
            New triggers watch items created from the time they are saved. Disabled triggers pause
            admission and queued work; enabling catches up from the saved checkpoint. Runs execute
            one at a time in this project.
          </p>
          <div className="button-row">
            <button type="submit" className="primary" disabled={!!selected && !dirty}>
              Save trigger
            </button>
            {dirty && (
              <button type="button" onClick={discard}>
                Discard trigger edits
              </button>
            )}
          </div>
        </fieldset>
      </form>
      {selected && (
        <div className="settings-card">
          <h3>Test this trigger</h3>
          <p>
            Choose an existing item to create a draft, without automatic execution or a GitHub
            result comment. Testing bypasses label, author and creation-time filters.
          </p>
          <Field label="Issue or pull request number">
            {({ id }) => (
              <input
                id={id}
                value={number ?? ""}
                onChange={(event) =>
                  setNumber(event.target.value ? event.target.valueAsNumber : undefined)
                }
                type="number"
                min={1}
              />
            )}
          </Field>
          <button disabled={busy || dirty || !number} onClick={() => void perform(test)}>
            Create test draft
          </button>
        </div>
      )}
      <div className="settings-section-title">
        <div>
          <h2>Event history</h2>
          <p>
            The latest 100 events, including queued work and test drafts. Open a run to inspect its
            results or resolve an interruption.
          </p>
        </div>
      </div>
      {!state.jobs.length && <p>No events yet.</p>}
      {state.jobs.map((job) => (
        <article key={job.id} className="settings-card trigger-job">
          <div className="card-title">
            <strong>
              {job.triggerName} · {job.event.repository}#{job.event.number}
            </strong>
            <span>
              {job.test ? "Test · " : ""}
              {job.status}
              {job.runStatus && job.runStatus !== job.status ? ` · ${job.runStatus}` : ""}
            </span>
          </div>
          <p>{job.event.title}</p>
          {job.error && <p className="inline-error">{job.error}</p>}
          <div className="button-row">
            {job.status !== "queued" && job.status !== "failed" && (
              <a href={`#run=${job.runId}`}>Open workflow</a>
            )}
            <a href={job.event.url} target="_blank" rel="noopener noreferrer">
              View GitHub item
            </a>
            {job.resultUrl && (
              <a href={job.resultUrl} target="_blank" rel="noopener noreferrer">
                Published result
              </a>
            )}
            {["failed", "publishing"].includes(job.status) && (
              <button
                disabled={busy}
                onClick={() => void perform(() => jobAction(job.id, "retry"))}
              >
                {job.status === "publishing" ? "Check delivery again" : "Retry dispatch"}
              </button>
            )}
            {["queued", "failed"].includes(job.status) && (
              <button
                disabled={busy}
                onClick={() => void perform(() => jobAction(job.id, "cancel"))}
              >
                Cancel queued event
              </button>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}
