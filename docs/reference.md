# Command and API reference

[Documentation](README.md) → Command and API reference

## CLI

Run project commands from the target project's directory. Configuration is in that directory's `.workflow/`; there is no project-path argument. `workflow --help` prints the installed command syntax.

| Command | Behavior |
| --- | --- |
| `workflow init [--instructions "..."]` | Create configuration and starter TypeScript blocks without model calls. `--no-ai` remains a compatibility flag. |
| `workflow setup [--model provider/id] [--thinking level] [--instructions "..."] [--regenerate] [--max-setup-cost USD] [--wait]` | Start or attach to a saved background setup job. `--wait` follows progress; disconnecting leaves generation running. |
| `workflow setup-status [job-id] [--json]` | Inspect the latest or selected setup job and reported usage. |
| `workflow setup-resume <job-id> [--wait] [--max-setup-cost USD]` | Explicitly continue unfinished setup, retaining accepted stages and earlier spending. Optionally raise its total allowance. |
| `workflow setup-cancel <job-id>` | Cancel generation before final publication begins. |
| `workflow profiles [--instructions "..."]` | Regenerate model profiles using AI. |
| `workflow` or `workflow start [--json]` | Start or reuse a detached background host for this project; return after readiness. |
| `workflow status [--json]` | Report this project's host identity, mode, URL, and lifecycle state without secrets. |
| `workflow stop [--json]` | Ask the verified host to drain and stop; never signal a PID from a receipt. Already stopped is successful. |
| `workflow serve` | Run the host in the foreground until Ctrl+C or `workflow stop`. |
| `workflow tui [session-id] [--session ID] [--server URL] [--demo]` | Open the terminal workspace; attach to this project's server or start a detached host with the web GUI. |
| `workflow attach <task-or-run-id> [--server URL]` | Reopen persisted work in the terminal without approving or retrying it. |
| `workflow exec <file.ts> [--input '<JSON object>'] [--json]` | Execute locally without HTTP or GUI; wait and return an execution exit code. |
| `workflow run <file.ts> [--input '<JSON object>'] [--approve] [--wait]` | Submit source to the running project server. Default is a draft; `--approve` starts it. |
| `workflow show <run-id>` | Full draft or result, including revision. |
| `workflow approve <run-id> [--wait]`, `workflow reject <run-id>` | Decide whether a draft runs. |
| `workflow events <run-id>`, `workflow watch <run-id>` | Read activity or wait for completion/attention. |
| `workflow task "Request" [--max-task-cost USD]`, `workflow tasks`, `workflow task-show <task-id>` | Create/list/inspect planning requests. The optional limit includes planning and execution. |
| `workflow usage [task-or-run-id] [--json]` | Read project or shared task usage totals, phases, model sessions, and spending limits from the running host. |
| `workflow data <run-id> <step-id> [visit] [--json]` | Inspect stored inputs, outputs and AI context for one visit. Omit the visit for the latest one; JSON includes content references and loaded text. |
| `workflow memory [list\|on\|off\|show ID\|add entry.json\|update ID entry.json\|remove ID] [--json]` | Manage optional project memory through the running core. It starts disabled. |
| `workflow remember <run-id> [--save] [--input JSON] [--json]` | Preview compact strategy guidance from a completed run. `--save` explicitly remembers it without enabling memory or approving execution. |
| `workflow answer <task-id> "Answer"` | Answer the current planning question. |
| `workflow runs` | List runs on the local project server. |
| `workflow pause <run-id>` | Finish active steps, then pause new dispatch. |
| `workflow resume <run-id>` | Continue paused work or explicitly retry interrupted steps. |
| `workflow cancel <run-id>` | Stop active or paused execution. |
| `workflow recover <run-id>` | Retry managed-file recovery after conflicts are resolved. |
| `workflow login [provider]` | Optional terminal account/API-key setup. |
| `workflow logout [provider]` | Remove locally saved credentials through the terminal UI. |
| `workflow model [search]` | Choose shared default model settings. |
| `workflow thinking` | Choose shared thinking defaults. |
| `workflow auth` | Print connection metadata, never secret values. |

Terminal setup commands can run outside a project. Interactive setup requires a real terminal and supports cancellation. Both browser Settings and the TUI's `/login`, `/models`, and `/thinking` support model setup. See [Terminal workspace](terminal.md) for slash commands and shortcuts.

### Server options

| Option | Behavior |
| --- | --- |
| `--no-web` | Server only: API and worker without serving GUI assets. |
| `--server URL` | Client commands: explicitly select a server project, including over a tunnel. |
| `--json` | Client commands, `start`/`status`/`stop`, and `exec`: machine-readable output. |
| `--wait` | Wait for a submitted/controlled run to finish or need attention. |
| `--port 4310` | HTTP port; 4310 is the default. Use the same option on CLI control commands. |
| `--port 0` | Start/serve/TUI: choose a free port for a new host and announce it in `.workflow/server.json`. Start and TUI reuse an existing project host; status/stop use the saved endpoint without a default-port fallback. |
| `--demo` | Explicit simulation of agents/checks using real Temporal history. Normal startup and development use live AI. |
| `--temporal-address host:port` | Connect to an existing trusted Temporal endpoint instead of the managed service. |
| `--temporal-namespace name` | Namespace for that connection; default `default`. |

`start` is idempotent for the same project and execution mode. It refuses a mode or explicitly requested port/web-mode change while a host is running; stop first to reconfigure. `status`/`stop` operate from the local project folder, not via `--server`. The private receipt contains a per-host shutdown token; JSON status omits it. Stop verifies the host ID, endpoint, project and PID against the live server, then uses authenticated HTTP shutdown. Stale or mismatched records never authorize killing a process. Startup logs are in `.workflow/host.log` with private file permissions.

`workflow status --json` returns `status: "running"`, `"stopping"`, or `"stopped"`; a stopped project is not a command error. A verified running host also reports `canStop`. A host without its matching private receipt requires repairing that receipt or stopping its original foreground process.

An external Temporal service is not stopped when Workflow exits. The CLI currently exposes address/namespace selection, not remote authentication/TLS onboarding.

`workflow run` returns the submitted run ID and state; add `--wait` to wait for completion or a state needing attention. Source must be a project-relative `.ts` file, and `--input` must be a JSON object. The server must already be running for that same project unless `--server` explicitly selects another endpoint. Use `exec` to run without a server. See [Engine and clients](clients.md) for exit codes, embedding, and remote access.

### Environment variables

| Variable | Scope |
| --- | --- |
| `WORKFLOW_HOME` | Override Workflow's private user settings/credential directory. |
| `GH_TOKEN`, `GITHUB_TOKEN` | GitHub trigger authentication, in precedence order; otherwise use GitHub CLI sign-in. |
| `XDG_CONFIG_HOME` | Absolute base for user configuration when `WORKFLOW_HOME` is absent. |
| `WORKFLOW_CHROMIUM_PATH` | Test runner: use an existing Chromium executable. |
| `WORKFLOW_LIVE_MODEL` | Live smoke test's selected model ID. |
| `WORKFLOW_LIVE_SCENARIO` | Select a live smoke-test scenario; see [Development](development.md#real-model-smoke-tests). |

Project commands and stdio MCP servers inherit the server environment. Provider-specific environment-key behavior remains an embedded SDK feature; browser credential setup does not require it.

## Local HTTP API

The Vue UI and CLI use the same loopback API. This is a local application interface, not a remotely authenticated public service. Request/response validation is implemented in `src/application.ts`, `src/http-server.ts`, and the public `src/contracts.ts` schemas.

All mutations and `/api/auth/*` reads require `X-Workflow-Client: 1`. Responses disable caching. Draft reads return a quoted revision `ETag`, such as `"2"`; send it as `If-Match` when editing, refining, or approving. Conflicts return 409. The browser supplies these headers; older clients can omit some draft revision headers, but should not rely on that for concurrent edits.

Settings and library mutations carry their own required revision/hash fields. Read the current state before modifying it. Auth responses contain prompts/status/sign-in instructions rather than credential objects.

### Project memory

`GET /api/memory` lists descriptions and the current revision. `PUT /api/memory` toggles use with `{revision,enabled}`. Entry management uses `POST /api/memory/entries` and `GET`, `PATCH`, or `DELETE /api/memory/entries/:id`. Mutations require the current revision; conflicts return 409. Management remains available while memory is disabled, but planner reads and ordinary-run collection stop. See [Project memory](memory.md) for entry fields, terminal commands and retention behavior.

`GET /api/runs/:id/strategy-preview` derives compact guidance and bounded source metadata without writing memory. `POST /api/runs/:id/remember` accepts `{sourceRunRevision,memoryRevision,title,description,details,tags?}`; it derives trusted metadata again and saves a user-endorsed strategy. Only completed, non-deleted source runs qualify. Saving preserves the memory setting and returns `{state,entry,reused}`. See [Reusing an approach](reusing-approaches.md).

### CLI host lifecycle

These routes are registered by CLI-owned background and foreground hosts, not by a borrowed `createHttpServer(app)` adapter:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/host` | Public host identity, mode, URL and ready/stopping state; no shutdown token. |
| POST | `/api/host/stop` | Requires `X-Workflow-Client: 1`, the private `X-Workflow-Host-Token`, and `{hostId}`. Sends 202 before draining the host. Prefer `workflow stop`. |

### Tasks and attachments

| Method and route | Purpose |
| --- | --- |
| `GET /api/project` | Served project, mode, and library/configuration. |
| `GET /api/health` | Server readiness. |
| `GET /api/tasks` | Task list. |
| `POST /api/tasks` | Create `{ prompt, attachments?: [attachmentId], approval?: "review" \| "automatic", sourceRunId?, maxTaskCostUsd? }`; returns 202 with the task. Omitted approval uses project settings; recovery tasks always require review and retain the original spending scope. |
| `GET /api/tasks/:id` | Task, planning events, and linked run. |
| `GET /api/usage` | Project lifetime usage, including setup/design and retained execution. |
| `GET /api/tasks/:id/usage`, `GET /api/runs/:id/usage` | Shared task/run scope usage, limits, and model sessions. The report's canonical `scope` identifies linked recovery work. |
| `POST /api/tasks/:id/answer` | Answer an essential question with `{ answer, revision }`. |
| `POST /api/tasks/:id/retry` or `/cancel` | Retry or cancel planning. |
| `DELETE /api/tasks/:id` | Remove a deletable task and its linked run from history. |
| `POST /api/attachments` | Upload `{ name, mimeType, data: base64 }`. |
| `GET /api/attachments/:id` | Read validated attachment bytes. |

Usage reports include `total`, `phases`, `models`, the newest 100 `sessions`, `sessionCount`, `sessionsTruncated`, `limits`, `incomplete`, and `warnings`. `legacyExecution` is an attribution subtotal already included in `total`, not an extra amount to add. Dollar totals represent known reported costs; `remainingCostUsd` is null when no total limit or incomplete coverage applies. Model sessions include stable session/operation IDs, phase, model/pricing, status, and available task/run/node/visit ownership. The typed client exposes `usage()`, `taskUsage(id)`, and `runUsage(id)`.

Example, with the server running in review mode:

```sh
curl http://127.0.0.1:4310/api/tasks \
  -H 'Content-Type: application/json' \
  -H 'X-Workflow-Client: 1' \
  -d '{"prompt":"Review src/math.ts without editing; report actionable findings."}'
```

Planning is asynchronous. Poll the returned task ID or subscribe to the stream. Once the task is ready, its `runId` identifies the draft to inspect and approve.

### GitHub triggers

| Method and route | Purpose |
| --- | --- |
| `GET /api/triggers` | Trigger definitions and the latest 100 event jobs. |
| `POST /api/triggers` | Save `{ config, id?, revision? }`; edits require the current trigger revision. Configuration includes `name`, `repository`, `event`, `workflowRunId`, `enabled`, filters, `pollSeconds`, optional `maxCostUsd`, and `result`. |
| `POST /api/triggers/poll` | Poll enabled triggers now and drain eligible queued work. |
| `POST /api/triggers/:id/test` | Create a reviewable test draft from `{ number }`; no automatic execution/publication. |
| `POST /api/trigger-events/:id/retry` | Retry failed dispatch or reconcile pending result delivery. |
| `POST /api/trigger-events/:id/cancel` | Cancel a queued or dispatch-failed event. Use normal workflow controls for an active run. |

Events are `issue.opened` or `pull_request.opened`; result destinations are `local` (default) or `github-comment`. Triggers default to disabled. GitHub access uses `GH_TOKEN`, `GITHUB_TOKEN`, or the GitHub CLI's sign-in; no credential is accepted in trigger JSON. See [the trigger guide](triggers.md) for input shape, frozen versions and the background-service example.

### Workflow source and execution

| Method and route | Purpose |
| --- | --- |
| `POST /api/programs` | Create a TypeScript draft from `{ title, task, source, filename?, input? }`. |
| `GET /api/runs` | Run summaries. |
| `GET /api/runs/:id` | Full run and revision `ETag`. |
| `PUT /api/runs/:id/program` | Replace draft `{ source, filename?, input? }`, using `If-Match`. |
| `POST /api/runs/:id/refine` | Ask AI to refine a live draft with `{ instructions }`, using `If-Match`. |
| `POST /api/runs/:id/approve` | Start the reviewed revision, using `If-Match`. |
| `POST /api/runs/:id/reject` | Reject an unexecuted draft. |
| `POST /api/runs/:id/pause`, `/resume`, `/cancel`, `/recover` | Execution controls. |
| `DELETE /api/runs/:id` | Remove a deletable run and its linked task from visible history. |
| `GET /api/runs/:id/events` | Persisted activity. |
| `GET /api/runs/:id/attempts/:nodeId/:visit/evidence` | Exact stored input/output and AI-session evidence for a step visit, with explicit unavailable states. |
| `GET /api/runs/:id/attempts/:nodeId/:visit/content/:hash` | Fetch verified content owned by that attempt; `?download=1` requests an attachment. |
| `GET /api/stream` | Server-sent events for task/run updates and live activity. |
| `POST /api/format` | Format `{ source, language, cursorOffset? }` without executing it. |

`POST /api/runs` and `PUT /api/runs/:id/plan` remain for older explicit-route graphs. New task planning uses `/api/tasks`; new TypeScript imports use `/api/programs`.

### Configuration and design

| Routes | Purpose |
| --- | --- |
| `GET /api/setup` | Provider connection metadata, model defaults and last completed setup. |
| `POST /api/setup-jobs` | Start or attach to a saved setup job; returns `202` and the job immediately after admission. |
| `GET /api/setup-jobs/latest`, `GET /api/setup-jobs/:id` | Read saved stages, status, revision and available actions. |
| `POST /api/setup-jobs/:id/resume`, `/cancel` | Explicit action with `{ revision }`; resume also accepts `maxSetupCostUsd` to raise the retained total allowance. Clients do not own job cancellation. |
| `GET /api/setup-jobs/:id/usage` | Setup usage across all stages and explicit resumes. |
| `GET /api/models`, `POST /api/models/refresh` | Connected model catalog. |
| `PUT /api/project/model` | `{ configRevision, agent }`; use `null` to clear project overrides. |
| `GET/PUT /api/settings/orchestration` | `{ revision, settings }` for profiles, cases, capabilities, and approval. |
| `GET/PUT /api/settings/execution` | `{ configRevision, instructions, commands, maxSteps, budget? }`. |
| `POST /api/settings/mcp/inspect` | Discover tools from an MCP server configuration. |
| `GET /api/library` | Active blocks, source, and revision. |
| `DELETE /api/library/blocks/:id` | Remove a reusable block with `{ revision }`. |
| `POST /api/library/proposals` | Create a manual or AI library proposal; not yet applied. |
| `GET /api/library/proposals/:id`, `POST .../apply`, `POST .../reject` | Inspect/apply/reject a library proposal. |
| `POST /api/design`, `GET /api/design/:id`, `GET /api/design/:scope/latest` | Create/read scoped settings conversations. |
| `POST /api/design/:id/messages`, `/cancel`, `/discard`, `/apply` | Continue or control a settings conversation/proposal. |
| `GET /api/auth/options`, `GET/POST /api/auth/session` | Connection choices and sign-in state; start `{ provider, method }`. |
| `POST /api/auth/session/:id/respond` | Respond with `{ promptId, value }`. |
| `POST /api/auth/session/:id/cancel`, `POST /api/auth/providers/:id/logout` | Cancel sign-in or remove local credentials. |

The shared client in `src/client.ts`, public contracts, and HTTP routes are the detailed contract for design proposal bodies. The API has no published cross-version stability guarantee; keep integrations aligned with the installed application.
