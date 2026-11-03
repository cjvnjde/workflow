import { useEffect, useImperativeHandle, useState, type Ref } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  automationConfigSchema,
  type Automation,
  type AutomationAction,
  type AutomationConfig,
  type AutomationJob,
  type AutomationJobAction,
  type AutomationSchedule,
} from "../../src/contracts/automation-schema.js";
import type { Library } from "../../src/contracts/index.js";
import { client } from "../shared/api.js";
import Field from "../shared/Field.js";
import { Button } from "../components/ui/button.js";
import "./AutomationSettings.css";

const queryKey = ["automations"] as const;
const jsonFields = ["inputs", "routes", "execution", "policy", "output"] as const;
type JsonField = (typeof jsonFields)[number];
type Draft = { config: AutomationConfig; json: Record<JsonField, string> };
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "null";
const initial: AutomationConfig = automationConfigSchema.parse({
  name: "New automation",
  schedule: { kind: "manual" },
  target: { kind: "block", blockId: "example" },
});
const draftOf = (config: AutomationConfig): Draft => ({
  config,
  json: {
    inputs: pretty(config.inputs),
    routes: pretty(config.routes),
    execution: pretty(config.execution),
    policy: pretty(config.policy),
    output: pretty(config.output),
  },
});
function parseDraft(draft: Draft) {
  const value: Record<string, unknown> = { ...draft.config };
  const errors: string[] = [];
  for (const key of jsonFields) {
    try {
      const parsed: unknown = JSON.parse(draft.json[key]);
      if (key === "output" && parsed === null) delete value.output;
      else value[key] = parsed;
    } catch (error) {
      errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const parsed = automationConfigSchema.safeParse(value);
  if (!parsed.success)
    errors.push(
      ...parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "config"}: ${issue.message}`,
      ),
    );
  return { config: parsed.success && errors.length === 0 ? parsed.data : undefined, errors };
}
const scheduleOf = (kind: AutomationSchedule["kind"]): AutomationSchedule => {
  switch (kind) {
    case "interval":
      return { kind, seconds: 3600 };
    case "cron":
      return { kind, expression: "0 9 * * *", timezone: "UTC" };
    case "once":
      return { kind, at: new Date(Date.now() + 3600_000).toISOString() };
    default:
      return { kind };
  }
};
function jobActions(job: AutomationJob): AutomationJobAction[] {
  const actions: AutomationJobAction[] = [];
  const terminal = ["completed", "failed", "cancelled"].includes(job.status);
  if (job.approval === "required" && job.status === "waiting") actions.push("approve");
  if (job.status === "queued" || (job.status === "running" && job.runStatus === "running"))
    actions.push("pause");
  if (
    (job.status === "waiting" && job.approval !== "required") ||
    ["paused", "interrupted"].includes(job.runStatus ?? "")
  )
    actions.push("resume");
  if (!terminal) actions.push("cancel");
  if (job.status === "needs_attention" && (!job.runStatus || job.runStatus === "draft"))
    actions.push("retry");
  if (job.status === "needs_attention") {
    actions.push("reconcile");
    if (!["running", "pausing", "paused", "interrupted"].includes(job.runStatus ?? ""))
      actions.push("resolve");
  }
  if (terminal && job.workspace) actions.push("cleanup");
  return actions;
}
function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return (
    <details>
      <summary>{title}</summary>
      <pre>{pretty(value)}</pre>
    </details>
  );
}
const labels: Record<JsonField, string> = {
  inputs: "Input JSON",
  routes: "Routes and filters JSON",
  execution: "Execution and limits JSON",
  policy: "Admission and retry policy JSON",
  output: "Output configuration JSON",
};
const help: Record<JsonField, string> = {
  inputs:
    "Base workflow input object. Reserved automation, signal and case context is supplied by the scheduler.",
  routes:
    "Ordered first-match routes: id, signalKind, optional sourceId, exact match payload filters, revisionPolicy (advance/current/any), target and inputs. Discovery requires at least one route.",
  execution:
    "Workspace, baseRef, environment variable names (never secret values), resources, skills, mcpServers, modelProfile/agent, maxSteps, maxCommands, maxModelCalls, maxToolCalls and optional maxCostUsd.",
  policy:
    "approval, missedRuns, maxCatchUp, overlap, concurrency, maxQueued, cooldownSeconds, supersede, optional maxCostUsd, and retry {safe, maxAttempts, backoffSeconds}. Only explicitly read-only work may retry automatically.",
  output:
    "null disables publication. Otherwise {target, reconcile?, approval, execution?}. Output is a separate job, requiring approval by default. Reconciliation uses the same publication key; uncertain effects are never automatically replayed.",
};

export default function AutomationSettings({
  library,
  ref,
  onDirty,
  onBusy,
}: {
  library: Library;
  ref?: Ref<{ discard(): void }>;
  onDirty?: (value: boolean) => void;
  onBusy?: (value: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Automation>();
  const [saved, setSaved] = useState<Draft>(() =>
    draftOf({
      ...initial,
      target: { kind: "block", blockId: Object.keys(library.blocks)[0] ?? "" },
    }),
  );
  const [draft, setDraft] = useState(saved);
  const [notice, setNotice] = useState("");
  const [inspectJob, setInspectJob] = useState<string>();
  const mutation = useMutation({
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => client.automations(signal),
    refetchInterval: 5000,
    enabled: !mutation.isPending,
  });
  const runs = useQuery({
    queryKey: ["automation-workflow-targets"],
    queryFn: ({ signal }) => client.runs(signal),
  });
  const version = useQuery({
    queryKey: ["automation-version", selected?.versionId],
    queryFn: ({ signal }) => client.automationVersion(selected!.versionId, signal),
    enabled: !!selected,
  });
  const dirty = pretty(draft) !== pretty(saved);
  const busy = mutation.isPending;
  const validation = parseDraft(draft);
  const latest = query.data?.automations.find((item) => item.id === selected?.id);
  const stale = !!selected && !!latest && latest.revision !== selected.revision;
  const jobs =
    query.data?.jobs.filter((job) => !selected || job.automationId === selected.id) ?? [];
  const job = query.data?.jobs.find((item) => item.id === inspectJob);
  const error = mutation.error?.message || query.error?.message || query.data?.error;
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
  useImperativeHandle(
    ref,
    () => ({
      discard() {
        setDraft(saved);
        mutation.reset();
      },
    }),
    [saved, mutation],
  );

  function load(item?: Automation) {
    if (dirty && !window.confirm("Discard unsaved automation changes?")) return;
    const value = draftOf(
      item?.config ?? {
        ...initial,
        target: { kind: "block", blockId: Object.keys(library.blocks)[0] ?? "" },
      },
    );
    setSelected(item);
    setSaved(value);
    setDraft(value);
    setNotice("");
    mutation.reset();
  }
  function update<K extends keyof AutomationConfig>(key: K, value: AutomationConfig[K]) {
    setDraft((current) => ({ ...current, config: { ...current.config, [key]: value } }));
  }
  function updateExecution(key: string, value: unknown) {
    try {
      const execution: unknown = JSON.parse(draft.json.execution);
      if (!execution || typeof execution !== "object" || Array.isArray(execution)) return;
      setDraft((current) => ({
        ...current,
        json: { ...current.json, execution: pretty({ ...execution, [key]: value }) },
      }));
    } catch {
      /* Keep invalid JSON intact until the user repairs it. */
    }
  }
  function perform(action: () => Promise<unknown>) {
    setNotice("");
    mutation.mutate(action);
  }
  function act(action: AutomationAction) {
    if (!selected) return;
    if (
      (action === "enable" || action === "resume") &&
      !window.confirm(
        "Approve automatic execution of this automation's captured targets within its configured limits?",
      )
    )
      return;
    perform(async () => {
      const result = await client.automationAction(selected.id, action, selected.revision);
      if ("config" in result) {
        setSelected(result);
        const next = draftOf(result.config);
        setSaved(next);
        setDraft(next);
      } else setInspectJob(result.id);
      setNotice(
        `${action} requested. The project host owns durable work; closing this screen does not stop it.`,
      );
    });
  }
  function actOnJob(current: AutomationJob, action: AutomationJobAction) {
    if (
      ["approve", "retry", "resolve", "cleanup"].includes(action) &&
      !window.confirm(
        `${action} job ${current.id}? ${action === "resolve" ? "Confirm you have inspected and resolved any uncertain external effects." : "This acts on the captured job, not unsaved definition edits."}`,
      )
    )
      return;
    perform(async () => {
      await client.automationJobAction(current.id, action);
      setNotice(`Job ${action} requested.`);
    });
  }
  const config = draft.config;
  let execution: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(draft.json.execution);
    if (value && typeof value === "object" && !Array.isArray(value))
      execution = value as Record<string, unknown>;
  } catch {
    /* The JSON editor below displays the exact parse error. */
  }
  const targetId = config.target.kind === "block" ? config.target.blockId : config.target.runId;
  const availableRuns =
    runs.data?.filter((run) => !run.deletedAt && ["draft", "completed"].includes(run.status)) ?? [];

  return (
    <section className="automation-settings" aria-label="Generic automations">
      <div className="settings-card">
        <h2>Automations</h2>
        <p>
          Durable schedules, signal discovery and bounded execution using your own blocks or saved
          workflows. Legacy GitHub triggers remain in Triggers.
        </p>
        <p>
          Enablement explicitly approves the captured targets and policy. Worktrees isolate
          checkouts, not hostile code. Environment entries are variable names, never credentials.
        </p>
        <div className="automation-actions">
          <Button variant="outline" disabled={busy} onClick={() => load()}>
            New automation
          </Button>
          <Button
            variant="outline"
            disabled={busy || query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh automations
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => perform(() => client.tickAutomations())}
          >
            Check scheduler now
          </Button>
        </div>
        {query.isPending && <p role="status">Loading automations…</p>}
        {error && (
          <pre className="inline-error" role="alert">
            {error}
          </pre>
        )}
        {notice && (
          <p className="setup-notice" role="status">
            {notice}
          </p>
        )}
        {query.data?.automations.length === 0 && (
          <p>
            No saved automations. Create a disabled definition below before approving execution.
          </p>
        )}
        <div className="automation-list">
          {query.data?.automations.map((item) => (
            <Button
              key={item.id}
              variant="outline"
              disabled={busy}
              aria-pressed={selected?.id === item.id}
              onClick={() => load(item)}
            >
              {item.config.name} · {item.state} · revision {item.revision}
            </Button>
          ))}
        </div>
      </div>
      <form
        className="settings-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!validation.config) return;
          const valid = validation.config;
          perform(async () => {
            const result = await client.saveAutomation(valid, selected?.id, selected?.revision);
            const value = draftOf(result.config);
            setSelected(result);
            setSaved(value);
            setDraft(value);
            setNotice(
              `Automation saved and ${result.state}. Captured version ${result.versionId}.`,
            );
          });
        }}
      >
        <h3>{selected ? "Edit automation" : "New automation definition"}</h3>
        {stale && (
          <div className="setup-notice" role="status">
            The saved revision changed. Your local edits are preserved; saving will report a
            conflict until you explicitly reload.
            <Button type="button" variant="outline" disabled={busy} onClick={() => load(latest)}>
              Reload saved automation
            </Button>
            <JsonDetails title="Latest saved configuration" value={latest?.config} />
          </div>
        )}
        <fieldset className="settings-fields" disabled={busy}>
          <div className="field-grid">
            <Field label="Automation name">
              {({ id }) => (
                <input
                  id={id}
                  value={config.name}
                  onChange={(event) => update("name", event.target.value)}
                  required
                />
              )}
            </Field>
            <Field label="Description">
              {({ id }) => (
                <input
                  id={id}
                  value={config.description}
                  onChange={(event) => update("description", event.target.value)}
                />
              )}
            </Field>
            <Field label="Schedule kind">
              {({ id }) => (
                <select
                  id={id}
                  value={config.schedule.kind}
                  onChange={(event) =>
                    update("schedule", scheduleOf(event.target.value as AutomationSchedule["kind"]))
                  }
                >
                  <option value="manual">Manual</option>
                  <option value="interval">Interval</option>
                  <option value="cron">Cron</option>
                  <option value="once">Once</option>
                  <option value="signal">Signal intake</option>
                </select>
              )}
            </Field>
            {config.schedule.kind === "interval" && (
              <Field label="Interval seconds">
                {({ id }) => (
                  <input
                    id={id}
                    type="number"
                    min="1"
                    max="31536000"
                    value={config.schedule.kind === "interval" ? config.schedule.seconds : ""}
                    onChange={(event) =>
                      update("schedule", { kind: "interval", seconds: Number(event.target.value) })
                    }
                  />
                )}
              </Field>
            )}
            {config.schedule.kind === "cron" && (
              <>
                <Field
                  label="Cron expression"
                  help="Five fields: minute hour day-of-month month day-of-week."
                >
                  {({ id }) => (
                    <input
                      id={id}
                      value={config.schedule.kind === "cron" ? config.schedule.expression : ""}
                      onChange={(event) => {
                        if (config.schedule.kind === "cron")
                          update("schedule", {
                            ...config.schedule,
                            expression: event.target.value,
                          });
                      }}
                    />
                  )}
                </Field>
                <Field
                  label="Cron timezone"
                  help="IANA timezone, for example UTC or America/New_York."
                >
                  {({ id }) => (
                    <input
                      id={id}
                      value={config.schedule.kind === "cron" ? config.schedule.timezone : ""}
                      onChange={(event) => {
                        if (config.schedule.kind === "cron")
                          update("schedule", { ...config.schedule, timezone: event.target.value });
                      }}
                    />
                  )}
                </Field>
              </>
            )}
            {config.schedule.kind === "once" && (
              <Field
                label="Once at"
                help="ISO timestamp with timezone, for example 2026-12-01T09:00:00Z."
              >
                {({ id }) => (
                  <input
                    id={id}
                    value={config.schedule.kind === "once" ? config.schedule.at : ""}
                    onChange={(event) =>
                      update("schedule", { kind: "once", at: event.target.value })
                    }
                  />
                )}
              </Field>
            )}
            <Field label="Execution mode">
              {({ id }) => (
                <select
                  id={id}
                  value={config.mode}
                  onChange={(event) =>
                    update("mode", event.target.value as AutomationConfig["mode"])
                  }
                >
                  <option value="direct">Direct</option>
                  <option value="discovery">Discovery</option>
                </select>
              )}
            </Field>
            <Field label="Target kind">
              {({ id }) => (
                <select
                  id={id}
                  value={config.target.kind}
                  onChange={(event) =>
                    update(
                      "target",
                      event.target.value === "block"
                        ? { kind: "block", blockId: Object.keys(library.blocks)[0] ?? "" }
                        : { kind: "workflow", runId: "" },
                    )
                  }
                >
                  <option value="block">Library block</option>
                  <option value="workflow">Saved workflow</option>
                </select>
              )}
            </Field>
            <Field
              label={config.target.kind === "block" ? "Library block" : "Saved workflow"}
              help="Saving captures immutable source and execution settings for future jobs."
            >
              {({ id }) => (
                <select
                  id={id}
                  value={targetId}
                  onChange={(event) =>
                    update(
                      "target",
                      config.target.kind === "block"
                        ? { kind: "block", blockId: event.target.value }
                        : { kind: "workflow", runId: event.target.value },
                    )
                  }
                >
                  <option value="">Choose a target</option>
                  {config.target.kind === "block" ? (
                    <>
                      {targetId && !library.blocks[targetId] && (
                        <option value={targetId}>{targetId} (not in current library)</option>
                      )}
                      {Object.keys(library.blocks).map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </>
                  ) : (
                    <>
                      {targetId && !availableRuns.some((run) => run.id === targetId) && (
                        <option value={targetId}>{targetId} (captured)</option>
                      )}
                      {availableRuns.map((run) => (
                        <option key={run.id} value={run.id}>
                          {run.title} · {run.status} · {run.id.slice(0, 8)}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              )}
            </Field>
            <Field
              label="Workspace"
              help="Worktree requires a Git repository. Project workspace retains exclusive execution."
            >
              {({ id }) => (
                <select
                  id={id}
                  disabled={!execution}
                  value={
                    typeof execution?.workspace === "string" ? execution.workspace : "worktree"
                  }
                  onChange={(event) => updateExecution("workspace", event.target.value)}
                >
                  <option value="worktree">Managed Git worktree</option>
                  <option value="project">Project workspace</option>
                </select>
              )}
            </Field>
            <Field
              label="Environment references"
              help="Comma-separated environment variable names; values are never saved in definitions."
            >
              {({ id }) => (
                <input
                  id={id}
                  disabled={!execution}
                  value={
                    Array.isArray(execution?.environment) ? execution.environment.join(", ") : ""
                  }
                  onChange={(event) =>
                    updateExecution(
                      "environment",
                      event.target.value
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    )
                  }
                />
              )}
            </Field>
          </div>
          {runs.error && <p role="alert">Unable to load saved workflows: {runs.error.message}</p>}
          <Field
            label="Enable automatic execution"
            help="Explicit approval: scheduled and incoming work may execute the captured targets within the configured limits. Output approval remains independent."
          >
            {({ id }) => (
              <input
                id={id}
                type="checkbox"
                checked={config.enabled}
                onChange={(event) => update("enabled", event.target.checked)}
              />
            )}
          </Field>
          {jsonFields.map((key) => (
            <Field key={key} label={labels[key]} help={help[key]}>
              {({ id }) => (
                <textarea
                  id={id}
                  className="automation-json"
                  rows={key === "execution" || key === "policy" ? 10 : 5}
                  spellCheck={false}
                  value={draft.json[key]}
                  aria-invalid={validation.errors.some((error) => error.startsWith(key))}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      json: { ...current.json, [key]: event.target.value },
                    }))
                  }
                />
              )}
            </Field>
          ))}
          {validation.errors.length > 0 && (
            <div className="inline-error" role="alert">
              <strong>Configuration errors</strong>
              <ul>
                {[...new Set(validation.errors)].map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="automation-actions">
            <span>{dirty ? "Unsaved automation changes" : "No unsaved automation changes"}</span>
            <Button
              type="button"
              variant="outline"
              disabled={!dirty}
              onClick={() => setDraft(saved)}
            >
              Discard automation changes
            </Button>
            <Button type="submit" disabled={!validation.config || (!!selected && !dirty)}>
              Save automation
            </Button>
          </div>
        </fieldset>
      </form>
      {selected && (
        <div className="settings-card">
          <h3>Persisted automation</h3>
          <p>
            {latest?.state ?? selected.state} · Revision {latest?.revision ?? selected.revision} ·
            Version {latest?.versionId ?? selected.versionId}
          </p>
          <p>
            Next fire:{" "}
            {latest?.nextFireAt != null
              ? new Date(latest.nextFireAt).toLocaleString()
              : "Not scheduled"}
          </p>
          {latest?.error && <p role="alert">{latest.error}</p>}
          <JsonDetails
            title="Persisted checkpoint"
            value={latest?.checkpoint ?? selected.checkpoint ?? null}
          />
          <JsonDetails title="Captured version and targets" value={version.data ?? null} />
          {version.error && (
            <p role="alert">Unable to load captured version: {version.error.message}</p>
          )}
          <p>
            Test creates a reviewable job; it does not grant execution or publication approval. Run
            now uses the saved version and policy, not unsaved edits.
          </p>
          <div className="automation-actions">
            {(["enable", "pause", "disable", "resume", "run-now", "test"] as const).map(
              (action) => {
                const state = latest?.state ?? selected.state;
                const allowed =
                  action === "enable"
                    ? state === "disabled"
                    : action === "pause"
                      ? state === "enabled"
                      : action === "resume"
                        ? state === "paused"
                        : action === "disable"
                          ? state !== "disabled"
                          : true;
                return (
                  <Button
                    key={action}
                    variant="outline"
                    disabled={busy || dirty || stale || !allowed}
                    onClick={() => act(action)}
                  >
                    {
                      {
                        enable: "Enable automation",
                        pause: "Pause automation",
                        disable: "Disable automation",
                        resume: "Resume automation",
                        "run-now": "Run now",
                        test: "Test automation",
                      }[action]
                    }
                  </Button>
                );
              },
            )}
          </div>
        </div>
      )}
      <div className="settings-card">
        <h3>Queue and jobs</h3>
        <p>
          Job state is distinct from execution-run state. Admission reasons and frozen version IDs
          are retained. Usage and cost estimates may be incomplete: unpriced calls and external
          effects are not zero-cost estimates.
        </p>
        {jobs.length === 0 && <p>No jobs in this view.</p>}
        <div className="automation-list">
          {jobs.map((item) => (
            <article key={item.id} className="automation-job" aria-label={`Job ${item.id}`}>
              <strong>
                {item.automationName} · {item.phase}
                {item.test ? " · test" : ""}
              </strong>
              <p>
                {item.status} · Run: {item.runStatus ?? "not created"} · Attempt {item.attempt}
              </p>
              <p>{item.reason ?? "No admission or recovery reason recorded."}</p>
              <p>
                Usage:{" "}
                {item.usage
                  ? `$${item.usage.costUsd.toFixed(4)} recorded · ${item.usage.requests} requests · ${item.usage.unpricedRequests} unpriced`
                  : "Not yet available"}
                {item.usageIncomplete
                  ? " · Incomplete accounting; capped admission blocked"
                  : " · Provider estimates; subscription quotas are not billing totals"}
              </p>
              <div className="automation-actions">
                <Button variant="outline" onClick={() => setInspectJob(item.id)}>
                  Inspect job {item.id.slice(0, 8)}
                </Button>
                {item.runStatus && (
                  <Link to="/" search={{ run: item.runId }}>
                    Open workflow
                  </Link>
                )}
                {jobActions(item).map((action) => (
                  <Button
                    key={action}
                    variant="outline"
                    disabled={busy}
                    onClick={() => actOnJob(item, action)}
                  >
                    {action[0]!.toUpperCase() + action.slice(1)} job
                  </Button>
                ))}
              </div>
            </article>
          ))}
        </div>
        {job && (
          <div className="automation-job">
            <h4>Selected job {job.id}</h4>
            <pre>{pretty(job)}</pre>
            {job.priorRunIds.map((id) => (
              <Link key={id} to="/" search={{ run: id }}>
                Prior run {id}
              </Link>
            ))}
          </div>
        )}
      </div>
      <div className="settings-card">
        <h3>Cases, events and audit</h3>
        <p>
          Cases are shared across automations by source and correlation key. Events show intake
          dispositions; audit messages retain scheduler and operator reasons.
        </p>
        {query.data?.cases.map((item) => (
          <div key={item.id} className="automation-job">
            <JsonDetails
              title={`Case ${item.sourceId} · ${item.correlationKey} · revision ${item.currentRevision}`}
              value={item}
            />
            {item.lastRunId && (
              <Link to="/" search={{ run: item.lastRunId }}>
                Open case workflow
              </Link>
            )}
          </div>
        ))}
        <JsonDetails
          title="Signal events and dispositions"
          value={
            query.data?.observations.filter(
              (item) => !selected || item.automationId === selected.id,
            ) ?? []
          }
        />
        {(
          query.data?.audit.filter((item) => !selected || item.automationId === selected.id) ?? []
        ).map((item) => (
          <p key={item.id}>
            <time>{item.time}</time> · {item.kind} · {item.message}
            {item.jobId && (
              <Button variant="link" onClick={() => setInspectJob(item.jobId)}>
                Inspect audit job
              </Button>
            )}
          </p>
        ))}
        <JsonDetails title="Scheduler limits" value={query.data?.settings ?? null} />
        <JsonDetails
          title="Recorded usage by automation (estimates may be incomplete)"
          value={query.data?.usage ?? {}}
        />
      </div>
    </section>
  );
}
