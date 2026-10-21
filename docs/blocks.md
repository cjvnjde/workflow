# Writing blocks

[Documentation](README.md) → Writing blocks

A block is one reusable TypeScript function. It can reason with a model, execute a program, read or write files, or combine those operations. Constructing a block does not run it; a workflow's step invokes it.

## A command block with typed output

Save this as a library module, or import it into a workflow:

```ts
import { block, z } from "workflow";

export default block({
  name: "Run verification",
  input: z.object({ command: z.string() }),
  output: z.object({ passed: z.boolean(), diagnostics: z.string() }),
  timeoutMs: 180_000,
  maxOperations: 10,
  async run(ctx) {
    const result = await ctx.exec(ctx.input.command, { timeoutMs: 120_000 });
    const passed = result.exitCode === 0 && !result.timedOut;
    ctx.summary(passed ? "Verification passed." : "Verification needs changes.");
    ctx.artifact("verification.txt", result.output);
    ctx.outcome(passed ? "pass" : "retry");
    return { passed, diagnostics: result.output };
  },
});
```

This block returns diagnostics and lets its workflow route feedback to implementation. It does not try to repair the change. Choose a meaningful test command: exit status alone cannot prove that the intended behavior was tested.

`input` and `output` schemas are optional. Input is validated before `run`; output is validated after it returns. Without an output schema, TypeScript infers the return type, and the runtime still requires JSON-compatible data. Use objects, arrays, strings, finite numbers, booleans, and null; do not return class instances, functions, cycles, or bigint.

## Block context

| Property | Meaning |
| --- | --- |
| `ctx.input` | The explicit step inputs; defaults to an empty object before optional schema validation. |
| `ctx.request` | Original task request. |
| `ctx.prompt` | This step's goal, falling back to the original request. |
| `ctx.model` | Resolved model defaults for this step. |
| `ctx.models` | Frozen enabled model profiles, indexed by profile ID. |
| `ctx.visit` | One-based invocation count for this step. |

| Operation | Behavior |
| --- | --- |
| `await ctx.ai({ prompt, instructions?, model?, output? })` | A fresh model/tool session; returns Markdown or schema-validated data. |
| `await ctx.exec(command, { timeoutMs?, env? })` | Bash in the project directory. Returns command status and output. |
| `await ctx.readFile(path)` | Reads text through the host file tools. |
| `await ctx.writeFile(path, text)` | Writes text through managed file recovery. |
| `await ctx.log(message)` | Adds a durable activity message. |
| `ctx.summary(markdown)` | Sets the visible result summary. |
| `ctx.artifact(name, text)` | Adds a named text artifact. |
| `ctx.outcome(value)` | Sets the attempt's outcome to `pass`, `retry`, or `fail`; default is `pass`. |

Await every context operation before starting another. A block cannot use `Promise.all` to run its effects concurrently; split independent work into steps and compose them with `parallel()`.

## AI and model selection

This review block uses a profile if one is present and otherwise inherits the step model:

```ts
import { block, z } from "workflow";

export default block({
  name: "Review changes",
  async run(ctx) {
    const review = await ctx.ai({
      model: ctx.models.reviewer ?? ctx.model,
      instructions: "Inspect without editing. Report actionable findings with evidence.",
      prompt: ctx.prompt,
      output: z.object({ approved: z.boolean(), feedback: z.string() }),
    });
    ctx.summary(review.feedback);
    ctx.artifact("review.md", review.feedback);
    ctx.outcome(review.approved ? "pass" : "retry");
    return review;
  },
});
```

The workflow decides whether a `retry` outcome should stop, continue to a condition, or repeat a loop. See [outcome actions](workflows.md#outcomes-and-conditions).

Model settings resolve in this order, with later explicit choices overriding earlier ones:

1. Shared user defaults and project defaults.
2. Saved block model metadata, when present.
3. The workflow step's `model` option.
4. An explicit `ctx.ai({ model })` option inside the block.

A model can be an object with `provider`, `model`, `thinking`, `timeoutMs`, and `maxToolCalls`, or a model ID string that inherits the other settings. Supply both provider and model when switching providers. Choose available IDs and supported thinking levels from Settings rather than relying on a hardcoded model name.

Model choice can also be part of a block's declared input schema and passed to `ctx.ai`. A profile is a convenient source of settings, not a separate block type. Omit `model` on `ctx.ai` when the orchestrator's per-step assignment should control it.

An AI session has file tools, Bash, Git inspection, configured checks, and enabled skills/MCP tools. It does not inherit another session's conversation. Include the needed feedback in the prompt or inputs. Tool access follows the server user's access; a review instruction does not enforce a read-only OS boundary.

## Commands and host code

`ctx.exec` returns `{ exitCode, stdout, stderr, output, timedOut }`. A nonzero exit is a result, not an exception. Check both status and timeout, then set an outcome or throw deliberately. Command stdout/stderr appear in Activity. The default command timeout is 120 seconds; the block's own timeout also applies.

To use host APIs or installed packages, call a project script, for example `ctx.exec("bun scripts/check.ts")` or `ctx.exec("node scripts/publish.mjs")`. The requested runtime must exist. Pure TypeScript imports can be bundled, but block code cannot directly import `node:fs`, spawn processes, or perform arbitrary network effects outside context operations.

A deterministic commit/push procedure can be a code block. The starter **Push current branch** block runs Git without a model call and can create the remote branch/upstream when needed. It is editable source. Keep publication after verification and include it only when the task requests it.

Shell commands run with the server environment plus explicit `env` overrides. Shell edits, Git operations, and network effects are outside managed-file rollback; account for this when designing retries.

## Outputs and limits

Returned data is available through `ctx.output(step)` in the workflow and is persisted as the `data` artifact. `ctx.summary()` supplies the prominent result; otherwise a string result or JSON representation is used. Prefer a short summary and named artifacts for detailed reports.

Artifact names start with a lowercase letter, may contain lowercase letters, digits, hyphens, underscores, or dots, and are at most 64 characters. Paths and `..` are rejected. `data` and `summary` are reserved. The UI renders Markdown and offers copy/download actions; there is no binary artifact API.

Keep outputs concise. A summary is limited to 16,000 characters, a named artifact to 64,000 characters, and combined named artifacts to 128 KB. Larger results can also exceed the workflow snapshot limit. Store large generated files in the project and report their paths instead.

Code blocks default to a 600,000 ms timeout and 100 context operations. Set `timeoutMs` and `maxOperations` in the definition when needed. Model sessions have their own time/tool limits. Step visits and the total workflow step budget remain separate limits.

## Save a reusable block

The browser's **Settings → Blocks** editor supports creating, formatting, saving, copying, downloading, and removing blocks. **Design with AI** can draft or refine the code and its usage description; review the proposal before applying it.

For a directory-backed library, use:

```text
.workflow/blocks/verify/
├── block.json
└── block.ts
```

Minimal `block.json`:

```json
{
  "id": "verify",
  "name": "Run verification",
  "description": "Run the selected test command and return diagnostics without fixing implementation.",
  "executor": { "kind": "code", "file": "block.ts" }
}
```

The folder and block ID must match. Optional `prompt.md` and explicit skill resources provide additional context. Reuse this block with `step("tests", "verify", { inputs: { command: "bun test" } })`, or import its TypeScript module to infer its output type.

Web library edits are published atomically to `.workflow/library.json`. Once that file exists it takes precedence over the block directories, so editing a directory file alone will not change the active web-managed library. Keep using the web editor or deliberately manage the active library representation. Existing drafts retain their saved source and resources.

[Next: compose blocks into workflows](workflows.md) · [Configure the project](configuration.md)
