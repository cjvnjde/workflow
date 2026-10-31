# Concepts and design

[Documentation](README.md) → Concepts and design

## The problem Workflow solves

A development task has both a desired result and a process for reaching it. A feature may need implementation, independent tests, review, fixes after feedback, and publication. Those activities need different context, tools, and sometimes different models.

Workflow makes that process executable and visible. You describe the result; the coordinator proposes how to reach it using your building blocks. The engine then follows the approved composition, records each attempt, and exposes its result in the browser.

This is useful for repeatable development work, bounded implementation/review cycles, and tasks that mix model reasoning with ordinary programs. It adds setup and structure, so a short question or a single disposable command may not need it.

## The vocabulary

| Term                | Meaning                                                                       | Example                                                        |
| ------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Task**            | Your request, attachments, and any follow-up answers.                         | “Fix the empty-input bug.”                                     |
| **Task case**       | An editable description of a kind of work and instructions for handling it.   | A bug case asks for reproduction and independent verification. |
| **Model profile**   | A provider/model choice with a description of when to use it.                 | “Careful reviewer for consequential changes.”                  |
| **Block**           | A reusable TypeScript function that performs a unit of work.                  | Implement, review, run tests, or push existing commits.        |
| **Step**            | A named use of a block in a workflow, with inputs, model options, and limits. | `step("review", reviewer, { maxVisits: 3 })`.                  |
| **Workflow**        | The executable composition of those steps.                                    | Implement → test → review, repeating until approved.           |
| **Run**             | A persisted draft or execution of a workflow with its saved configuration.    | The graph and history shown for one task.                      |
| **Visit / attempt** | One invocation of a step. Loops and explicit retries create more visits.      | The review step's second attempt.                              |
| **Artifact**        | A named text result retained for inspection or handoff.                       | Test diagnostics or `review.md`.                               |

Reusing a block does not reuse its conversation. Each AI call creates a fresh model session. Pass the information it needs through explicit inputs, prompts, and returned data.

## Planning and execution have different jobs

During **planning**, the coordinator receives your request, attachments, selected task instructions, block catalog, and available model profiles. It writes a composition and submits it for validation. It cannot inspect the repository through file, Git, shell, or MCP tools. If investigation is needed, it puts that work into a step.

Task cases contain instructions, not predefined graphs. A small review may be a single step; a larger change may need several branches and a feedback loop. Missing information leads to a question only when a useful plan cannot be formed without it.

During **execution**, the engine runs the approved steps. Blocks can inspect the project, call AI, run commands, and use enabled tools. A block reports data and an outcome; the workflow determines the next action.

This separation lets you review the work that is about to run. It does not guarantee that a generated plan is complete or that an agent's conclusions are correct. Typechecking, graph validation, explicit checks, and independent review each catch different classes of mistakes.

## One kind of block: TypeScript code

A block can call `ctx.ai()` when reasoning is useful, `ctx.exec()` for a command, or do pure computation. Inputs and outputs can have Zod schemas. A commit or push does not inherently need a model; a review can choose a stronger model than routine implementation.

This keeps the block interface consistent while allowing its implementation to vary. There is no fixed catalog of built-in functions to extend before you can automate another operation. Reusable blocks can be written manually or proposed through **Design with AI**.

The high-level composition primitives describe control flow: `sequence`, `parallel`, `when`, and `repeatUntil`. Block code describes the work. The declared structure gives the UI a complete graph before execution.

## Data, outcomes, and run status are different

A review can return `{ approved: false, feedback: "Handle empty input" }`. That is **data**. A loop can inspect it through `ctx.output(review)`.

The same block can call `ctx.outcome("retry")`. That is an **outcome**. The step decides whether `retry` means stop, continue to a condition, or repeat its enclosing loop. A command returning exit code 1 is also data until the block interprets it.

The workflow's **status** records its execution state: for example, running, paused, interrupted, completed, or failed. A completed review can conclude that changes are needed; whether the workflow fails or repeats depends on the source you approved.

Read [Writing workflows](workflows.md) for the exact defaults and examples.

## Why durable execution

Long-running work can outlive a browser tab or application process. Temporal records the decisions and completed operation results needed to continue the workflow. Closing the browser does not cancel work.

When an activity is interrupted, Workflow does not blindly rerun it. The run exposes a recovery boundary and waits for explicit resume, which retries the affected step and consumes another visit. Completed siblings in a parallel group are retained.

Durability is not a promise of exactly-once external effects. An interrupted command may have committed or pushed before its result was recorded. File-tool journals can restore managed writes, but Git, shell, and external effects require inspection before retrying. [Operations](operations.md) explains this distinction.

## Why these components

| Component                    | Responsibility                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**                 | The product: task planning, settings, approval, block composition, local tools, results, and the browser workspace.        |
| **Pi**                       | Embedded model/session, authentication, and optional terminal UI integration. Users configure it through Workflow.         |
| **Temporal**                 | Persisted execution history, activity boundaries, signals, and replay. The application manages a local service by default. |
| **React, Vue, and Vue Flow** | React shell and shadcn design system, with existing reactive feature screens and workflow graph during migration.          |
| **Bun and TypeScript**       | The application runtime and the authoring language for blocks and workflows.                                               |

Workflow uses its own credential storage and explicit project resources. It does not load ambient Pi extensions, credentials, or previous conversations. See [Architecture](architecture.md) for how these pieces connect in code.

## Scope today

Workflow is a local, single-user tool. One workflow owns a project at a time; explicit groups can run blocks concurrently inside that workflow. Parallel blocks share the project directory.

AI tools and commands have the server user's access. Roles such as “read-only reviewer” are instructions, not filesystem permission sandboxes. The project currently provides workflow approval, execution limits, managed-file recovery, and local HTTP request guards. AI calls can select existing same-repository Git worktrees; the workflow must create and integrate them explicitly. Remote workers and OS isolation are not supplied by the composition API.

[Next: run your first task](getting-started.md) · [Write a workflow](workflows.md)
