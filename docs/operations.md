# Running and recovering workflows

[Documentation](README.md) → Running and recovering workflows

## Read the result before the event log

The task workspace shows a result banner above the graph. **Results** collects the summary, verification evidence, and named artifacts. Markdown is rendered with copy/download controls. **Activity** shows the underlying model messages, tools, command output, and usage; search it or filter to a particular block.

The graph highlights all active steps. A selected step exposes its visits, inputs, and activity. Parallel streams remain separate, so one block's messages do not replace another's. **Expand** gives the graph, results, activity, and editor more room; Esc closes the expanded view. Dragging blocks changes only their saved display positions.

Notifications record run updates received while the app is open. They are a convenience for finding outcomes, not an independent background notification service. Finalized events persist; individual streaming text deltas do not all become separate history records.

## Task and run statuses

Planning has its own task state: queued, planning, needs input, ready, failed, or cancelled. A ready task links to a workflow run. The run has a separate lifecycle:

| Run status | Meaning | Next action |
| --- | --- | --- |
| `draft` | Source and graph are saved; no execution has started. | Edit, approve, or reject. |
| `running` | The approved workflow is executing. | Inspect activity, pause, or stop. |
| `pausing` | Pause requested; active work is finishing. | Wait for the boundary. |
| `paused` | No new steps will start until resumed. | Resume or cancel. |
| `interrupted` | An activity failed or recovery needs attention. | Inspect effects, resolve conflicts, then explicitly resume. |
| `completed` | The workflow reached successful completion. | Inspect its actual findings and artifacts. |
| `failed` | Code, routing, a condition, or an execution limit ended the workflow. | Read the cause and create a corrected task/workflow when appropriate. |
| `cancelled` | Execution was stopped. | Inspect retained effects and recovery results. |
| `rejected` | The draft was declined before execution. | Create another task if needed. |

A terminal `failed` run is different from an `interrupted` run awaiting resume. A passing command is evidence about that command; a completed workflow is not a guarantee that every requested behavior is correct. Read the block's findings.

## Approval and cancellation

Review mode is the default. Automatic mode can be selected in **Settings → Execution**. Approval captures the current source and configuration and starts that execution; it is not an OS permission prompt for every command.

Only one workflow executes in a project at a time. Paused and interrupted runs retain that ownership. Resume or cancel the existing run before starting another.

Stopping planning cancels model work and prevents a late result from publishing an executable draft. Stopping execution cancels active activities, prevents new steps, and settles each active attempt. It does not undo completed steps or arbitrary shell/Git/network effects.

Deleting a settled workflow removes it and its linked task from the visible history. Stop active or paused work first. Deletion does not revert project files or erase all underlying journals, attachments, and Temporal history. Use backups and a deliberate retention policy for private runtime data.

## Pause, restart, and resume

Pause lets active steps finish before admitting more work. For a parallel group, all active branches drain. Queued branches wait. Closing the browser does not pause or cancel execution.

Stopping the application stops its worker and managed local Temporal process, while execution history remains on disk. Restart in the same project and mode. Completed recorded operations are replayed from history rather than executed again. An activity that was in progress when its worker disappeared may leave the run interrupted.

An explicit resume of an interrupted run retries the affected step in a fresh attempt. It consumes another visit and total step, and can repeat effects from that attempt. Completed siblings and earlier steps are retained. It does not continue in the middle of an unfinished model request.

Transient provider requests can retry up to twice inside the same AI conversation, retaining tool results and cumulative limits. That is separate from retrying an activity or repeating a workflow loop. Activity failures do not automatically restart a mutating block.

CLI controls require the server to be running for the same project:

```sh
workflow runs
workflow pause <run-id>
workflow resume <run-id>
workflow cancel <run-id>
workflow recover <run-id>
```

See [the command reference](reference.md) for ports and options.

## File recovery

Managed writes through `ctx.writeFile` and AI file tools journal the original content before publishing a change. With recovery enabled, failed, retried, cancelled, or interrupted attempts restore their own managed writes and remove files they created. Passing attempts retain their changes. A recovery status of `committed` means the journal accepted those writes; it does not mean a Git commit was created.

Recovery compares hashes before restoring. If manual edits or command effects changed a tracked file, it reports a conflict rather than overwriting it. Parallel managed writes also retain ownership claims so one attempt cannot roll back another's work.

To resolve a conflict:

1. Read the attempt's recovery report and inspect the affected files.
2. Preserve any manual work you want to keep.
3. Resolve the file to the expected original or journaled state, as appropriate for the intended recovery.
4. Select **Retry file recovery** or run `workflow recover <run-id>`.
5. Resume an interrupted run only after its recovery conflicts are resolved.

Recovery is idempotent: repeating it does not undo an already-completed step. `recovery: { "rollbackOnFailure": false }` in project config keeps failed-attempt managed changes for new workflows; changing it does not alter an existing snapshot.

The journal does not undo Bash edits, Git operations, check-command effects, external services, or all filesystem metadata. A successful commit/push may remain even if the surrounding activity was interrupted. Inspect those effects before retrying the step.

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
├── tasks/                    # requests and planning history
├── attachments/              # uploaded request data
├── runs/                     # approval snapshots, events, attempt journals
├── versions/                 # archived executable workflow bundles
├── temporal/                 # managed SQLite execution history and logs
├── server-lease/             # live project ownership lease
└── lock                      # diagnostic owner information
```

Back up the whole `.workflow/` directory, including the version archives, attempt journals, and Temporal SQLite/WAL files. Stop the application for a consistent file-copy backup. With an external Temporal service, its history also needs its own backup policy. Credentials are stored separately; see [Configuration](configuration.md#where-settings-live).

Do not delete Temporal history or version bundles to reset an active run. Local run JSON is a projection and approval record; it cannot replace missing execution history.

## Versioned execution

New drafts archive their compiled code and SDK manifest by content hash. Active runs use their archived bundle after an application-code upgrade; new drafts use the new implementation. The runtime also retains compatibility for older Temporal executions.

Archive integrity and SDK compatibility are checked before a worker starts. Missing/corrupt bundles or an incompatible SDK require restoring the archive or running a compatible application version. Arbitrary SDK/activity migrations are not automatic.

Approval first persists a pending start receipt. If a crash occurs before Temporal accepts the start and no execution exists, startup can restore the unstarted draft for review. A confirmed execution with missing history is different and requires restoring its history.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| “No complete `.workflow/` configuration” | Run `workflow init` from the intended project folder. The CLI does not search parent folders. |
| Model unavailable or unsupported for the account | Refresh the connected catalog, select a supported model, then update the draft or replan. Defaults do not change existing drafts. |
| Planning stopped without a workflow | Open Planning activity for the validation/provider error. The coordinator has automatic correction continuations, but time/tool limits and persistent errors can still stop planning. |
| “Primitive … declared but unused” | Attach the step/group to the exported `flow`, or remove an intentionally excluded declaration. |
| Review has no branch/base comparison | The execution step should inspect the baseline and adapt to accessible working files when no base exists. Findings must state that limitation. |
| Command exited nonzero but workflow continued | `ctx.exec` returns status as data. Set `ctx.outcome`, throw, or branch on the result explicitly. |
| A loop stopped before approval | Check both `maxIterations` and per-step/total visit limits, and the step's outcome actions. |
| Parallel AI appears sequential | A spending limit serializes model sessions against the remaining budget. Group concurrency and the overall eight-step cap also apply. |
| Parallel file conflict | Sequence overlapping edits. Commands bypass managed-write claims, so review their effects too. |
| Another workflow owns the project | Resume or cancel the paused/interrupted execution before approving a competing run. |
| Saved block file edits do not appear | `.workflow/library.json`, if present, takes precedence over block directories. Edit the active library. |
| Missing Temporal history or archive | Restore the matching project backup. Do not delete more state or start the old work under a new snapshot. |
| Stale form/draft revision | Load the latest version, reconcile your edits, and save again. |
| Bun warns about `v8.promiseHooks.createHook` | The pinned SDK cannot collect workflow stack traces on Bun. It is a diagnostic limitation; execution still uses Temporal. |

## Current boundaries

The web server and managed Temporal development service bind locally. They are single-user services, not authenticated remote interfaces. Keep them on loopback. Host/origin guards and mutation headers do not turn them into a multi-user service.

AI and command tools have the server user's access. Role instructions do not impose an OS sandbox. Explicit parallel composition exists, but automatic worktree/container isolation, remote sandbox workers, and full rollback of shell/external effects do not.

On Linux, a verified managed Temporal process left after SIGKILL can be adopted on restart. On macOS, a still-running orphan may require reconnecting to the printed address or stopping it before restarting. External Temporal address/namespace selection is supported; Temporal Cloud TLS/API-key onboarding is not implemented.
