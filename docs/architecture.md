# Architecture

[Documentation](README.md) → Architecture

Workflow has one execution engine, with a browser and CLI using the same local API. TypeScript composition describes the work, Temporal records its progress, and host activities perform effects.

## Request to result

```mermaid
flowchart TD
    UI["Vue workspace / CLI"] --> API["Local Fastify API"]
    API --> Task["Persist request + attachments"]
    Task --> Planner["Coordinator: cases, blocks, profiles"]
    Planner --> Compiler["Format, typecheck, preview, bundle"]
    Compiler --> Draft["Draft graph + frozen configuration"]
    Draft --> Approval["Review approval / automatic mode"]
    Approval --> Engine["WorkflowEngine + project lease"]
    Engine --> Temporal["Temporal workflow history"]
    Temporal --> Activities["Host activities"]
    Activities --> Pi["Pi model sessions"]
    Activities --> Host["Commands, files, MCP"]
    Temporal --> Events["Run projection + activity events"]
    Events --> UI
```

1. The task service saves the request, attachments, answers, and planning events.
2. The coordinator classifies the task, reads case instructions, selects described model profiles, and submits TypeScript. It has proposal tools, not repository inspection tools.
3. The compiler formats and typechecks the source, bundles static imports, and describes its declared composition. Invalid submissions return useful errors to the coordinator for correction.
4. The engine persists the draft with source, block catalog, model settings, configuration, and an executable version. Graph layout is a view of that structure.
5. Approval records a recoverable start intent and starts Temporal under the selected version. Activities must match the locally approved execution snapshot.
6. The workflow interpreter schedules steps and groups. Blocks execute pure code in the replayable runtime and request host effects through recorded activity boundaries.
7. Checkpoints update the local projection; activity events and live text reach the browser through SSE. Typed results and readable artifacts remain attached to attempts.

## Why Pi is embedded

Pi supplies model/provider integration, tool sessions, authentication integration, and terminal UI components. Workflow chooses which tools/resources a session gets, where credentials live, and how its result connects to the workflow.

Users set up connections through Workflow Settings. There is no separate Pi project to operate. Ambient Pi credentials, extensions, histories, and resource discovery are not automatically imported. The task coordinator, settings designers, and execution sessions have different roles and tool sets.

## Why Temporal owns execution

Durable routing requires more than saving the latest graph node in JSON. The runtime needs the recorded order and results of operations, signals, active attempts, and state transitions after a restart.

Temporal owns that history. Deterministic workflow code composes steps, applies visit limits, processes pause/resume, and waits for activity results. Host activities run model sessions, commands, and filesystem operations. Mutating activities do not get automatic retries; interrupted work waits for an explicit retry decision.

Local JSON is the approval record and UI projection, not an alternative executor. The managed Temporal development service uses project-local SQLite and binds to loopback. An external endpoint can be selected, but hosted deployment and remote authentication onboarding are separate work.

## Composition and execution

The SDK builds a tree of `step`, `sequence`, `parallel`, `when`, and `repeatUntil` nodes. `describeFlow` serializes the structure for preview without calling its blocks, input callbacks, or conditions. The compiler evaluates declarative module initialization in a bounded VM without host APIs. Imperative workflows retain execution-only initialization.

At execution, the runtime checks that the structure matches the reviewed one, then interprets it. Deferred inputs and conditions read completed typed results. Parallel branches have separate result views until the join, with a global eight-step admission cap and explicit group concurrency.

Each host operation is tied to its exact step and visit rather than a single mutable cursor. Managed write claims prevent parallel attempts from changing the same tracked path. Spending-limited AI sessions serialize against the remaining balance. These mechanisms preserve the existing recovery/budget contracts while allowing explicit parallel work.

## Frozen and live data

| Captured with a draft | Read or used during execution |
| --- | --- |
| Workflow source and bundled static imports | Project files inspected by blocks |
| Reusable block source and explicit resources | Scripts launched through `ctx.exec` |
| Model profiles and resolved configuration | Credentials/provider access for actual requests |
| Commands, limits, attachments, and graph structure | Command environment and external service state |

A saved workflow version contains its bundled deterministic code and SDK manifest. Active executions use that archive across compatible application upgrades. Host activity compatibility still matters; version archives are not arbitrary runtime migration machinery.

## Persistence and trust

The project lease prevents competing Workflow servers from owning the same project. A run's approval snapshot and Temporal identity are checked at activity boundaries. Revision checks protect draft/settings edits from stale browser writes. Version hashes protect archive integrity.

These are execution consistency measures. AI and command tools still use the server user's local access. File journals recover managed writes; they cannot reverse arbitrary shell, Git, or remote effects. The HTTP server has local host/origin and mutation-header guards, but no remote multi-user authentication.

[Operations](operations.md) documents recovery semantics and the backup boundary.

## Source map

Paths below are relative to the repository checkout. The packaged CLI includes compiled artifacts rather than the source tree.

| Area | Main files |
| --- | --- |
| CLI and local HTTP | `src/cli.ts`, `src/server.ts` |
| Task persistence and planning | `src/tasks.ts`, `src/task-planner.ts`, `src/task-schema.ts` |
| Public authoring API | `src/workflow-sdk.ts`, `src/composition-sdk.ts` |
| Source validation and preview | `src/program-compiler.ts`, `src/composition-plan.ts`, `src/source-format.ts` |
| Durable execution | `src/engine.ts`, `src/temporal-workflow.ts`, `src/composition-runtime.ts` |
| Code blocks and host effects | `src/code-runtime.ts`, `src/code-host.ts`, `src/block-runner.ts` |
| Models and sessions | `src/agent-session.ts`, `src/model-runtime.ts`, `src/available-models.ts` |
| Auth and user defaults | `src/browser-auth.ts`, `src/user-settings.ts`, `src/terminal-commands.ts` |
| Library and settings design | `src/library.ts`, `src/library-proposals.ts`, `src/design-chats.ts`, `src/settings-designer.ts` |
| Recovery and persistence | `src/recovery.ts`, `src/workspace.ts`, `src/run-store.ts`, `src/attempt-store.ts` |
| Temporal process/version management | `src/temporal-server.ts`, `src/temporal-runtime.ts`, `src/workflow-versions.ts`, `src/project-lock.ts` |
| Vue state and navigation | `web/App.vue`, `web/composables/` |
| Graph, activity, results, editors | `web/components/`, `web/graph-layout.ts` |
| Settings UI | `web/settings/` |
| Build, development, live checks | `scripts/` |
| Unit, integration, recovery, browser tests | `tests/`, `tests/e2e/` |

The frozen legacy workflow bundle is retained under `src/legacy/` for replay compatibility. New features should not silently rewrite historical execution behavior.

[Next: development and testing](development.md)
