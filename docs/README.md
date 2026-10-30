# Workflow documentation

Workflow turns a development request into an inspectable TypeScript graph, then executes its blocks with recorded progress, results, and recovery controls.

## Choose a reading path

**First time here:** [Why and how it works](concepts.md) → [Getting started](getting-started.md) → [Running a workflow](operations.md).

**Writing automation:** [Workflows](workflows.md) → [Blocks](blocks.md) → [Configuration](configuration.md). Start from [examples/composed.ts](../examples/composed.ts) for an implementation/review loop.

**Understanding execution:** [Inspecting workflow data](inspecting-data.md) covers exact step inputs and outputs, parallel handoffs, historical visits and AI context.

**Optional learning:** [Project memory](memory.md) covers explicit preferences and compact observations from ordinary runs, with description-first access and no extra AI jobs.

**Reuse useful work:** [Reusing an approach](reusing-approaches.md) explains the explicit Remember action and how planners load selected block definitions and strategy guidance.

**Unattended GitHub work:** [Triggers](triggers.md) → [Running and recovering workflows](operations.md). Test a saved workflow, then enable issue or PR triggers.

**Working on the application:** [Architecture](architecture.md) → [Development](development.md) → [CLI and local API](reference.md).

## Guides

| Guide                                                           | Covers                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [Concepts and design](concepts.md)                              | The problem Workflow solves; task, case, block, step, workflow, and run; why code, models, and durable execution fit together. |
| [Getting started](getting-started.md)                           | Installation, project initialization, browser setup, first task, and importing TypeScript.                                     |
| [Terminal workspace](terminal.md)                               | OpenTUI chat, live activity, graphs, approval, sessions, settings, and provider login.                                         |
| [Writing workflows](workflows.md)                               | The composition primitives, typed data, conditions, outcomes, loops, parallel scheduling, and older workflow formats.          |
| [Block contracts and evidence](block-contracts-and-evidence.md) | Single-block testing, enforced ownership roles, selective skills/MCP, decisions and actual model sessions.                     |
| [Writing blocks](blocks.md)                                     | `block()`, context operations, AI outputs, model overrides, command results, artifacts, and reusable library modules.          |
| [Execution inspection](execution-inspection.md)                 | Timeline, nested calls, historical activity, exact evidence links, request timing, and full command output.                    |
| [Shared tools](tools.md)                                        | Typed tools callable by blocks and models, replay rules, frozen implementations, structured activity, and environments.        |
| [Configuration](configuration.md)                               | Providers, model profiles, task instructions, AI settings chats, skills, MCP, limits, and stored configuration.                |
| [GitHub triggers](triggers.md)                                  | Persistent polling, event filters, frozen workflows, queues, test drafts, result comments, and background operation.           |
| [Running and recovering workflows](operations.md)               | Statuses, activity, pause/resume, cancellation, file recovery, version archives, backups, and troubleshooting.                 |
| [Command and API reference](reference.md)                       | CLI commands, environment variables, HTTP routes, and concurrency headers.                                                     |
| [Engine and clients](clients.md)                                | Headless execution, terminal control, embedding, shared client, and separate builds.                                           |
| [Architecture](architecture.md)                                 | The request-to-execution path, responsibilities of Pi and Temporal, persistence, and source map.                               |
| [Project review](project-review.md)                             | Vision alignment, implemented changes, verification, screenshots, and current boundaries.                                      |
| [Development](development.md)                                   | Local development, build artifacts, tests, packaging, and how to keep these docs accurate.                                     |

## Examples

| File                                                         | Purpose                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| [composed.ts](../examples/composed.ts)                       | Implementation, deterministic tests, concurrent inspection, a typed approval loop, and a conditional report. |
| [parallel-handoffs.ts](../examples/parallel-handoffs.ts)     | Two parallel producers with named typed inputs and an inspectable schema transformation; no AI calls.        |
| [implement-reviewed.ts](../examples/implement-reviewed.ts)   | The supported imperative `run(ctx)` style, with explicit awaited steps.                                      |
| [scripts-only.ts](../examples/scripts-only.ts)               | Running commands without model calls, including existing script compatibility.                               |
| [shared-tools.ts](../examples/shared-tools.ts)               | One typed file tool used directly by a block and selected for an AI review.                                  |
| [github-event-report.ts](../examples/github-event-report.ts) | A trigger workflow that turns an issue/PR input into a report without model calls.                           |
| [workflow.service](../examples/workflow.service)             | Adaptable systemd user-service unit for keeping a project running.                                           |

The examples use project tools and, where applicable, configured model profiles. Read their commands and adapt them to your project before approving execution.

## What the docs describe

Design assessments and proposals are separate from the current-behavior guides:

- [DeepSeek Harness ideas for Workflow](deepseek-harness-analysis.md): comparison of tool-call inspection, timelines, history, and extension boundaries, with a proposed adoption order.

These guides describe the current implementation. New authoring uses TypeScript `block()` definitions and declared workflow composition. Older explicit-route graphs and imperative workflows remain supported; their differences are called out in the relevant guides.

For SDK signatures, see [workflow-sdk.ts](https://github.com/cjvnjde/workflow/blob/main/src/sdk/workflow-sdk.ts) and [composition-sdk.ts](https://github.com/cjvnjde/workflow/blob/main/src/sdk/composition-sdk.ts). Application behavior is exercised by the [test suites](https://github.com/cjvnjde/workflow/tree/main/tests). The old [implementation-plan URL](implementation-plan.md) points here and to the current architecture rather than maintaining a second product specification.

[Back to the project README](../README.md)
