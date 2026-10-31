import { useEffect, useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { resolveAgentSettings } from "../../../src/contracts/index.js";
import type { SetupJobsController } from "./use-setup-jobs.js";
import { setupActive, setupStageLabels, setupStatusLabels } from "./setup-presentation.js";
import Icon from "../../shared/Icon.js";
import { useAutosize } from "../../shared/autosize.js";
import UsageSummary from "../usage/UsageSummary.js";
import "./SetupProgress.css";

type SetupProgressProps = {
  controller: SetupJobsController;
  compact?: boolean;
  blocked?: boolean;
  defaultLimit?: number;
  demo?: boolean;
  onSettings?: () => void;
};

export default function SetupProgress(props: SetupProgressProps) {
  return <SetupProgressDetails key={props.controller.state.job?.id ?? "initial"} {...props} />;
}

function SetupProgressDetails({
  controller,
  compact = false,
  blocked = false,
  defaultLimit,
  demo = false,
  onSettings,
}: SetupProgressProps) {
  const { state } = controller;
  const { job } = state;
  const active = setupActive(job);
  const completed = state.setup?.completedSetup;
  const agent =
    state.setup && resolveAgentSettings(state.setup.userAgent, state.setup.projectAgent);
  const hasDefault = !!(agent?.provider && agent.model);
  const connected =
    !!agent?.provider &&
    !!state.setup?.providers.some((provider) => provider.id === agent.provider);
  const resumeConnected =
    !!job && !!state.setup?.providers.some((provider) => provider.id === job.model.provider);
  const needsModelToResume = !!job?.stages.some(
    (stage) => ["profiles", "cases", "blocks"].includes(stage.id) && stage.status !== "completed",
  );
  const setupForm = useForm({
    defaultValues: { instructions: "" },
    onSubmit: ({ value }) =>
      controller.start({ instructions: value.instructions, regenerate: !!(completed || job) }),
  });
  const instructions = useStore(setupForm.store, (state) => state.values.instructions);
  const [showForm, setShowForm] = useState(false);
  const [copied, setCopied] = useState(false);
  const resumeForm = useForm({
    defaultValues: { limit: "" },
    onSubmit: async ({ value }) => {
      if (needsModelToResume && !validResumeLimit) return;
      await controller.resume(needsModelToResume && value.limit ? Number(value.limit) : undefined);
    },
  });
  const resumeLimit = useStore(resumeForm.store, (state) => state.values.limit);
  useEffect(() => {
    resumeForm.reset();
  }, [resumeForm, job?.revision]);
  const validResumeLimit =
    !resumeLimit ||
    (Number.isFinite(Number(resumeLimit)) &&
      Number(resumeLimit) > 0 &&
      Number(resumeLimit) >= (job?.maxSetupCostUsd ?? 0));
  const needsAttention =
    !!job && ["failed", "interrupted", "cancelled", "conflicted"].includes(job.status);
  const showInitialForm = !job && !completed;
  const textarea = useAutosize(instructions);
  function newSetup() {
    setupForm.setFieldValue("instructions", job?.instructions ?? "");
    setShowForm(true);
  }
  async function copyId() {
    if (!job) return;
    try {
      await navigator.clipboard.writeText(job.id);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  if (demo && !job && compact) return null;
  return (
    <section className={`setup-progress${compact ? " compact" : ""}`} aria-label="Project setup">
      <div className="setup-progress-heading">
        <Icon name="workflow" size={compact ? 19 : 23} />
        <div>
          <strong>
            {job
              ? setupStatusLabels[job.status]
              : completed
                ? "Project setup saved"
                : "Set up this project"}
          </strong>
          {compact && (
            <p>
              {active && job
                ? setupStageLabels[job.stage]
                : hasDefault
                  ? `Default model: ${agent?.model}`
                  : "Connect a provider, save a default model, then generate your reusable library."}
            </p>
          )}
        </div>
        {compact ? (
          <button className="quiet" onClick={onSettings}>
            {job ? "View setup" : "Configure"}
          </button>
        ) : (
          <button
            className="quiet"
            disabled={state.loading || state.pending}
            onClick={() => void controller.refresh()}
          >
            Refresh setup
          </button>
        )}
      </div>
      {compact ? (
        <>
          {completed && job?.status !== "completed" ? (
            <p className="setup-saved-note">Your previous saved setup remains available.</p>
          ) : completed?.counts ? (
            <p className="setup-saved-note">
              {completed.counts.profiles} model roles · {completed.counts.cases} task presets ·{" "}
              {completed.counts.blocks} blocks
            </p>
          ) : (
            !completed &&
            !active && (
              <p className="setup-saved-note">
                {hasDefault && connected
                  ? "Generate project-specific roles, task instructions and blocks in Settings."
                  : "Save a default model from a connected provider in Settings."}
              </p>
            )
          )}
        </>
      ) : (
        <>
          <p className="setup-description">
            Your saved default model inspects this project and creates reusable model roles, task
            instructions and TypeScript blocks. Project settings update together after validation.
            You can follow the same setup in the browser and terminal.
          </p>
          {demo && (
            <p className="setup-readiness">
              Project setup requires a live project host. Demo mode does not generate or apply AI
              setup.
            </p>
          )}
          {completed && (
            <div className="setup-saved-note" aria-label="Last successful setup">
              <Icon name="check" size={15} />
              <span>
                Last saved {new Date(completed.completedAt).toLocaleString()}
                {completed.counts && (
                  <>
                    {" "}
                    · {completed.counts.profiles} model roles · {completed.counts.cases} task
                    presets · {completed.counts.blocks} blocks
                  </>
                )}
                .
                {job && job.status !== "completed" && (
                  <> This saved setup remains available while the new setup is unfinished.</>
                )}
              </span>
            </div>
          )}
          {(!hasDefault || !connected) && (
            <p className="setup-readiness" role="status">
              {!hasDefault
                ? "Save a default model above before starting setup."
                : `Connect ${agent?.provider} or save a model from a connected provider before starting a new setup.`}
            </p>
          )}
          {blocked && (
            <p className="setup-readiness" role="status">
              Save or discard your settings edits before starting or resuming setup.
            </p>
          )}
          {job && (
            <details className="setup-job-details" open={active || needsAttention}>
              <summary>
                {setupStatusLabels[job.status]} ·{" "}
                {job.stages.filter((stage) => stage.status === "completed").length}/
                {job.stages.length} stages complete
              </summary>
              <div className="setup-job-identity">
                <span>
                  Setup ID <code>{job.id}</code>
                </span>
                <button className="quiet" onClick={() => void copyId()}>
                  {copied ? "Copied" : "Copy setup ID"}
                </button>
              </div>
              <p className="setup-model">
                {job.model.provider}/{job.model.model} · {job.model.thinking} thinking
              </p>
              <ol className="setup-stage-list" aria-label="Setup stages">
                {job.stages.map((stage) => (
                  <li key={stage.id} className={stage.status}>
                    <span className="setup-stage-icon">
                      {stage.status === "completed" ? (
                        <Icon name="check" size={15} />
                      ) : stage.status === "running" && active ? (
                        <span className="spinner" />
                      ) : ["failed", "interrupted"].includes(stage.status) ? (
                        <Icon name="alert" size={15} />
                      ) : (
                        <span className="setup-stage-dot" />
                      )}
                    </span>
                    <div>
                      <strong>{setupStageLabels[stage.id]}</strong>
                      <small>
                        {stage.status === "completed"
                          ? stage.id === "applying"
                            ? "Saved"
                            : "Ready"
                          : stage.status === "pending"
                            ? "Waiting"
                            : stage.status === "running"
                              ? "In progress"
                              : stage.status === "interrupted"
                                ? "Interrupted"
                                : "Needs attention"}
                        {stage.attempt > 1 && <> · attempt {stage.attempt}</>}
                      </small>
                      {stage.summary && <p>{stage.summary}</p>}
                      {stage.error && <p className="setup-job-error">{stage.error}</p>}
                    </div>
                  </li>
                ))}
              </ol>
              {job.activity && active && (
                <p className="setup-activity" role="status">
                  {job.activity}
                </p>
              )}
              {(job.error || job.conflict) && (
                <div className="setup-job-error" role="status">
                  <p>{job.conflict?.message ?? job.error}</p>
                  {!!job.conflict?.paths?.length && (
                    <ul>
                      {job.conflict.paths.map((path) => (
                        <li key={path}>
                          <code>{path}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {job.conflict?.requiresRegeneration ? (
                <p>
                  Settings changed after this setup began. Start a new setup to use the current
                  project settings.
                </p>
              ) : (
                job.actions.canResume && (
                  <p>
                    {needsModelToResume
                      ? "Completed stages are retained. Resume retries the unfinished stage with the same model and spending limit."
                      : "Completed generation is retained. Resume finishes validation and saving without new model calls."}
                  </p>
                )
              )}
              {job.actions.canResume && needsModelToResume && !resumeConnected && (
                <p className="setup-readiness">
                  Connect {job.model.provider} to resume this setup.
                </p>
              )}
              {job.actions.canResume && needsModelToResume && job.maxSetupCostUsd !== undefined && (
                <div className="setup-resume-limit">
                  <label htmlFor="setup-resume-limit">
                    Increase setup limit (USD) <span>optional</span>
                  </label>
                  <input
                    id="setup-resume-limit"
                    value={resumeLimit}
                    onChange={(event) => resumeForm.setFieldValue("limit", event.target.value)}
                    type="number"
                    min={job.maxSetupCostUsd}
                    step="any"
                    placeholder={String(job.maxSetupCostUsd)}
                    disabled={state.pending || blocked || demo}
                  />
                  <small>
                    Leave blank to keep ${job.maxSetupCostUsd}. A higher limit keeps the same setup
                    and its completed stages.
                  </small>
                  {!validResumeLimit && (
                    <p className="setup-job-error">
                      Enter a limit of at least ${job.maxSetupCostUsd}.
                    </p>
                  )}
                </div>
              )}
              <div className="setup-job-actions">
                {job.actions.canResume && (
                  <button
                    className="primary"
                    disabled={
                      state.pending ||
                      blocked ||
                      (needsModelToResume && !resumeConnected) ||
                      demo ||
                      (needsModelToResume && !validResumeLimit)
                    }
                    onClick={() => void resumeForm.handleSubmit()}
                  >
                    Resume setup
                  </button>
                )}
                {job.actions.canCancel && (
                  <button disabled={state.pending} onClick={() => void controller.cancel()}>
                    Cancel setup
                  </button>
                )}
                {active && (
                  <span>
                    {job.stage === "applying" && !job.actions.canCancel
                      ? "Finishing the saved setup. This stage cannot be cancelled."
                      : "You can leave this screen. The project host saves progress."}
                  </span>
                )}
              </div>
              <UsageSummary
                scope="setup"
                scopeId={job.id}
                revision={job.revision}
                active={active}
              />
            </details>
          )}
          {!active && !showInitialForm && !showForm && (
            <button
              className="quiet setup-restart"
              disabled={state.pending || blocked || !hasDefault || !connected || demo}
              onClick={newSetup}
            >
              {completed ? "Regenerate project setup" : "Start a new setup"}
            </button>
          )}
          {(showInitialForm || showForm) && !active && (
            <form
              className="setup-start-form"
              onSubmit={(event) => {
                event.preventDefault();
                void setupForm.handleSubmit();
              }}
            >
              <label htmlFor="setup-preferences">
                Setup preferences <span>optional</span>
              </label>
              <setupForm.Field name="instructions">
                {(field) => (
                  <textarea
                    id="setup-preferences"
                    name={field.name}
                    ref={textarea}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                    rows={2}
                    maxLength={8000}
                    placeholder="For example: prioritize low cost, keep publication manual, use the existing test commands…"
                    disabled={state.pending || blocked}
                  />
                )}
              </setupForm.Field>
              <p>
                Uses{" "}
                {hasDefault ? `${agent?.provider}/${agent?.model}` : "your saved default model"}.{" "}
                {defaultLimit !== undefined ? (
                  <>Setup spending limit: ${defaultLimit}.</>
                ) : (
                  <>No setup spending limit is configured.</>
                )}{" "}
                Set a limit in Execution settings.
              </p>
              <div>
                <button
                  className="primary"
                  disabled={state.pending || blocked || !hasDefault || !connected || demo}
                >
                  {state.pending
                    ? "Starting…"
                    : completed
                      ? "Regenerate setup"
                      : "Generate project setup"}
                </button>
                {showForm && (
                  <button
                    type="button"
                    className="quiet"
                    disabled={state.pending}
                    onClick={() => setShowForm(false)}
                  >
                    Keep current setup
                  </button>
                )}
              </div>
            </form>
          )}
        </>
      )}
      {state.error ? (
        <p className="setup-job-error" role="status">
          Could not update setup: {state.error}
        </p>
      ) : (
        !state.setup && (
          <p className="setup-loading" role="status">
            Loading saved setup…
          </p>
        )
      )}
    </section>
  );
}
