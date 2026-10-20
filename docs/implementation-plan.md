# Predictable AI workflows — implementation plan

## Product contract

The user enters a request and attachments in the central composer. The coordinator classifies it against editable task descriptions, reads the matching instructions, selects models from described profiles and writes a TypeScript workflow. It asks for essential missing information only. Cases do not define fixed graphs. Planning proposes source; it does not implement the task. A human reviews and approves it (or explicitly enables auto-approval). The approved code schedules durable steps with ordinary functions, await, loops and conditions. Agent results supply typed data; the code decides what happens next.

Run `workflow` from the project folder: the current directory is the project, with no path argument. Version-controlled policy and private run/history data live under `.workflow/`. The tool, embedded dependencies and bundled UI are installed once, not in every project. All application, CLI and build-script source is TypeScript; Bun handles installation, builds, tests and execution.

Pi is an implementation detail. Browser Settings is the primary setup path: ChatGPT account sign-in, API keys for other providers, model defaults and profiles, task cases, blocks, skills, MCP and execution controls. Terminal setup remains optional. Credentials remain outside projects in Workflow-owned private storage.

Each block owns its prompt, explicit Markdown resources, named checks, declared outputs and model/thinking overrides. Drafts snapshot these resources, including resolved user/project defaults, so later configuration changes cannot alter approved behavior.

## Architecture

- **TypeScript SDK:** `workflow`, `agent`, `script`, Zod input/output schemas, reusable Settings blocks, per-call model selection and explicit context. Typechecking never imports or evaluates user code.
- **Temporal workflows:** each source/import snapshot is bundled with the installed runtime and archived. Code controls steps; legacy graphs retain their executor. Visit/step budgets, typed outputs, durable pause/resume and execution boundaries share one runtime.
- **Temporal activities:** fresh Pi sessions with full local file and Bash access and host-owned checks. Filesystem-mutating execution has `maximumAttempts: 1`; failures wait for explicit, budgeted retry rather than replaying agent edits blindly.
- **Managed local service:** a pinned official Temporal CLI, downloaded into Workflow's private cache, runs a loopback dev server backed by project-local SQLite. An existing trusted endpoint can be selected instead. No Docker, Node runtime or global Temporal installation is required.
- **Host/project boundary:** one leased server per project, with workers for active workflow versions; activities must match a locally approved snapshot and workflow identity. Run JSON/events are private approval records and UI projections; Temporal is the sole executor.
- **Terminal UI:** optional setup using the embedded TUI; it shares Workflow credentials and the ChatGPT/API-key policy with browser setup.
- **Web UI:** Vue 3 Composition API, TypeScript single-file components, Vue Flow, and lifecycle-scoped composables for streams/drafts. Task history, central composer, `.ts` import/export, source/input editing, executed-path graphs, per-step activity and artifact inspection. A dedicated Settings page owns configuration.
- **Task planning:** persisted requests and essential followups, model-profile selection, editable task instructions, task-local block proposals, reviewed or automatic execution.
- **Capabilities:** explicitly enabled skill text and MCP servers, all discovered tools from enabled servers, immutable execution snapshots and editable Bash, JavaScript and TypeScript script blocks.

No ambient Pi tools, extensions, skills, context files or conversations are loaded. Workflow-owned auth/catalog paths replace Pi's default credential directory. Tool restrictions are not an OS sandbox.

## Implemented

- [x] Installable Bun-powered CLI and bundled UI, using the caller's current folder.
- [x] Starter blocks, live AI TypeScript composition, typed artifacts and retained legacy graph compatibility.
- [x] Native async workflows with model parameters, pure helper imports, bounded loops, script steps and versioned execution.
- [x] Draft editing, approval/rejection, regeneration and explicit auto-approval.
- [x] Real Temporal execution, bounded cycles, per-block time/tool limits and cancellation.
- [x] Durable pause at step boundaries; restart/resume without rerunning completed agents.
- [x] Persistent file-tool write journals, atomic replacement, automatic failed/cancelled-step recovery and conflict-safe explicit retries.
- [x] Workflow bundle archives, per-version task queues, frozen v1 compatibility and SDK/integrity guards.
- [x] Draft cost estimates, recorded token/cost usage, optional execution spending limits and browser controls.
- [x] Persistent local Temporal service; Linux SIGKILL recovery with verified orphan adoption and stale-lease recovery.
- [x] Full local agent tools and script execution; host checks override agent claims.
- [x] Named artifacts, independent sessions and per-step model/thinking overrides.
- [x] Workflow-owned private credential/settings files and terminal login/logout/model/thinking commands.
- [x] Web graph, live activity, attempts, artifacts and pause/resume/cancel controls.
- [x] Clearly labelled demo agents/checks using the real Temporal backend.
- [x] Real-service engine tests, executable crash/restart tests, SDK integration with a fake provider, real pseudo-terminal tests and browser coverage.

- [x] Browser-first task workspace, attachments, task history and dedicated Settings.
- [x] Dynamic case-based planning, optional followups, described model profiles and suggested blocks.
- [x] Editable task cases, blocks, skills and MCP settings, with server enable/disable controls.
- [x] Script blocks with Bun/Node runtimes, live output, structured artifact handoffs, cancellation and bounded test/implementation cycles.
- [x] ChatGPT browser sign-in and API keys for other providers.
- [x] AI-generated block-library proposals, per-block model selection from the available catalog, reviewed definition comparison, manual editing and draft refinement.

- [x] Catppuccin Mocha palette across the task workspace, settings and workflow graph.
- [x] Persisted, scoped AI design chats for model profiles, task cases, blocks, skills/MCP and execution settings; iterative refinement and explicit apply with revision checks.
- [x] Automatic model-profile generation during initialization and optional regeneration in the UI or CLI.
- [x] Real AI by default for `dev` and `start`, with connected ChatGPT status replacing redundant sign-in controls.

- [x] Vue 3 frontend with typed settings components, lazy-loaded workflow/editor/design views, and Bun-compatible template type checks.

## Next — stronger boundaries and distribution

- Disposable container/worktree per run; immutable test mounts for fix-only blocks.
- Separate check worker with scrubbed credentials and restricted network.
- OS-keychain credential storage and authentication diagnostics; real-account OAuth interoperability testing.
- A self-contained release executable: current distribution still requires Bun and packaged runtime dependencies.
- Managed-service orphan adoption on macOS; currently an orphan requires explicit reconnect/stop.
- Requirements-to-check mapping and failure fingerprints.
- Interactive graph editing, steer/checkpoint approvals and reservation-based cost limits before individual model requests.

## Next — orchestration at scale

- SDK/activity migrations, offline replay fixtures and Temporal Cloud worker deployments; local workflow bundles are already pinned by version.
- Dependency-aware fork/join scheduling and remote sandbox workers.
- Temporal Cloud/TLS/auth onboarding through Settings.
- Multi-user authentication/audit, reusable recipes and versioned block packages.

## Recovery and safety limits

Pause completes the active step and waits before starting another. Temporal resumes completed history, not the middle of an LLM request. Failed/lost activities may have changed files; explicit resume retries only that step and consumes its visit/step budget. File-tool writes from new failed/cancelled attempts are recovered without overwriting manual changes; arbitrary check-command effects are outside that journal. There is no automatic retry of mutating activities. Pre-Temporal interrupted runs have no durable history and cannot be resumed.

Back up the whole `.workflow/` directory, including local approval snapshots and Temporal SQLite/WAL files. Include `.workflow/versions/` and attempt journals in backups. Application-code upgrades retain archived workflow bundles; SDK changes require a compatible runtime until old runs finish. The local Temporal dev service is a convenience for a single user, not a production deployment; do not expose it or the web API publicly.

AI sessions, Bash and host checks run with the server user's filesystem, environment and network access. Roles are instructions; legacy file permission metadata is ignored. File-tool journals cannot undo Bash, Git or external side effects. OS/container isolation is separate from workflow routing and approval.
