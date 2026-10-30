# Shared tools

[Documentation](README.md) → Shared tools

Define an operation once, then call it from ordinary block code or offer it to an AI session. Both paths use the same input/output validation, frozen implementation, execution environment, and activity records. This design takes inspiration from [Pi Durable's tools and environments](https://github.com/earendil-works/pi/tree/main/packages/durable); Temporal remains Workflow's scheduler.

```ts
import { block, defineTool, z } from "workflow";

const inspectFile = defineTool({
  name: "inspect_file",
  version: 1,
  description: "Read a project text file and count its lines.",
  replay: "safe",
  input: z.object({ path: z.string() }),
  output: z.object({ text: z.string(), lines: z.number().int() }),
  async execute({ path }, ctx) {
    const text = await ctx.env.readText(path);
    const lines = text.split("\n").length;
    ctx.details({ path, lines });
    return { text, lines };
  },
});

export default block({
  async run(ctx) {
    const source = await ctx.call(inspectFile, { path: "README.md" });
    // source.text and source.lines are inferred from the tool's schema.
    const review = await ctx.ai({
      tools: [inspectFile],
      role: "review",
      prompt: `Inspect README.md (${source.lines} lines) and summarize the project.`,
      output: z.object({ summary: z.string() }),
    });
    ctx.summary(review.summary);
    return review;
  },
});
```

See the runnable [shared-tools.ts](../examples/shared-tools.ts) workflow. It uses the configured model; inspect its source before approving it.

## Definition and approval

Declare tools at module scope, including tools imported from reusable modules. Names must be unique lowercase identifiers of up to 64 characters; `submit_result` is reserved. A workflow can define up to 64 tools and expose up to 32 in one AI call. Input and output schemas must be Zod schemas representable as JSON Schema. Use JSON values; transformations, class instances, functions, dates and bigint are not portable contracts.

The compiler archives the entire module, including static imports and captured helpers. The tool archive and Temporal bundle are hashed together into the approved execution version. Editing source or helpers afterward does not alter an existing draft or approved run. Create a new draft to use the changes. Keep `.workflow/versions/` in backups, including each version's `tools.js` and manifest. Older versions without shared tools remain supported.

Each call loads a fresh module instance. Module globals are not shared state or durable storage. Put effects in `execute`, use the supplied environment, and pass state through typed inputs and outputs. Dynamic imports, host module imports and top-level await follow the same restrictions as blocks.

`tools: [inspectFile]` exposes exactly that list plus `submit_result`. It does not add ambient Bash, file, skill-loader or MCP tools. Selected skills are supplied inline. An empty array exposes only `submit_result`. These calls receive the explicit prompt instead of enclosing step handoffs, and prompts are limited to 32,000 characters because no general file reader is implied. Omitting `tools` retains normal project tools and capability selection; `tools: "none"` retains its existing text-only behavior.

## Effects, results, and display

Tool code has a small context:

| API | Behavior |
| --- | --- |
| `ctx.env.readText(path)` | Read through the host environment. |
| `ctx.env.writeText(path, text)` | Managed file write; the local implementation uses the existing journal and ownership checks. |
| `ctx.env.exec(command, options?)` | Run a command; returns `{ exitCode, stdout, stderr, output, timedOut }`. Nonzero exit is a result. |
| `ctx.progress(text)` | Persist a progress update. Await it like any other effect. |
| `ctx.summary(text)` | Optional model-facing summary and display preview, up to 16,000 characters. |
| `ctx.details(value)` | Optional JSON evidence for clients. |
| `ctx.present(value)` | Optional inert human-facing card metadata, independent of the model summary and typed return. |
| `ctx.callId` / `ctx.idempotencyKey` | Stable identity for this invocation, including automatic activity retries. A new explicit step retry has a new identity. |
| `ctx.request` | Original workflow request. |

Return the typed data from `execute`. Code receives that data directly. Models receive its JSON representation unless `ctx.summary()` replaces it; include everything the model needs in that summary. Presentation details remain available to the clients. Results are bounded to 256 KB; activity evidence is abbreviated at 16,000 characters and marked as truncated. Persist large reports as explicit artifacts/files.

Await environment operations sequentially and before returning. A tool may issue at most 64 operations. `timeoutMs` defaults to 120 seconds and can be set between 100 ms and 10 minutes, within the enclosing block's deadline. A dedicated worker bounds the tool's CPU lifetime, and cancellation reaches its environment and local subprocess group. This is not an OS sandbox for hostile authored code. Shell commands retain the host user's access and shell/remote effects are not undone by file recovery.

## Retry and recovery

`replay` defaults to `"unsafe"`. A direct `ctx.call()` is a Temporal activity. Completed calls are replayed from history when the worker reconnects, rather than executing their effects again. An unsafe call is not automatically retried after failure or uncertain completion: the step enters the existing interrupted/recovery flow. Inspect effects before resuming. Explicit resume starts another visit of the interrupted step and can repeat its earlier operations.

Use `replay: "safe"` for read-only tools. The host enforces this by refusing commands and writes, even if the author declares the tool safe. Direct safe calls get up to three activity attempts. Reads may observe changed external state; “safe” means no managed mutations, not identical results.

Inside an AI session, tools use the same frozen code and environment, but the conversation is still one Temporal activity. Individual AI turns and tool results are not conversation checkpoints. After an interrupted AI session, explicit resume may repeat its calls. The activity log supplies evidence for that decision; it does not provide exactly-once remote effects. Fine-grained conversation recovery is a separate future change.

## Structured activity

Run events may contain `operation`, with an ID, optional parent ID, name, kind, state, typed input/output evidence, duration and replay metadata where applicable. The engine persists a start record before calling a tool or environment operation and a result afterward. Tool effects are children of the tool call; model-selected calls are children of the AI session. A crash can leave a start record without a result, which indicates uncertain completion.

Both the terminal workspace and web Activity view read these fields directly. Older text events remain readable. Other clients can consume the schema from `predictable-workflow/contracts` without parsing console messages.

## Execution environments

Shared tools use the local environment by default. Embedded applications may inject `environment` into `createApplication()`. The factory receives the project/worktree, cancellation signal, file journal and ownership protection. For example, wrap the local implementation to instrument or redirect a specific operation:

```ts
import { createApplication, localExecutionEnvironment } from "predictable-workflow/engine";

const app = await createApplication({
  project: process.cwd(),
  environment: async options => {
    const local = await localExecutionEnvironment(options);
    return { ...local, id: "instrumented-local" };
  },
});
// The embedding host eventually calls await app.close().
```

Custom implementations must honor cancellation and the passed ownership/recovery contract. The factory applies to shared tools, direct TypeScript block file/command effects, built-in agent file/command tools, and their checks. Optional `listFiles`, `editText`, and `inspectGit` methods support built-in capabilities; a missing capability fails explicitly, and edit may use the same environment's read/write methods. MCP remains a separately configured external service. Legacy script/function blocks and the host-local `WORKFLOW_INPUT`/`WORKFLOW_RESULT` exchange require the local environment. Source compilation, ownership snapshots, and evidence storage remain host-local responsibilities. No container or remote provider is included yet. The same engine can already run on a server and be controlled by the web or terminal clients.

## Tool presentation

A shared tool can supply a card through `ctx.present()`:

```ts
ctx.present({ card: "command", command: "bun test", exitCode: result.exitCode,
  output: result.output.slice(-32000) });
```

The supported card kinds are `generic`, `command`, `file-read`, `file-diff`, and `search`. Metadata is validated and persisted with the call. Invalid or oversized presentation falls back to ordinary evidence without changing the tool's typed result. Captured before/after text must describe the actual operation; the browser never rereads today's file to reconstruct a historical diff. Tool source, including presentation generation, stays frozen with the approved version.

[Execution inspection](execution-inspection.md) explains nested call cards, historical paging, output capture, and request timing. Command output references are scoped to their attempt. Explicit selected-tool sessions retain exactly their selected tools plus submission: provide a self-contained summary or an explicit retrieval tool when returning a large result to such a session.
