# Workflow

**Project-local building blocks for predictable AI work, with an explicit graph and a live web UI.**

Describe a task, attach context, and let the orchestrator classify it using your editable task instructions. It inspects the project, chooses blocks and model profiles, and builds a workflow for that request. Review it or enable automatic execution. Temporal follows its routes, context handoffs and bounded feedback loops durably. Pi is an embedded model/session adapter; Workflow owns setup, tasks, settings and the web interface.

This is a single-user desktop tool with a real Temporal backend, not a production sandbox or hosted multi-user service.

## Run locally without changing PATH

Requires **Bun 1.4.2+**. All application and CLI source is **TypeScript**. Bun handles installation, scripts, builds, tests, and the CLI runtime; the tool does not require a separate Node.js installation.

From this project's root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run start
```

Open **http://127.0.0.1:4310**. The current project already includes an example `.workflow/` policy, so you do not need to initialize it again. Both `start` and `dev` use real AI. You can also execute the built command directly with `./dist/cli.js`.

For development with frontend hot reload, use `bun run dev` and open **http://127.0.0.1:5173**.

## Install the command on your PATH

Run once from this tool's checkout:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun link
```

This registers the **`workflow`** command on your PATH using Bun. Bun's global bin directory must be on PATH; `bun pm bin -g` reports it after linking. The CLI and its dependencies are installed/linked once, not in every project. End-user execution requires Bun, but not a TypeScript compiler or access to this tool's source files.

For a distributable package instead of a development link, run `bun pm pack` in the checkout and install the resulting `.tgz` with `bun add --global --ignore-scripts <archive.tgz>`. The package contains the bundled CLI, Temporal workflow bundle and built UI, not this repository's `.workflow/`, tests, or source files. `bun pm pack` builds automatically through the prepare script unless you pass `--ignore-scripts`.

## Use it from your project folder

There is **no project-path argument**. The folder you run `workflow` from is the project. Configuration and run state live in that folder's `.workflow/`; the UI is served from the installed tool, not copied into your project. The CLI does not search parent directories or fall back to its installation's example configuration.

```sh
# In the project folder you want the agents to work on:
workflow init --instructions "Use the existing test framework. Preserve public API compatibility."
workflow
```

Open **http://127.0.0.1:4310**.

1. Open **Settings → Providers & models**, connect ChatGPT (or a provider API key). In **Model profiles → Generate with AI**, describe your preferences, send the request and apply the proposed profiles. The AI selects a planning model. You can also choose a project default manually.
2. Return to **New task**. Write the goal in the central input; attach images or text/code files, paste a screenshot, or drop files onto the composer. Press Enter to start; Shift+Enter adds a line.
3. The orchestrator classifies the request, reads the matching task instructions and proposes a graph. It asks a follow-up only when an essential detail is missing. There is no task-type or coordinator selector.
4. Review the graph and **Approve & start**, or select automatic execution in **Settings → Execution**. Click a step to inspect its goal, model, instructions and context handoffs. **Edit workflow** provides structured controls and optional JSON.
5. Watch the highlighted active step and live activity. Drag blocks to arrange the graph; positions survive updates and reloads, and **Reset layout** restores the original arrangement. **Focus active step** brings running work into view.
6. The outcome appears above the graph, including failures and blockers. Open **Results** for rendered Markdown, verification checks and artifacts; use **Copy Markdown** or **Download** on any artifact, or export the whole report. The notification bell records completions, pauses and failures received while the app is open.
7. Active and previous tasks stay in the sidebar; reloading restores the selected task. Pause, resume or stop execution there. **Delete workflow** (also available beside a sidebar entry) removes settled tasks and drafts from history. Stop active work first. Deletion does not undo project files or erase recovery journals, attachments or Temporal execution history from disk.

Attachments support PNG, JPEG, WebP and GIF (up to 6 MB each), and UTF-8 text/code (up to 256 KB each); up to eight files and 20 MB per request. PDF and other binary document extraction are not implemented. Image requests need an image-capable planning model. The coordinator records relevant visual observations for steps that use text-only models. Attached content is passed to the selected model providers. Uploaded files are private project files under `.workflow/attachments/`, checked by hash before use.

Use `workflow --port 4320` for another port, or `--port 0` to select a free port and print its address.

Open **Settings → Providers & models** in the browser. Choose **Continue with ChatGPT**, open the sign-in link, and complete the account authorization. Alternatively, expand **Use an API key** and select a provider. ChatGPT is the only account sign-in offered; other providers use API keys. Choose an available model and thinking level, then **Save project model**. No terminal setup is required.

Connected ChatGPT accounts show their connection status instead of another sign-in button. The browser handles sign-in prompts, cancellation, connection status and disconnecting saved credentials. The external “Authentication successful” callback page belongs to the embedded auth SDK; close it and return to Workflow Settings to see the connected account. API-key and callback inputs are masked and cleared after submission. Credentials remain in Workflow's private local store; they are never returned by the API or stored in browser storage or run events. An unfinished sign-in survives a page reload while the server is running and expires after ten minutes. Disconnect removes local credentials; it does not revoke access at the provider. OpenAI documents the [ChatGPT authorization flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in); account eligibility and model access remain provider-controlled.

Project model controls affect new proposals and preserve execution limits. Existing drafts and runs retain their snapshots. **Use shared defaults** removes the project's model/thinking overrides. Blocks and graph steps can override the project default. Refresh connections after signing in from another terminal or changing credentials elsewhere.

The embedded SDK **does not** load Pi's credentials, project/global extensions, ambient skills, context files, prompt templates, default tools, or old conversations. Only explicitly configured block resources and enabled project skills/MCP tools are included. Explicit model overrides must name a provider.

### Optional terminal setup and private user settings

`workflow login`, `logout`, `model` and `thinking` remain available for terminal users. They use embedded Pi terminal components with the same ChatGPT/API-key connection policy. API-key input is masked. Escape cancels; Ctrl+C stops setup and restores the terminal. Browser setup is the primary onboarding path.

```sh
workflow login               # ChatGPT account or provider API key
workflow login openai        # narrow the selector
workflow model anthropic     # optional initial model search
workflow auth                # credential metadata/default model, never secret values
workflow logout openai       # confirm removal; does not revoke access at the provider
```

Login/model selection work from any folder, without initializing a project or starting a server. Interactive commands need a real terminal; they refuse piped input/output rather than accidentally exposing secrets. With no PATH changes, use `bun dist/cli.js login` from this tool's checkout.

User settings live in `$XDG_CONFIG_HOME/workflow` or `~/.config/workflow`, separately from projects:

- `auth.json`: private API keys/OAuth credentials, managed by the SDK.
- `settings.json`: default provider/model/thinking and device identity.
- `models.json`: optional advanced custom-provider configuration; not required for standard providers.
- `model-catalog.json`: SDK model-catalog cache.
- `cache/temporal/`: the managed Temporal executable.

Credential/settings files use private permissions. `WORKFLOW_HOME` optionally changes this directory. Existing Pi credentials are not imported automatically. API-key environment variables remain an optional SDK feature, not an onboarding requirement. Never commit credentials; secure storage is currently private files, not an OS keychain.

New projects inherit terminal-selected model/thinking defaults. Explicit project settings take precedence; existing drafts/runs retain their snapshots. Connecting another provider does not silently change an existing model selection.

Graph edits stay in the browser when switching between runs. Valid unsaved changes preview in the graph, while invalid routes, duplicate aliases, and incomplete fields show validation errors before saving. Step controls and JSON share the same draft. Unsaved edits block approval and AI refinement until saved or discarded. Saves and approvals carry the reviewed revision; a stale browser cannot overwrite or approve a newer draft. If another session edits a dirty draft, your text remains visible and **Discard edits & load latest draft** loads the current version. Reloading or closing the page warns about unsaved graph edits. Live updates share one event stream and merge by revision so delayed responses cannot roll back a run or its list entry.

The initial starter library detects a `test` script in `package.json`, configures `bun run test`, and accepts your project instructions. For projects without a package test script, configure commands manually. You can then generate project-specific blocks with AI or edit them yourself in the browser.

### Configure how the orchestrator works

All configuration lives on **Settings**. The interface uses Catppuccin Mocha. Unsaved edits have visible discard controls: cancel a new block, restore an existing block or model selection, discard settings changes, or use **Discard all edits**. Discarding does not write to the project. Task drafts, attachment uploads, MCP discovery and AI workflow refinement also have discard/cancel controls.

**Design with AI** opens a chat at the bottom right, scoped to the current section: model profiles, task instructions, blocks, skills/MCP or execution settings. Describe your goal, ask questions and refine the proposal across messages. Review the proposed settings, then click **Apply changes**. Drag a chat by its header (or focus the header and use arrow keys) to move it. **New conversation** opens an independent window, including another conversation for the same settings section. Each window keeps its own messages, draft and progress. Minimize windows into the bottom dock and restore them as needed; open conversations, positions and sizes survive reloading and server restarts. Resize either bottom corner by dragging or focusing its handle and using arrow keys. Textareas grow as you type or paste, up to a bounded height, then scroll inside. Use **Stop** to cancel generation, **Discard message** to clear an unsent draft, or **Discard proposal** to dismiss a suggestion without changing settings. AI generation uses your connected provider, uses file and Bash tools to inspect the project and returns settings proposals for review. Save or discard form edits before applying; stale proposals cannot overwrite later settings changes. Workflow auto-approval and provider credentials stay in their dedicated controls.

`workflow init` generates model profiles automatically when a provider is already connected, and preserves existing profiles. Otherwise, connect in the browser and use **Generate with AI**. **Regenerate with AI** prefills an editable request; add your preferences before sending. For terminal initialization or regeneration:

```sh
workflow init --no-ai         # initialize offline, without a model request
workflow profiles --instructions "Prioritize careful review; use fast models for routine steps."
```

Ordinary server startup does not regenerate profiles or make background setup requests. Planning and settings design use the account/model configuration independently of execution spending limits.


- **Model profiles:** add multiple models with descriptions such as “careful reviewer for complex changes” or “fast helper for summaries.” The planner receives those descriptions and selects a model for each AI step. Enabled profiles restrict execution choices to their available models; with no profiles it uses the connected catalog. A planning-model override is optional.
- **Task instructions:** add, edit, disable or remove cases such as bug, feature, maintenance and investigation. Each case contains a description and instructions, not a predefined graph. Add shared instructions and choose whether the planner may suggest new blocks.
- **Blocks:** add, edit or remove reusable AI, configured command and built-in function blocks using form controls. Configure instructions, declared outputs and checks. **Design with AI** supports conversational proposals for adding, updating and removing blocks. New blocks suggested while planning remain local to that workflow until you explicitly save them to the library.
- **Skills & MCP:** add skill instructions, enable/disable them, and configure stdio or Streamable HTTP MCP servers. Enabling a server makes all its discovered tools available during planning and execution. Connect to preview the tools; there is no separate planning allowlist.
- **Execution:** choose review or automatic approval, project instructions, maximum steps, a spending limit and named host checks. Every AI step also has Bash for general commands, including package installation, Git staging, commits and pushes. A request such as “commit and push these changes” does not require a preconfigured command. Deterministic command blocks use named argument arrays from settings; functions do not require a configured command or a model.

**Push without AI:** in **Blocks → Add block → Execution**, choose **Built-in function → Git · Push current branch**. Optionally name a configured remote. Otherwise it follows `branch.<name>.pushRemote`, `remote.pushDefault`, or the existing upstream, then falls back to `origin` or the only configured remote. It respects an existing upstream branch on that remote; otherwise it creates the same branch name remotely and sets upstream. It pushes only existing commits from that branch, never force pushes or mirrors, and never stages or creates commits. Put verification and commit preparation before it. Failures produce diagnostics and follow the configured retry route; detached HEAD, missing commits, an absent remote or a divergent remote branch are execution failures. The activity log records Git commands and output, and the publication artifact records the result. New projects include this block; existing projects can add it with the form or Design with AI.

MCP HTTP credentials reference a server-process environment variable containing a bearer token; plaintext tokens are not entered into settings. Local stdio servers inherit the application's environment, as Bash commands do. This is explicit project MCP configuration, not automatic discovery of Pi resources or support for every MCP authentication mechanism.

Command blocks call the configured command directly with no model request. A failed condition returns `retry` and a diagnostic artifact. Route that outcome back to an implementation block, give that block the diagnostic handoff, and route its success back to verification. Both node visits and total workflow steps bound the cycle. Bash, Git, check-command and MCP side effects are outside file-tool rollback.

Settings are stored in `.workflow/orchestration.json` and `.workflow/config.json`. Concurrent stale edits are rejected. The reusable block library is published atomically as `.workflow/library.json`, with prior snapshots under `.workflow/libraries/`; once present, it takes precedence over the starter block directories. Removing a reusable block leaves existing workflow snapshots intact. Existing drafts/runs retain their prompts, capabilities, model settings and command definitions.

For an existing draft, **Edit workflow → Tell AI what to change in this draft** refines routes, goals, handoffs and per-step models against that draft's saved library. It preserves the original request and refuses to overwrite concurrent edits. Planning, library generation and refinement are separate from the execution spending limit.

### Execution modes

| Mode | Planning | Execution |
| --- | --- | --- |
| `workflow --demo` | Explicit simulation using example graphs | Simulated agents and checks; real Temporal history |
| `workflow` / `workflow serve` | AI composes a graph from task instructions, profiles and blocks | Real model sessions, Bash, configured checks and enabled MCP servers |

Review is the default. Automatic mode starts the generated graph, including any task-local suggested blocks, without a review click. Only one workflow can execute in a project at a time. If automatic start cannot acquire the project, the task stays available for manual approval with an explanation. A demo draft cannot be executed in live mode; create a fresh task.

Planning preserves your original request; adapted scope and assumptions belong to the graph's goals and rationale. If the coordinator stops after a rejected submission or only describes its plan in prose, it gets up to two automatic continuations in the same conversation, sharing the original time and tool-call limits. Validation errors appear in planning activity. Invalid graphs never become executable just to make planning succeed. Provider errors, cancellation, exhausted limits, and unsuccessful correction can still stop planning. Stopping planning also discards a draft that finishes being created after cancellation.

## Project configuration

```text
.workflow/
├── config.json
├── orchestration.json        # cases, profiles, skills/MCP, approval preferences
├── design-chats/             # private settings conversations and reviewed proposals
├── tasks/                    # request and planning history
├── attachments/              # validated request files
├── blocks/
│   ├── reproduce/
│   │   ├── block.json
│   │   ├── prompt.md
│   │   └── skills/             # optional explicit Markdown resources
│   ├── fix/
│   ├── requirements/
│   ├── implement/
│   ├── verify/
│   └── review/
├── runs/                       # private approval snapshots/projections; gitignored
│   └── <run-id>/
│       ├── run.json
│       └── events.jsonl
├── temporal/                   # private managed-server data; gitignored
│   ├── temporal.sqlite         # authoritative execution history
│   ├── server.json
│   └── server.log
├── server-lease/               # live server lease; gitignored
└── lock                        # diagnostic owner record; gitignored
```

Commit `config.json`, blocks and prompts. Do **not** commit generated runs or Temporal state: they can contain code, task details, prompts and command output. Keep API keys out of workflow configuration.

### `config.json`

```json
{
  "version": 1,
  "instructions": "Use the project's existing conventions.",
  "agent": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "thinking": "medium",
    "timeoutMs": 600000,
    "maxToolCalls": 100
  },
  "coordinator": {
    "thinking": "high"
  },
  "commands": {
    "test": {
      "argv": ["bun", "test", "tests/regression.test.ts"],
      "timeoutMs": 120000
    },
    "lint": {
      "argv": ["bun", "run", "lint"],
      "timeoutMs": 60000
    }
  },
  "maxSteps": 30
}
```

Choose host checks appropriate to your project; use `bun run test` for a package script, or `bun test <path>` for a focused Bun-native test. Named commands use fixed argument arrays from the project root without shell interpolation. AI steps can also invoke arbitrary commands with Bash; they do not need a command entry for each operation.

The generated `agent: {}` inherits your terminal-selected defaults; the explicit model above is an optional project override. Settings resolve as **Workflow user defaults → explicit project defaults → block overrides → graph node overrides**. Coordinator overrides resolve against project defaults. Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; pi clamps them to model capabilities. Both elapsed time and tool calls are bounded.

### A block: `blocks/fix/block.json`

```json
{
  "id": "fix",
  "name": "Fix bug without changing tests",
  "description": "Use after a focused regression test reproduces a bug. Fix production code, never tests.",
  "skills": ["skills/project-conventions.md"],
  "outputs": ["implementation"],
  "checks": [{ "command": "test", "expect": "success" }],
  "agent": { "thinking": "high" }
}
```

The directory must match the block ID. IDs and artifact names are lowercase kebab-case, at most 64 characters; `constructor` and `prototype` are reserved. Outputs must be unique; `summary` is implicit and host-owned.

`prompt.md` contains the block's task-specific instructions. `skills` lists explicit UTF-8 Markdown resources inside the block directory; their contents are snapshotted and included directly. This first version supports explicit skill/reference text, not ambient skill discovery. Add a supporting reference to `skills` if the agent needs it. Block-local scripts can run through Bash or be named in project `commands` for deterministic host checks.

All AI sessions receive `bash`, `read_file`, `write_file`, `edit_file`, `list_files` and `git_changes`. Bash runs as the server user with its environment, credentials and network access; OS access rules still apply. File tools accept relative, absolute and `~/` paths, follow links and can access Git metadata and configuration. Text file tools are limited to 1 MB; Bash handles larger files, renames, deletes and other formats. Broad file lists skip generated/runtime directories for readability; explicit patterns such as `.git/**` include them.

Block instructions define responsibilities: reviews inspect and report; verification returns diagnostics; implementation fixes defects; publication stages, commits and pushes when requested. Each invocation receives its current step and an overview of the workflow. The overall request provides context; implementation and verification leave commits and pushes to the publication step after checks/review pass. These are agent instructions, not enforced file globs. Legacy `permissions` fields remain readable for saved-run compatibility but are ignored and omitted from agent catalogs. The application does not sandbox local tools.

`git_changes` is a bounded convenience summary of local branch/base comparisons and working changes. It reports exact HEAD/base/merge-base identifiers, labels inferred bases, disables external diffs/filters/hooks and never fetches or mutates Git. Use Bash for effective Git configuration, remote inspection, staging, commits and pushes. A repository with no commits is reported explicitly; the planner adapts review scope to working files when appropriate.

Every configured host check is available through `run_check`. After an AI block submits its result, the engine runs that block's required checks again before choosing the next route. Failed conditions change a claimed `pass` into `retry`. Timeouts, signals and spawn errors do not satisfy an expected-failure check. Bash command output and errors are recorded in Activity.

**A failing command is not proof of the intended bug.** Use a focused regression command and inspect the reproduction artifact. Likewise, a passing existing suite is not proof that every new requirement has been implemented; the independent test/review blocks and your acceptance criteria matter.

### Custom blocks

Create `.workflow/blocks/<id>/block.json` and `prompt.md`; optionally add explicit skills/resources. Give the block a precise description of **when to use it** and make its instructions and checks match its role. New proposals load the updated catalog. Live task planning can use custom blocks automatically. The legacy recipe API and demo graphs expect the starter IDs.

Existing drafts/runs retain their original policy snapshots. Changing configuration does not silently upgrade an approved plan. Snapshots freeze prompts, loaded skill text, model settings, command arguments and the graph; project files and executable script bodies are not frozen.

## Graphs and handoffs

A graph is a serial state machine with explicit routes for `pass`, `retry` and `fail`. It may contain cycles, bounded by both each node's `maxVisits` and the run's `maxSteps`.

Example node:

```json
{
  "id": "work",
  "block": "fix",
  "label": "Fix without weakening tests",
  "goal": "Make the focused regression pass and preserve existing behavior.",
  "inputs": [
    { "node": "prepare", "artifact": "reproduction", "required": true },
    {
      "node": "review",
      "artifact": "feedback",
      "as": "review-feedback",
      "required": false
    },
    {
      "node": "review",
      "artifact": "summary",
      "as": "review-evidence",
      "required": false
    },
    {
      "node": "work",
      "artifact": "summary",
      "as": "previous-attempt",
      "required": false
    }
  ],
  "maxVisits": 3,
  "agent": { "thinking": "high" },
  "on": { "pass": "review", "retry": "work", "fail": "$failed" }
}
```

The complete plan also has `title`, the original `task`, `entry`, and `nodes`. Routes target a node ID, `$complete`, or `$failed`. Validation checks unique IDs, known blocks/routes, reachability, declared outputs, and unique input aliases.

Every attempt creates a **fresh pi session**. It receives:

1. Project instructions, block prompt, and explicitly enabled skills.
2. The task, its attachments, the node goal and its visit number.
3. Only the named artifacts selected by `inputs`.
4. Files and command output it explicitly requests through tools.

It does not receive another agent's conversation history. Context handoffs select which artifacts enter the next prompt; they do not limit file or shell access. Artifacts are untrusted text, not executable instructions.

A passing block must publish all its declared outputs through `submit_result`. Every attempt also publishes a host-owned `summary`, augmented with final check evidence. Feedback from later steps is optional on a first visit. Missing required artifacts stop execution **before** invoking the next agent. New outputs replace that node's previous output set to avoid forwarding stale feedback.

## Temporal, pause/resume and recovery

Temporal is the execution backend, including in demo mode. Deterministic workflows own graph routing, visit budgets, checkpoints and pause/resume signals. Agent sessions and host checks run as activities; local JSON files are the private approval record and UI projection, not a second executor.

By default Workflow downloads a pinned official Temporal CLI once into its private cache, then starts a loopback **Temporal dev server with persistent SQLite**. No Docker, globally installed Temporal, separately configured service or Node process is required. The first start needs internet access for that download; cached starts do not. Local CLI management supports Linux/macOS x64/arm64 and is tested on Linux. This convenience server is not a production Temporal deployment.

```sh
# While workflow is serving this project in another terminal:
workflow runs
workflow pause <run-id>       # finish the active step, then stop at the next boundary
workflow resume <run-id>      # continue a paused run; no repeated completed agents
workflow cancel <run-id>      # stop the current activity and prevent subsequent steps
workflow recover <run-id>     # retry file recovery after resolving a conflict
# Add --port 4320 if your web server uses another port.
```

The same controls are available in the web UI. Paused/interrupted runs retain ownership of the project until resumed or cancelled. Stopping the application stops its worker/local server, not the durable workflow; restart in the same project and execution mode to restore it.

New approvals persist a pending start receipt before contacting Temporal. If the process stops at that boundary and Temporal has no execution, startup restores a draft for review and another approval. A new execution ID prevents a late response from authorizing the old snapshot. If Temporal accepted the start, startup reconnects to that execution. Missing history for a confirmed execution (or an older execution without a receipt) still requires restoring the history.

**A paused run and an interrupted activity are different:**

- At a pause boundary, completed results, artifacts and the next cursor survive restart. Resume continues the remaining graph.
- Agent/check activities have **no automatic retries**. If an activity fails or loses its worker, Temporal records the failure and the run waits as `interrupted`. Inspect partial file changes first. Explicit resume retries only that step in a fresh session and consumes another visit/step budget. It does not continue halfway through a model request. New runs restore that attempt’s file-tool changes before retrying; completed steps stay committed.
- Transient provider request failures retry up to twice inside the same conversation, retaining completed tool results and cumulative limits. Retry progress appears in Activity. This does not restart the block or replay completed tools; a final activity failure still follows the explicit resume flow above.
- On Linux, a server left behind after SIGKILL is verified against its executable/database and adopted; a heartbeat lease protects against two application instances. On macOS, a still-running orphan requires explicit reconnection with the printed address or stopping that process before restarting.
- Legacy runs from the pre-Temporal engine cannot be resumed; cancel them and propose a new run.

Back up the **whole `.workflow/` directory**, including approval snapshots, attempt journals, `.workflow/versions/` and the SQLite database/WAL files. Do not delete Temporal history to “reset” an active run.

### File recovery

New runs journal each file-tool write before publishing it. Files are replaced atomically with their original permissions. Cancellation, activity failure, an explicit fail/retry result, or a failed host verification restores only that attempt’s original bytes and removes files it created. Passing steps remain committed. Journals survive worker loss and restart.

Recovery compares file hashes before restoring. Manual edits, linked paths, and check commands that rewrite an agent-edited file produce a conflict instead of being overwritten. Inspect the attempt’s recovery report, save any manual work elsewhere, and restore the file to either its original bytes or the journaled agent version. Then use **Retry file recovery** or `workflow recover <run-id>`. Resume remains blocked until conflicts are resolved. Recovery is idempotent; repeating it does not undo completed steps.

The journal covers writes through Workflow’s file tools, not Bash edits, Git operations, check-command side effects, external services or directory metadata. Inspect those effects before retrying; a commit or push is not automatically undone. A system-wide power failure is outside the transactional guarantee. Existing unversioned runs retain their previous recovery behavior. To keep failed-step changes in new runs, set `recovery: {"rollbackOnFailure": false}` in project config before proposing a workflow.

### Workflow versions

Each new draft records a SHA-256 workflow version. Workflow archives its bundled deterministic code and SDK manifest under `.workflow/versions/`, and uses a separate task queue for each version. After an application-code upgrade, active runs continue with their archived bundle; new proposals use the new code. A frozen v1 bundle handles existing Temporal runs that predate versioning. Old runs are not silently migrated to new routing or recovery behavior.

Archive content is verified before starting a worker. Missing/corrupt bundles and mismatched Temporal SDK versions stop startup safely; restore the archive or use the matching runtime. This pins workflow code within a compatible SDK and preserves the supported activity protocols. It does not provide arbitrary SDK/activity migrations or Temporal Cloud worker deployments. Temporal requires replay-compatible workflow code; see its [versioning guidance](https://docs.temporal.io/develop/typescript/workflows/versioning).

To use an existing trusted Temporal endpoint instead of the managed local service:

```sh
workflow --temporal-address 127.0.0.1:7233 --temporal-namespace default
```

This currently supports address/namespace selection, not Temporal Cloud TLS/API-key onboarding. The existing service is not stopped when Workflow exits.

### Execution budget

The draft UI shows an expected cost on pass routes and a retry estimate using node visits, tool-call limits and the total step limit. Model prices are copied from the local model catalog into the draft, or supplied explicitly in `budget.prices` as `provider/model` keys with `input`, `output`, `cacheRead` and `cacheWrite` USD rates per million tokens. Context pricing tiers and long-retention cache writes are included. Unknown prices display as unavailable rather than zero; demo estimates are zero.

Project config can include:

```json
"budget": {
  "maxCostUsd": 5,
  "inputTokensPerCall": 4000,
  "outputTokensPerCall": 1000,
  "callsPerVisit": 4
}
```

The optional **Settings → Execution → Execution spending limit** applies to newly planned workflows. Dollar limits require an explicit provider/model and known pricing at every AI node; command blocks have zero model cost. Reported input/output/cache tokens and costs are saved for each attempt, including failed or cancelled requests, and displayed live. The engine prevents later steps when the remaining limit is exhausted; sessions abort after reported usage reaches the remaining limit. Budgeted sessions disable unmetered automatic compaction; other sessions include reported compaction usage.

Estimates are assumptions, not billing guarantees: context size can grow, cached catalog prices can age, an in-flight request can exceed the limit, and providers may not report all billable usage. AI coordinator planning is separate from the execution budget. Check-command costs and subscription accounting are not calculated. Review the saved price/estimate assumptions before approval.

### Safety and current limits

- One active workflow and one leased server/worker per project. Temporal activities must match a locally approved snapshot and their workflow identity; an arbitrary workflow start cannot bypass workflow approval.
- Projections use atomic JSON rename; finalized activity is appended to JSONL. Text deltas stream live but are not individually persisted.
- Cancellation aborts the current session/check, prevents the next node, and recovers the current step’s file-tool writes when recovery is enabled. Completed steps and Bash, Git, check-command and external side effects are retained.
- The web server binds to loopback, rejects non-loopback hosts/unapproved origins, and requires a custom header on mutations. Both it and the local Temporal dev service are **single-user local services**, not authenticated remote interfaces. Do not expose either port publicly.
- AI steps have full local tool access as the server user. Workflow approval selects when execution starts; role instructions determine what each step should do. Cancellation and time/tool-call/spending limits still apply. Use an OS/container boundary when isolation is required.
- No parallel fork/join, full filesystem/check sandbox rollback, arbitrary SDK migrations, Temporal Cloud worker deployments or remote sandbox workers yet.

## API

The web UI uses these local endpoints:

- `GET /api/project`, `GET /api/runs`, `GET /api/runs/:id`
- `GET /api/tasks`, `POST /api/tasks` with `{prompt, attachments?: [attachmentId]}`, `GET /api/tasks/:id`
- `POST /api/tasks/:id/answer` with `{answer, revision}`, `/retry`, `/cancel`
- `POST /api/attachments` with `{name, mimeType, data: base64}`, `GET /api/attachments/:id`
- `GET/PUT /api/settings/orchestration` with `{revision, settings}`
- `GET/PUT /api/settings/execution` with `{configRevision, instructions, commands, maxSteps, budget?}`
- `POST /api/settings/mcp/inspect` with the MCP server configuration
- `GET /api/library`, `DELETE /api/library/blocks/:id` with `{revision}`
- Legacy/manual `POST /api/runs` with `{task, strategy: "bug" | "feature" | "ai", instructions?, autoApprove?, maxCostUsd?}`
- `PUT /api/runs/:id/plan`
- `POST /api/runs/:id/refine` with `{instructions}` (live draft only)
- `GET /api/models`, `POST /api/models/refresh`
- `GET /api/setup` (connection metadata and model defaults)
- `PUT /api/project/model` with `{configRevision, agent: {provider, model, thinking} | null}`
- `GET /api/auth/options`, `GET /api/auth/session`
- `POST /api/auth/session` with `{provider, method: "oauth" | "api_key"}` (`oauth` is allowed only for `openai`)
- `POST /api/auth/session/:id/respond` with `{promptId, value}`, `POST /api/auth/session/:id/cancel`
- `POST /api/auth/providers/:id/logout`
- `POST /api/library/proposals` with `{kind: "regenerate" | "models" | "manual", instructions?, allowedModels?, changes?}`
- `GET /api/library/proposals/:id`, `POST /api/library/proposals/:id/apply`, `/reject`
- `POST /api/runs/:id/recover`
- `POST /api/runs/:id/approve`, `/reject`, `/pause`, `/resume`, `/cancel`
- `GET /api/runs/:id/events`, `GET /api/stream` (SSE)

All mutation requests and `/api/auth/*` reads require `X-Workflow-Client: 1`. API responses disable caching. Auth responses contain only prompts, status and sign-in instructions, never credential objects. Draft GET responses include an `ETag` containing the revision, for example `"2"`; send it as `If-Match` when saving, refining or approving. A mismatch returns 409. The browser always sends this header; it remains optional for older API clients. Project model writes require the `configRevision` returned by setup and reject concurrent config edits.

Example task request (review is the default):

```sh
curl http://127.0.0.1:4310/api/tasks \
  -H 'Content-Type: application/json' -H 'X-Workflow-Client: 1' \
  -d '{"prompt":"Fix the empty-input bug"}'
```

## Why Pi and Temporal?

They solve different problems. **Pi is the embedded model/tool/session and terminal-UI runtime. Temporal owns durable execution.** Neither automatically makes model actions safe or requirements correct. Workflow owns the approval flow, local tools, host checks, credential locations and user experience. Their composition does not require users to operate Pi or manually administer the default local Temporal service.

See [the implementation plan and roadmap](docs/implementation-plan.md).

## Developing the tool

From this repository, `bun run dev` starts the live API, waits for its readiness endpoint, then starts the Vite UI at **http://127.0.0.1:5173** using the project’s `.workflow/` library. `bun run dev:live` is a compatibility alias; both use real agents. `bun run workflow <command>` runs the TypeScript CLI directly for development; installed users just run `workflow` in their own project.

The frontend uses **Vue 3 + TypeScript**, the Composition API, and **Vue Flow**. Components use `<script setup lang="ts">` with typed props/events and `v-model` for form state. `web/App.vue` owns navigation, `web/components/` contains task/workflow/design UI, `web/settings/` contains settings sections, and `web/composables/` owns server streams, polling and unsaved drafts. Shared API validation and revision-merging helpers stay framework independent. Settings, graph controls, the editor and AI design chats load as separate chunks.

`bun run typecheck` checks TypeScript **and Vue templates**, including component props, through the Vue language engine. The small `scripts/typecheck.ts` adapter calls that engine directly because the standard `vue-tsc` CLI depends on a Node loader hook that Bun does not use. `tests/typecheck.test.ts` checks that script, template and component-prop errors actually fail. No Node installation or untyped `.vue` shim is required.

`scripts/build.ts` typechecks, removes stale build artifacts, builds the UI through Vite running on Bun, and bundles the backend with `bun build --target=bun`. It also prebundles the current and frozen v1 Temporal workflows with the SDK bundler. It emits executable `dist/cli.js`, `dist/workflow-bundle.js`, `dist/workflow-v1-bundle.js` and `dist/web/`. External runtime dependencies remain installed beside the tool, so this is a Bun-powered CLI package, not a dependency-free native binary. Rebuild after changing the tool when using a development link.

`bun.lock` is the authoritative lockfile. TypeScript's `node:*` compatibility types and APIs do not require a Node.js process: Bun implements those interfaces.

### Checks

```sh
bun run test             # builds the distribution; runs CLI, domain, engine, file/shell tools, API and SDK tests with Bun
bun run typecheck
bun run build

# Browser tests, including approval, feedback, pause/reload/resume and rejection:
bunx --bun playwright install chromium
bun run test:e2e
# Or use a preinstalled Chromium:
WORKFLOW_CHROMIUM_PATH=/usr/bin/chromium bun run test:e2e
```

`bun run test:live` is an opt-in integration check using your existing ChatGPT sign-in. It creates a temporary project and local bare Git remote, then checks real planning on an unborn branch, browser approval, AI settings design, screenshot input, implementation/tests, commit/push, results/downloads and automatic execution. Chromium always runs headlessly. Set `WORKFLOW_CHROMIUM_PATH` if using a system browser, and optionally `WORKFLOW_LIVE_MODEL` (default `gpt-6-luna`). This consumes subscription usage, leaves the real project untouched, and writes its report/screenshots into the printed temporary directory.

Use `WORKFLOW_LIVE_SCENARIO=cancellation bun run test:live` to check cancelling the real coordinator, stopping an executing Bash command without a late file write, persistence after browser reload, and successfully running another task afterward. `WORKFLOW_LIVE_SCENARIO=publication` runs just the screenshot-to-publication scenario.

Tests use disposable projects and real local Temporal services. They cover safe pause/restart/resume, a SIGKILL/restart of the executable, no automatic replay of interrupted edits, and approval guards. Terminal tests use real Bun pseudo-terminals with no Pi/Node on PATH, dummy keys and offline catalog discovery. The SDK integration test uses a local streaming fake provider: no paid model calls or real credentials are required. Browser tests use a separate demo server on port 4311.

With the pinned Temporal SDK on Bun, `v8.promiseHooks.createHook is not available` warns that workflow stack-trace collection is disabled. Execution/replay/signals work in the integration tests; this is a diagnostic limitation, not a switch to a fake/local executor.
