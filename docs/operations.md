# Running and recovering workflows

[Documentation](README.md) → Running and recovering workflows

## Read the result before the event log

The task workspace shows a result banner above the graph. **Results** collects the summary, verification evidence, and named artifacts. Markdown is rendered with copy/download controls. **Activity** shows the underlying model messages, tools, command output, and usage; search it or filter to a particular block.

The graph highlights all active steps. A selected step exposes its visits, inputs, and activity. Parallel streams remain separate, so one block's messages do not replace another's. **Expand** gives the graph, results, activity, and editor more room; Esc closes the expanded view. Dragging blocks changes only their saved display positions.

Notifications record run updates received while the app is open. They are a convenience for finding outcomes, not an independent background notification service. Finalized events persist; individual streaming text deltas do not all become separate history records.

## Task and run statuses

Planning has its own task state: queued, planning, needs input, ready, failed, or cancelled. A ready task links to a workflow run. The run has a separate lifecycle:

| Run status    | Meaning                                                               | Next action                                                           |
| ------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `draft`       | Source and graph are saved; no execution has started.                 | Edit, approve, or reject.                                             |
| `running`     | The approved workflow is executing.                                   | Inspect activity, pause, or stop.                                     |
| `pausing`     | Pause requested; active work is finishing.                            | Wait for the boundary.                                                |
| `paused`      | No new steps will start until resumed.                                | Resume or cancel.                                                     |
| `interrupted` | An activity failed or recovery needs attention.                       | Inspect effects, resolve conflicts, then explicitly resume.           |
| `completed`   | The workflow reached successful completion.                           | Inspect its actual findings and artifacts.                            |
| `failed`      | Code, routing, a condition, or an execution limit ended the workflow. | Read the cause and create a corrected task/workflow when appropriate. |
| `cancelled`   | Execution was stopped.                                                | Inspect retained effects and recovery results.                        |
| `rejected`    | The draft was declined before execution.                              | Create another task if needed.                                        |

A terminal `failed` run is different from an `interrupted` run awaiting resume. A passing command is evidence about that command; a completed workflow is not a guarantee that every requested behavior is correct. Read the block's findings.

## Approval and cancellation

Review mode is the default. Automatic mode can be selected in **Settings → Execution**. Approval captures the current source and configuration and starts that execution; it is not an OS permission prompt for every command.

Browser task submissions pin the approval policy displayed by that composer. Another client's settings change does not retroactively change that submission's approval decision. Reloading the page reads the current project default.

Unmanaged workflows retain exclusive project ownership, including while paused or interrupted. Resume or cancel that owner before competing work. [Automation jobs](automations.md#queue-admission-and-workspace-ownership) can instead execute concurrently in distinct owned Git worktrees within scheduler limits; project-workspace jobs remain exclusive. Approving a linked automation draft does not bypass its scheduler approval, ownership, or budget guards.

Stopping planning cancels model work and prevents a late result from publishing an executable draft. Stopping execution cancels active activities, prevents new steps, and settles each active attempt. It does not undo completed steps or arbitrary shell/Git/network effects.

Deleting a settled workflow removes it and its linked task from the visible history. Stop active or paused work first. Deletion does not revert project files or erase all underlying journals, attachments, and Temporal history. Use backups and a deliberate retention policy for private runtime data.

## Pause, restart, and resume

Pause lets active steps finish before admitting more work. For a parallel group, all active branches drain. Queued branches wait. Closing the browser or TUI does not pause or cancel execution. `workflow` and `workflow start` open the TUI, using a host that outlives clients. `workflow --background` starts or reuses that host without opening the TUI. `workflow --web` opens the browser and runs a new host in the foreground until Ctrl+C; an existing host is reused.

`workflow status` reports the running host. `workflow stop` requests authenticated shutdown, waits for the application and project lease to close, and stops its worker and managed local Temporal process, while execution history remains on disk. `workflow serve` is the explicit foreground alternative and also stops on Ctrl+C. Restart in the same project and mode. Completed recorded operations are replayed from history rather than executed again. An activity that was in progress when its worker disappeared may leave the run interrupted.

Startup refuses an active, paused, or interrupted run saved under a different execution mode before starting its workers. Reopen in the original mode to settle it. File recovery, including explicit recovery requests, also requires the original mode; demo mode cannot restore a live run's journaled task files.

Shutdown stops admitting new planning requests and drains submissions, answers, and retries already in flight before releasing project ownership. Accepted requests that have not started planning are saved as cancelled rather than stranded in a queued state. Failed Temporal workers are removed from available executors; approval requires a healthy worker and reports an admission failure instead of silently accepting work that cannot progress.

An explicit resume of an interrupted run retries the affected step in a fresh attempt. It consumes another visit and total step, and can repeat effects from that attempt. Completed siblings and earlier steps are retained. It does not continue in the middle of an unfinished model request.

Transient provider requests can retry up to twice inside the same AI conversation, retaining tool results and cumulative limits. That is separate from retrying an activity or repeating a workflow loop. Activity failures do not automatically restart a mutating block.

CLI controls require the server to be running for the same project:

```sh
workflow status
workflow runs
workflow pause <run-id>
workflow resume <run-id>
workflow cancel <run-id>
workflow recover <run-id>
```

See [the command reference](reference.md) for ports and options.

## Resuming project setup

Project setup runs in the shared core host. Closing a browser or terminal detaches that client; it does not cancel generation. Open setup in either interface to see the same job and its progress through model profiles, task instructions, reusable blocks, validation, and publication.

The CLI commands `workflow setup` and `workflow setup-resume <job-id>` wait until generation finishes and report failures through their exit status. Add `--no-wait` to return after starting. Ctrl+C stops following progress; use `workflow setup-cancel <job-id>` to cancel the job itself. `workflow setup-status` returns a snapshot without waiting. Explicit `--wait` is still supported for compatibility and to follow a status query.

Accepted stages are saved immediately. After a provider failure or host restart, explicitly resume the job to continue from its unfinished stage. Earlier accepted proposals and their usage remain attached to the same job. Resuming can make another model request for an unfinished stage, but does not regenerate completed stages. Starting the host alone never resumes paid setup work.

The current library stays usable during generation. Setup publishes the complete validated configuration together. Concurrent settings or source edits cause a conflict instead of being silently overwritten. A failed regeneration leaves the previous successful setup available. Cancellation is available during generation; the short publication step must finish or be recovered.

## File recovery

Managed writes through `ctx.writeFile` and AI file tools journal the original content before publishing a change. With recovery enabled, failed, retried, cancelled, or interrupted attempts restore their own managed writes and remove files they created. Passing attempts retain their changes. A recovery status of `committed` means the journal accepted those writes; it does not mean a Git commit was created.

Recovery compares hashes before restoring. If manual edits or command effects changed a tracked file, it reports a conflict rather than overwriting it. Parallel managed writes also retain ownership claims so one attempt cannot roll back another's work. Claims use physical project paths across restarts, so opening a project through a symbolic-link alias does not bypass ownership; successful commit or rollback releases the attempt's claims.

To resolve a conflict:

1. Read the attempt's recovery report and inspect the affected files.
2. Preserve any manual work you want to keep.
3. Resolve the file to the expected original or journaled state, as appropriate for the intended recovery.
4. Select **Retry file recovery** or run `workflow recover <run-id>`.
5. Resume an interrupted run only after its recovery conflicts are resolved.

Recovery is idempotent: repeating it does not undo an already-completed step. `recovery: { "rollbackOnFailure": false }` in project config keeps failed-attempt managed changes for new workflows; changing it does not alter an existing snapshot.

The journal does not undo Bash edits, Git operations, check-command effects, external services, or all filesystem metadata. A successful commit/push may remain even if the surrounding activity was interrupted. Inspect those effects before retrying the step.

## Operating automation jobs

Open **Settings → Automations**, terminal `/automations`, or `workflow automation jobs --json`. Jobs have their own queue/admission state and a linked workflow `runStatus`. Inspect the persisted reason before acting: queued work may be waiting for capacity, a case/resource owner, cooldown, enablement, or cost reservations; `waiting` can mean approval or a paused run; `needs_attention` requires inspection.

Pause/disable a definition to stop future scheduling and queued starts, not to cancel running jobs. Pause/cancel individual jobs separately. After a restart, the scheduler reacquires stable run reservations and reconciles recorded results. **Retry** is only failed admission before execution, not a fresh execution of an uncertain mutation. **Resume** of an interrupted run is explicit and can repeat effects from its interrupted attempt. Read-only direct/discovery retries must be explicitly configured and bounded.

Publication is a separate approval-gated output job by default. Check its stable publication key against remote state; use configured read-only **Reconcile**, or explicit **Resolve** only after confirming the outcome. A negative lookup stays human-gated. Nothing merges/deploys automatically. Keep interrupted mutation evidence instead of deleting jobs or resetting the database.

Managed worktree cleanup is explicit and terminal-only; dirty or unpublished commits prevent removal. Paused jobs release compute only after execution stops and retain their case/workspace. See [the automation guide](automations.md) for exact schedule, downtime, budget, and output contracts.

## Persistence and backups

```text
.workflow/
├── config.json               # reusable project settings
├── orchestration.json        # profiles, cases, capabilities, approval
├── blocks/                   # directory-backed reusable blocks
├── library.json              # active web-managed library, when present
├── libraries/                # prior library snapshots
├── library-proposals/        # saved library proposals
├── design-chats/             # settings conversations
├── setup-jobs/               # saved setup stages and accepted proposals
├── setup.json                # last successfully published setup
├── settings-publications/    # resumable setup publication journals
├── settings-publication.json # current publication generation and commit state
├── tasks/                    # requests and planning history
├── usage/                    # durable model-session costs and task/setup scopes
├── attachments/              # uploaded request data
├── runs/                     # approval snapshots, events, attempt journals
├── versions/                 # archived workflow bundles, tools.js and manifests
├── temporal/                 # managed SQLite execution history and logs
├── host.log                  # private background-host startup/runtime log
├── server.json               # private host identity and shutdown token
├── triggers/                 # SQLite trigger settings, inbox, checkpoints and outbox
├── automations/              # SQLite definitions, frozen targets, signals, cases, jobs and audit
├── automation-workspaces/    # owned Git worktrees; preserve dirty/unpublished work
├── server-lease/             # live project ownership lease
└── lock                      # diagnostic owner information
```

Back up the whole `.workflow/` directory, including automation/trigger state, version archives, attempt journals, and Temporal SQLite/WAL files. Stop the application for a consistent file-copy backup. Managed worktrees also depend on the repository's Git metadata/objects: preserve the repository and relevant worktree data, not only scheduler JSON. With an external Temporal service, its history also needs its own backup policy. Credentials are stored separately; see [Configuration](configuration.md#where-settings-live).

Do not delete Temporal history or version bundles to reset an active run. Local run JSON is a projection and approval record; it cannot replace missing execution history.

## Versioned execution

New drafts archive their compiled code and SDK manifest by content hash. Active runs use their archived bundle after an application-code upgrade; new drafts use the new implementation. The runtime also retains compatibility for older Temporal executions.

Archive integrity and SDK compatibility are checked before a worker starts. Missing/corrupt bundles or an incompatible SDK require restoring the archive or running a compatible application version. Arbitrary SDK/activity migrations are not automatic.

Temporal SDK upgrades require a clean bundle rebuild: SDK 1.25.0 checks the generated bundle's version annotation and requires the bundle and worker to use the exact same SDK version. Do not reuse an older `dist/` directory or edit archived manifests to bypass this check. Before upgrading a project with active, paused, or interrupted runs, finish or cancel them using the compatible application version; otherwise retain that runtime to settle those runs. Back up the project before switching versions.

Approval first persists a pending start receipt. If a crash occurs before Temporal accepts the start and no execution exists, startup can restore the unstarted draft for review. A confirmed execution with missing history is different and requires restoring its history.

## Troubleshooting

| Symptom                                                 | What to check                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “No complete `.workflow/` configuration”                | Run `workflow init` from the intended project folder. The CLI does not search parent folders.                                                                                                                                   |
| Model unavailable or unsupported for the account        | Refresh the connected catalog, select a supported model, then update the draft or replan. Defaults do not change existing drafts.                                                                                               |
| Planning stopped without a workflow                     | Open Planning activity for the validation/provider error. The coordinator has automatic correction continuations, but time/tool limits and persistent errors can still stop planning.                                           |
| “Primitive … declared but unused”                       | Attach the step/group to the exported `flow`, or remove an intentionally excluded declaration.                                                                                                                                  |
| Review has no branch/base comparison                    | The execution step should inspect the baseline and adapt to accessible working files when no base exists. Findings must state that limitation.                                                                                  |
| Command exited nonzero but workflow continued           | `ctx.exec` returns status as data. Set `ctx.outcome`, throw, or branch on the result explicitly.                                                                                                                                |
| A loop stopped before approval                          | Check both `maxIterations` and per-step/total visit limits, and the step's outcome actions.                                                                                                                                     |
| Parallel AI appears sequential                          | A spending limit serializes model sessions against the remaining budget. Group concurrency and the overall eight-step cap also apply.                                                                                           |
| Parallel file conflict                                  | Sequence overlapping edits. Commands bypass managed-write claims, so review their effects too.                                                                                                                                  |
| Host startup fails or the host has stopped unexpectedly | Run `workflow status --json` and inspect `.workflow/host.log`. Use `--port 0` if another project owns the default port. A background host does not restart itself after a crash or reboot.                                      |
| Another workflow owns the project                       | Resume or cancel the paused/interrupted execution before approving a competing run.                                                                                                                                             |
| Saved block file edits do not appear                    | Check the active manifest's `sourceFiles`. Old inline-only libraries become source-backed after the next Apply/setup; current generated blocks load their registered `block.ts` files. Existing runs retain approved snapshots. |
| Missing Temporal history or archive                     | Restore the matching project backup. Do not delete more state or start the old work under a new snapshot.                                                                                                                       |
| Stale form/draft revision                               | Load the latest version, reconcile your edits, and save again.                                                                                                                                                                  |
| Bun warns about `v8.promiseHooks.createHook`            | The pinned SDK cannot collect workflow stack traces on Bun. It is a diagnostic limitation; execution still uses Temporal.                                                                                                       |

## Current boundaries

The web server and managed Temporal development service bind locally. They are single-user services, not authenticated remote interfaces. Keep them on loopback. Host/origin guards and mutation headers do not turn them into a multi-user service.

AI and command tools have the server user's access. Role instructions and automation-owned Git worktrees do not impose an OS sandbox. Explicit parallel composition and managed automation worktrees exist; container isolation, remote sandbox workers, and full rollback of shell/external effects do not. The authenticated signal-intake endpoint retains the same local host/origin boundary and is not public multi-user hosting.

On Linux and macOS, a verified managed Temporal process left after SIGKILL is adopted on restart. Recovery checks the executable and exact project database, loopback address, and port arguments before reusing or stopping a saved PID; a live PID whose ownership cannot be verified still blocks startup. External Temporal address/namespace selection is supported; Temporal Cloud TLS/API-key onboarding is not implemented.
