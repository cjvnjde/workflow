import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import type { MemoryEntry, MemoryState, MemoryDescription } from "../../src/contracts/index.js";
import { WorkflowApiError } from "../../src/client/client.js";
import { client } from "../shared/api.js";
import { usageCost, usageTokens } from "../features/usage/usage-presentation.js";
import Field from "../shared/Field.js";
import StrategyFacts from "../features/tasks/StrategyFacts.js";
import "./MemorySettings.css";

interface MemoryForm {
  title: string;
  description: string;
  details: string;
  tags: string;
}
const empty = (): MemoryForm => ({ title: "", description: "", details: "", tags: "" });
const caption = (kind: string) =>
  kind === "preference"
    ? "Explicit preference"
    : kind === "observation"
      ? "Observed work"
      : kind === "strategy"
        ? "Remembered strategy"
        : "Project note";
const date = (value: string) => new Date(value).toLocaleString();
interface Props {
  ref?: Ref<{ discard(): void }>;
  onDirty?: (value: boolean) => void;
  onBusy?: (value: boolean) => void;
}
interface Lifecycle {
  controller: AbortController;
  detailController?: AbortController;
  detailVersion: number;
  stateVersion: number;
}

export default function MemorySettings({ ref, onDirty, onBusy }: Props) {
  const [state, setState] = useState<MemoryState>();
  const [selected, setSelected] = useState<MemoryEntry>();
  const [editing, setEditing] = useState(false);
  const [newKind, setNewKind] = useState<"note" | "preference">("note");
  const [saved, setSaved] = useState(empty);
  const lifecycle = useRef<Lifecycle | null>(null);
  const editor = useForm({
    defaultValues: saved,
    onSubmitMeta: {} as { revision?: string },
    onSubmit: async ({ value, meta }) => {
      const active = lifecycle.current;
      if (!active || active.controller.signal.aborted) return;
      setError("");
      setNotice("");
      try {
        await save(value, meta.revision);
      } catch (failure) {
        reportFailure(failure, active);
        throw failure;
      }
    },
  });
  const form = useStore(editor.store, (value) => value.values);
  const submitting = useStore(editor.store, (value) => value.isSubmitting);
  const [formRevision, setFormRevision] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const busy = actionBusy || submitting;
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<{ entry: MemoryEntry; revision: string }>();
  const dirty = editing && JSON.stringify(form) !== JSON.stringify(saved);
  const text = query.trim().toLocaleLowerCase();
  const entries = (state?.entries ?? []).filter(
    (entry) =>
      (!kind || entry.kind === kind) &&
      (!text ||
        [entry.title, entry.description, ...entry.tags]
          .join(" ")
          .toLocaleLowerCase()
          .includes(text)),
  );
  const changed =
    selected &&
    state &&
    state.entries.find((entry) => entry.id === selected.id)?.updatedAt !== selected.updatedAt;
  const observation = selected?.observation;
  const strategy = selected?.strategy;

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

  function reset(entry?: MemoryEntry, revision = state?.revision ?? "") {
    const value = entry
      ? {
          title: entry.title,
          description: entry.description,
          details: entry.details,
          tags: entry.tags.join(", "),
        }
      : empty();
    setSelected(entry);
    setSaved(value);
    editor.reset(value);
    setFormRevision(revision);
    setError("");
    setConflict(false);
    setLatest(undefined);
  }
  const discard = useCallback(() => {
    editor.reset(saved);
    setError("");
  }, [editor, saved]);
  useImperativeHandle(ref, () => ({ discard }), [discard]);
  function canLeave() {
    return !dirty || window.confirm("Discard unsaved memory edits?");
  }
  function create(kind: "note" | "preference") {
    if (!canLeave()) return;
    const active = lifecycle.current;
    if (!active) return;
    active.detailVersion++;
    active.detailController?.abort();
    setDetailLoading(false);
    setNewKind(kind);
    setEditing(true);
    setNotice("");
    reset();
  }
  const load = useCallback(async () => {
    const active = lifecycle.current;
    if (!active) return;
    const version = ++active.stateVersion;
    setLoading(true);
    setLoadError("");
    try {
      const value = await client.memory(active.controller.signal);
      if (version === active.stateVersion && !active.controller.signal.aborted) setState(value);
    } catch (failure) {
      if (version === active.stateVersion && !active.controller.signal.aborted)
        setLoadError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (version === active.stateVersion && !active.controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const active: Lifecycle = {
      controller: new AbortController(),
      detailVersion: 0,
      stateVersion: 0,
    };
    lifecycle.current = active;
    void load();
    return () => {
      active.controller.abort();
      active.detailController?.abort();
    };
  }, [load]);
  async function open(entry: MemoryDescription) {
    if (!canLeave()) return;
    const active = lifecycle.current;
    if (!active) return;
    const version = ++active.detailVersion;
    active.detailController?.abort();
    active.detailController = new AbortController();
    const revision = state?.revision ?? "";
    setEditing(false);
    setSelected(undefined);
    setDetailLoading(true);
    setError("");
    setNotice("");
    setConflict(false);
    setLatest(undefined);
    try {
      const value = await client.memoryEntry(entry.id, active.detailController.signal);
      if (version !== active.detailVersion || active.controller.signal.aborted) return;
      reset(value, revision);
      setEditing(true);
    } catch (failure) {
      if (version === active.detailVersion && !active.controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (version === active.detailVersion && !active.controller.signal.aborted)
        setDetailLoading(false);
    }
  }
  function reportFailure(failure: unknown, active: Lifecycle) {
    if (active.controller.signal.aborted) return;
    setError(failure instanceof Error ? failure.message : String(failure));
    const conflicted = failure instanceof WorkflowApiError && failure.status === 409;
    setConflict(conflicted);
    if (conflicted) setLatest(undefined);
  }
  async function perform(action: () => Promise<void>) {
    const active = lifecycle.current;
    if (!active) return;
    setActionBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      reportFailure(failure, active);
    } finally {
      if (!active.controller.signal.aborted) setActionBusy(false);
    }
  }
  function applyState(value: MemoryState) {
    const active = lifecycle.current;
    if (!active || active.controller.signal.aborted) return;
    active.stateVersion++;
    setState(value);
    setLoading(false);
    setLoadError("");
  }
  async function toggle() {
    const active = lifecycle.current;
    if (!state || !active) return;
    const prior = state.revision;
    const updated = await client.setMemoryEnabled(!state.enabled, prior, active.controller.signal);
    if (active.controller.signal.aborted) return;
    // Switching collection/retrieval does not invalidate this client's own entry edits.
    setFormRevision((revision) => (revision === prior ? updated.revision : revision));
    applyState(updated);
    setNotice(
      updated.enabled
        ? "Project memory enabled. New planning sessions can consult these entries."
        : "Project memory disabled. Saved entries are retained; future collection and memory reads are stopped.",
    );
  }
  function fields(form: MemoryForm) {
    const tags = form.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (tags.length > 8 || tags.some((tag) => tag.length > 40))
      throw new Error("Use at most 8 tags, with at most 40 characters each.");
    return {
      title: form.title.trim(),
      description: form.description.trim(),
      details: form.details,
      tags,
    };
  }
  async function save(form: MemoryForm, revision?: string) {
    const active = lifecycle.current;
    if (!state || !active) return;
    const value = fields(form);
    const result = selected
      ? await client.updateMemoryEntry(
          selected.id,
          { ...value, revision: revision ?? formRevision },
          active.controller.signal,
        )
      : await client.createMemoryEntry(
          { ...value, kind: newKind, revision: state.revision },
          active.controller.signal,
        );
    if (active.controller.signal.aborted) return;
    applyState(result.state);
    reset(result.entry, result.state.revision);
    setNotice(
      result.state.enabled
        ? "Memory entry saved."
        : "Memory entry saved. Project memory remains disabled.",
    );
  }
  async function remove() {
    const active = lifecycle.current;
    if (
      !state ||
      !selected ||
      !active ||
      !window.confirm(`Delete “${selected.title}” from project memory?`)
    )
      return;
    const updated = await client.deleteMemoryEntry(
      selected.id,
      formRevision,
      active.controller.signal,
    );
    if (active.controller.signal.aborted) return;
    applyState(updated);
    reset(undefined, updated.revision);
    setEditing(false);
    setNotice("Memory entry deleted.");
  }
  async function reviewLatest() {
    const active = lifecycle.current;
    if (!active) return;
    if (!selected) {
      await load();
      return;
    }
    // Read the revision before the detail so concurrent writes produce a safe conflict.
    const updated = await client.memory(active.controller.signal);
    const entry = await client.memoryEntry(selected.id, active.controller.signal);
    if (active.controller.signal.aborted) return;
    applyState(updated);
    setLatest({ entry, revision: updated.revision });
  }
  function reloadLatest() {
    if (!latest || !canLeave()) return;
    reset(latest.entry, latest.revision);
    setNotice("Latest saved entry loaded.");
  }

  return (
    <section className="memory-settings" aria-label="Project memory">
      <div className="settings-section-title">
        <div>
          <h2>Project memory</h2>
          <p>
            Keep concise project guidance and recorded outcomes for future planning. Disabled by
            default.
          </p>
        </div>
        <button disabled={busy || loading} onClick={() => void load()}>
          {loading ? "Refreshing…" : "Refresh memory"}
        </button>
      </div>
      {loading && !state && <p role="status">Loading project memory…</p>}
      {loadError && (
        <div className="inline-error" role="alert">
          {loadError}
          <button disabled={loading || busy} onClick={() => void load()}>
            Retry loading memory
          </button>
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="setup-notice" role="status">
          {notice}
        </p>
      )}
      {state && (
        <>
          <div className="settings-card memory-switch">
            <div>
              <strong>Project memory is {state.enabled ? "on" : "off"}</strong>
              <p>
                {state.enabled
                  ? "The planner reads compact descriptions first and loads selected details only when useful. Ordinary live work can add observations."
                  : "The planner does not read these entries and new work does not add observations. You can still manage saved entries."}
              </p>
              <small>
                Turning memory off keeps your entries. It stops future reads and collection; context
                already supplied to an active session cannot be recalled. Memory does not launch
                background AI jobs or benchmarks.
              </small>
            </div>
            <button
              className={!state.enabled ? "primary" : undefined}
              disabled={busy}
              onClick={() => void perform(toggle)}
            >
              {state.enabled ? "Disable project memory" : "Enable project memory"}
            </button>
          </div>
          <div className="memory-list-heading">
            <div>
              <h3>
                Saved entries{" "}
                <small>
                  {state.entries.length} / {state.limit}
                </small>
              </h3>
              <p>
                Descriptions help the planner choose what to read. Details load when you open an
                entry.
              </p>
            </div>
            <div className="button-row">
              <button
                disabled={busy || state.entries.length >= state.limit}
                onClick={() => create("note")}
              >
                New note
              </button>
              <button
                disabled={busy || state.entries.length >= state.limit}
                onClick={() => create("preference")}
              >
                New preference
              </button>
            </div>
          </div>
          {state.entries.length >= state.limit && (
            <p className="setup-notice">
              Project memory is full. Delete an entry before adding another.
            </p>
          )}
          {state.entries.length > 0 && (
            <div className="memory-filters">
              <Field label="Search memory descriptions">
                {({ id }) => (
                  <input
                    id={id}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    type="search"
                    placeholder="Title, description or tags"
                  />
                )}
              </Field>
              <Field label="Entry type">
                {({ id }) => (
                  <select id={id} value={kind} onChange={(event) => setKind(event.target.value)}>
                    <option value="">All entries</option>
                    <option value="note">Project notes</option>
                    <option value="preference">Explicit preferences</option>
                    <option value="observation">Observed work</option>
                    <option value="strategy">Remembered strategies</option>
                  </select>
                )}
              </Field>
            </div>
          )}
          <div className="memory-layout">
            <div className="memory-list" aria-label="Memory descriptions">
              {!state.entries.length ? (
                <p className="memory-empty">
                  No saved entries yet. Add a project note or an explicit preference. Observations
                  appear only from ordinary live runs started while memory is enabled.
                </p>
              ) : (
                !entries.length && (
                  <p className="memory-empty">No descriptions match your search.</p>
                )
              )}
              {entries.map((entry) => (
                <button
                  key={entry.id}
                  className="memory-entry"
                  aria-pressed={selected?.id === entry.id}
                  disabled={busy}
                  onClick={() => void open(entry)}
                >
                  <span className="memory-kind">{caption(entry.kind)}</span>
                  <strong>{entry.title}</strong>
                  <span>{entry.description}</span>
                  {entry.tags.length > 0 && <small>{entry.tags.join(" · ")}</small>}
                </button>
              ))}
            </div>
            <div className="memory-detail">
              {detailLoading ? (
                <p role="status">Loading entry details…</p>
              ) : (
                !editing &&
                state.entries.length > 0 && (
                  <p className="memory-empty">
                    Open an entry to read its details and recorded facts.
                  </p>
                )
              )}
              {editing && (
                <form
                  className="settings-card"
                  aria-label="Memory entry editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void editor.handleSubmit().catch(() => {});
                  }}
                >
                  <div className="memory-editor-heading">
                    <h3>
                      {selected
                        ? caption(selected.kind)
                        : newKind === "preference"
                          ? "New explicit preference"
                          : "New project note"}
                    </h3>
                    {selected && <small>Updated {date(selected.updatedAt)}</small>}
                  </div>
                  {(selected?.kind ?? newKind) === "preference" && (
                    <p>
                      This is an explicit preference you choose to save. Workflow does not infer
                      preferences from your activity.
                    </p>
                  )}
                  {selected?.kind === "observation" && (
                    <p>
                      {selected.edited ? "Your annotation" : "Generated observation text"}: you can
                      edit this guidance. The recorded facts below remain unchanged.
                    </p>
                  )}
                  {selected?.kind === "strategy" && (
                    <p>
                      You chose to remember this approach. Edit the reusable guidance; source facts
                      stay unchanged. Future planning composes a fresh workflow under the current
                      models and permissions.
                    </p>
                  )}
                  <fieldset className="settings-fields" disabled={busy}>
                    <Field label="Memory title">
                      {({ id }) => (
                        <input
                          id={id}
                          value={form.title}
                          onChange={(event) => editor.setFieldValue("title", event.target.value)}
                          required
                          maxLength={100}
                          placeholder="How we review UI changes"
                        />
                      )}
                    </Field>
                    <Field
                      label="Short description"
                      help="Up to 300 characters. The planner sees this before choosing to load the details."
                    >
                      {({ id }) => (
                        <textarea
                          id={id}
                          value={form.description}
                          onChange={(event) =>
                            editor.setFieldValue("description", event.target.value)
                          }
                          rows={2}
                          required
                          maxLength={300}
                          placeholder="When this guidance is useful"
                        />
                      )}
                    </Field>
                    <Field
                      label={
                        selected?.kind === "observation"
                          ? "Your annotation"
                          : selected?.kind === "strategy"
                            ? "Reusable guidance"
                            : "Memory details"
                      }
                      help="Up to 4,000 characters. Keep reusable guidance focused; current requests and project permissions still apply."
                    >
                      {({ id }) => (
                        <textarea
                          id={id}
                          value={form.details}
                          onChange={(event) => editor.setFieldValue("details", event.target.value)}
                          rows={7}
                          maxLength={4000}
                          placeholder="Specific guidance worth retaining"
                        />
                      )}
                    </Field>
                    <Field
                      label="Memory tags"
                      help="Optional, comma separated. Up to 8 tags of 40 characters each."
                    >
                      {({ id }) => (
                        <input
                          id={id}
                          value={form.tags}
                          onChange={(event) => editor.setFieldValue("tags", event.target.value)}
                          placeholder="review, frontend"
                        />
                      )}
                    </Field>
                    <div className="button-row">
                      <button type="submit" className="primary" disabled={!dirty}>
                        {busy ? "Saving…" : "Save memory entry"}
                      </button>
                      {dirty && (
                        <button type="button" onClick={discard}>
                          Discard entry edits
                        </button>
                      )}
                      {selected && (
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void perform(remove)}
                        >
                          Delete entry
                        </button>
                      )}
                    </div>
                  </fieldset>
                  {(conflict || changed) && (
                    <div className="memory-conflict" role="status">
                      <p>
                        The saved memory changed. Your draft is preserved. Review the latest saved
                        version before replacing it.
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void perform(reviewLatest)}
                      >
                        Review latest saved entry
                      </button>
                      {latest && (
                        <div className="memory-latest">
                          <h4>Latest saved version</h4>
                          <strong>{latest.entry.title}</strong>
                          <p>{latest.entry.description}</p>
                          <pre>{latest.entry.details}</pre>
                          {latest.entry.tags.length > 0 && (
                            <p>Tags: {latest.entry.tags.join(", ")}</p>
                          )}
                          <div className="button-row">
                            <button type="button" disabled={busy} onClick={reloadLatest}>
                              Reload latest entry
                            </button>
                            <button
                              type="button"
                              disabled={busy || !dirty}
                              onClick={() =>
                                void editor
                                  .handleSubmit({ revision: latest.revision })
                                  .catch(() => {})
                              }
                            >
                              Save my edits over this version
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {selected && <p className="memory-id">Entry {selected.id}</p>}
                </form>
              )}
              {observation && (
                <section
                  className="settings-card memory-observation"
                  aria-label="Recorded observation facts"
                >
                  <h3>Recorded facts</h3>
                  <p>
                    These are observed execution outcomes, not a quality score or proof that changes
                    were correct. Matched check conditions can include expected failures.
                  </p>
                  <dl className="memory-facts">
                    <div>
                      <dt>Task type</dt>
                      <dd>
                        {observation.taskCaseName} · {observation.taskCaseId}
                      </dd>
                    </div>
                    <div>
                      <dt>Block</dt>
                      <dd>{observation.blockId}</dd>
                    </div>
                    <div>
                      <dt>Recorded model</dt>
                      <dd>
                        {observation.model
                          ? `${observation.model.provider}/${observation.model.model} · ${observation.model.thinking}`
                          : "Model attribution unavailable"}
                      </dd>
                    </div>
                    <div>
                      <dt>Runs / visits</dt>
                      <dd>
                        {observation.runs} / {observation.visits}
                      </dd>
                    </div>
                    <div>
                      <dt>Run outcomes</dt>
                      <dd>
                        {observation.runStatuses.completed} completed ·{" "}
                        {observation.runStatuses.failed} failed ·{" "}
                        {observation.runStatuses.cancelled} cancelled
                      </dd>
                    </div>
                    <div>
                      <dt>Visit outcomes</dt>
                      <dd>
                        {observation.outcomes.pass} pass · {observation.outcomes.retry} retry ·{" "}
                        {observation.outcomes.fail} fail · {observation.outcomes.interrupted}{" "}
                        interrupted
                      </dd>
                    </div>
                    <div>
                      <dt>Configured check conditions</dt>
                      <dd>
                        {observation.checks.matched} matched · {observation.checks.unmatched}{" "}
                        unmatched · {observation.checks.total} recorded
                      </dd>
                    </div>
                    <div>
                      <dt>Reported usage</dt>
                      <dd>
                        {usageCost(
                          observation.usage,
                          observation.usageIncomplete ||
                            observation.sessionStatuses.running > 0 ||
                            observation.sessionStatuses.interrupted > 0,
                        )}{" "}
                        · {usageTokens(observation.usage).toLocaleString()} tokens ·{" "}
                        {observation.sessions} sessions
                      </dd>
                    </div>
                  </dl>
                  <details>
                    <summary>Session status and acceptance signals</summary>
                    <p>
                      {observation.sessionStatuses.completed} completed ·{" "}
                      {observation.sessionStatuses.failed} failed ·{" "}
                      {observation.sessionStatuses.cancelled} cancelled ·{" "}
                      {observation.sessionStatuses.interrupted} interrupted ·{" "}
                      {observation.sessionStatuses.running} running
                    </p>
                    <p>
                      {observation.dispositions.workCompleted} work completed ·{" "}
                      {observation.dispositions.accepted} accepted ·{" "}
                      {observation.dispositions.changesRequested} changes requested ·{" "}
                      {observation.dispositions.blocked} blocked
                    </p>
                  </details>
                  <p>
                    Observed {date(observation.firstObservedAt)} —{" "}
                    {date(observation.lastObservedAt)}
                  </p>
                  <h4>Recent sources</h4>
                  <ul className="memory-sources">
                    {observation.sources.map((source) => (
                      <li key={`${source.runId}/${source.nodeId}/${source.visit}`}>
                        <Link to="/" search={{ run: source.runId }}>
                          {source.nodeId} · visit {source.visit}
                        </Link>
                        <small>
                          {date(source.at)} · {source.runId}
                        </small>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {strategy && (
                <div className="settings-card">
                  <StrategyFacts metadata={strategy} />
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
