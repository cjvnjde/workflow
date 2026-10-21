# Workflow documentation

Workflow turns a development request into an inspectable TypeScript graph, then executes its blocks with recorded progress, results, and recovery controls.

## Choose a reading path

**First time here:** [Why and how it works](concepts.md) → [Getting started](getting-started.md) → [Running a workflow](operations.md).

**Writing automation:** [Workflows](workflows.md) → [Blocks](blocks.md) → [Configuration](configuration.md). Start from [examples/composed.ts](../examples/composed.ts) for an implementation/review loop.

**Working on the application:** [Architecture](architecture.md) → [Development](development.md) → [CLI and local API](reference.md).

## Guides

| Guide | Covers |
| --- | --- |
| [Concepts and design](concepts.md) | The problem Workflow solves; task, case, block, step, workflow, and run; why code, models, and durable execution fit together. |
| [Getting started](getting-started.md) | Installation, project initialization, browser setup, first task, and importing TypeScript. |
| [Writing workflows](workflows.md) | The composition primitives, typed data, conditions, outcomes, loops, parallel scheduling, and older workflow formats. |
| [Writing blocks](blocks.md) | `block()`, context operations, AI outputs, model overrides, command results, artifacts, and reusable library modules. |
| [Configuration](configuration.md) | Providers, model profiles, task instructions, AI settings chats, skills, MCP, limits, and stored configuration. |
| [Running and recovering workflows](operations.md) | Statuses, activity, pause/resume, cancellation, file recovery, version archives, backups, and troubleshooting. |
| [Command and API reference](reference.md) | CLI commands, environment variables, HTTP routes, and concurrency headers. |
| [Architecture](architecture.md) | The request-to-execution path, responsibilities of Pi and Temporal, persistence, and source map. |
| [Development](development.md) | Local development, build artifacts, tests, packaging, and how to keep these docs accurate. |

## Examples

| File | Purpose |
| --- | --- |
| [composed.ts](../examples/composed.ts) | Implementation, deterministic tests, concurrent inspection, a typed approval loop, and a conditional report. |
| [implement-reviewed.ts](../examples/implement-reviewed.ts) | The supported imperative `run(ctx)` style, with explicit awaited steps. |
| [scripts-only.ts](../examples/scripts-only.ts) | Running commands without model calls, including existing script compatibility. |

The examples use project tools and, where applicable, configured model profiles. Read their commands and adapt them to your project before approving execution.

## What the docs describe

These guides describe the current implementation. New authoring uses TypeScript `block()` definitions and declared workflow composition. Older explicit-route graphs and imperative workflows remain supported; their differences are called out in the relevant guides.

For SDK signatures, see [workflow-sdk.ts](https://github.com/cjvnjde/workflow/blob/main/src/workflow-sdk.ts) and [composition-sdk.ts](https://github.com/cjvnjde/workflow/blob/main/src/composition-sdk.ts). Application behavior is exercised by the [test suites](https://github.com/cjvnjde/workflow/tree/main/tests). The old [implementation-plan URL](implementation-plan.md) points here and to the current architecture rather than maintaining a second product specification.

[Back to the project README](../README.md)
