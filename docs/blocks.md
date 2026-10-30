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
| `await ctx.call(tool, input)` | Invokes a frozen `defineTool()` operation with typed input and output. See [shared tools](tools.md). |
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

### Control context independently of tools

Step inputs are explicit: `ctx.input` contains only that step's `inputs`, not the entire workflow input or every preceding output. Select fields in the workflow's input callback. Code-only steps do not create model sessions.

By default, `ctx.ai` receives the enclosing task/graph, selected step inputs, project instructions, and attachments. Use `context: "none"` when a model only needs the prompt and instructions you supply:

```ts
const result = await ctx.exec("bun test");
const explanation = await ctx.ai({
  context: "none",
  tools: "none",
  model: ctx.models.routine ?? ctx.model,
  instructions: "Summarize this test result. Do not infer unreported checks.",
  prompt: JSON.stringify({ exitCode: result.exitCode, output: result.output }),
});
```

`context: "none"` omits the enclosing request, graph, inputs, attachments, project instructions/commands, and ambient skills. Explicit call instructions and role/ownership rules remain. Skills can be deliberately selected with `capabilities.skills`. Tool selection is independent: omit `tools: "none"` to retain project tools, or pass a list of shared tools. Tool use can read additional information, so context selection is a prompt/cost boundary, not a filesystem sandbox. `tools: "none"` permits only returning a result and avoids starting MCP servers.

If a block needs project constraints in an isolated call, include those constraints in its explicit instructions. No automatic summarizer silently forwards the prior conversation; the TypeScript author controls the handoff.

Use `ctx.ai({ tools: [myTool], ... })` to expose only selected [shared tools](tools.md) plus the result submission tool. The same `myTool` can be called from code with `ctx.call(myTool, input)`.

## Commands and host code

`ctx.exec` returns `{ exitCode, stdout, stderr, output, timedOut }`. A nonzero exit is a result, not an exception. Check both status and timeout, then set an outcome or throw deliberately. Command stdout/stderr appear in Activity. The default command timeout is 120 seconds; the block's own timeout also applies.

To use host APIs or installed packages, call a project script, for example `ctx.exec("bun scripts/check.ts")` or `ctx.exec("node scripts/publish.mjs")`. The requested runtime must exist. Pure TypeScript imports can be bundled, but block code cannot directly import `node:fs`, spawn processes, or perform arbitrary network effects outside context operations.

A deterministic commit/push procedure can be a code block. The starter **Push current branch** block runs Git without a model call and publishes to the same branch name on the selected remote, creating that remote branch/upstream when needed. A differently named fetch upstream (for example, a feature branch created from `origin/main`) is not a push destination. It is editable source; existing saved blocks and approved snapshots keep their source until explicitly updated. Keep publication after verification and include it only when the task requests it.

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

Applied library edits save metadata and an inline recovery snapshot to `.workflow/library.json`, then materialize executable source in `.workflow/blocks/<id>/block.ts`. For IDs listed in the manifest's `sourceFiles`, that TypeScript file is authoritative; you can edit it in your editor or through Settings. Old inline-only manifests remain compatible and are materialized on the next Apply/setup. Existing drafts retain their frozen source and resources. See [library persistence](configuration.md#where-settings-live) for interrupted-write behavior.

[Next: compose blocks into workflows](workflows.md) · [Configure the project](configuration.md)

### Protecting files owned by another step

A production repair can call `ctx.ai({prompt, protectedPaths: ["**/*.test.ts", "**/*_test.go"]})` to preserve independent regression tests. Add project-specific test paths; new default `implement` and `fix` blocks include common test patterns. Existing saved blocks are not silently migrated.

Matching managed writes are rejected before editing. The host also compares protected files before and after the AI call and rejects completion if files were added, removed, changed, or had their mode changed, including through Bash or MCP. Tool sessions check integrity between calls. Return invalid-test diagnostics to a separate test-authoring step; do not give the production step permission to repair tests. Run acceptance checks again after either owner makes a correction.

This is an integrity check, not process isolation. It does not undo shell/MCP side effects, detect edits restored before inspection, or inspect external paths and `.git`, `.workflow`, `node_modules`, `dist`, `test-results`, or `playwright-report` trees. Symbolic links are recorded but their external targets are not audited. Scans fail closed above 100,000 entries or 64 MB of protected content. Do not run a protected call alongside another step authorized to edit its protected files. Review an integrity failure before continuing; do not blindly retry on the modified baseline.

New default `verify` blocks complete test authoring rather than acceptance: valid tests are retained even when they expose a production defect. The separate `checks` block runs acceptance checks and blocks completion on failure. Production blocks likewise hand test-only defects to the test author; they do not own test repair. Existing saved libraries retain their reviewed contracts until explicitly updated.

Read-only AI calls use `protectedPaths: ["**/*"]` with the same documented exclusions. New default requirements, review and acceptance-check AI calls include this guard. Put the current call's narrow role before handoff evidence in its prompt: a read-only inventory inside a repair block must not perform the later repair. Keep related or deferred findings separate from selected repair scope.

`ctx.summary()` is a bounded display summary: text over 16,000 characters is explicitly abbreviated with its beginning and end retained. This does not change the block outcome or interrupt diagnostic routing. Keep full check diagnostics in an artifact or returned data; their existing size limits still apply.

## Small, single-purpose commit-message blocks

The modules in `examples/blocks/` can be saved individually in a project's block library:

| Block | Input | Output | Effects |
| --- | --- | --- | --- |
| `collect-commit-diff` | `{source: "staged" \| "unstaged"}` | `{diff, context}` | Reads one tracked Git diff; no model. |
| `draft-commit-message` | `{diff, context?}` | `{message}` | Luna (`gpt-6-luna`, low reasoning), with no file, shell or MCP tools. |
| `validate-commit-message` | `{message}` | `{message, subject}` | Deterministic syntax/style validation; no model. |

`examples/commit-message.ts` composes all three. The writer can also consume a supplied diff without collecting repository state. The validator emits the `commit-message` artifact. These blocks never stage, commit or push, and a validation pass is not implementation acceptance. Keep publication in a separate authorized block.

Empty or oversized diffs fail explicitly; untracked files are excluded. The 72-character subject limit and lowercase types are this library's style policy, not extra requirements of the Conventional Commits specification. Validation checks header structure and subject/body separation; it cannot establish whether the message is factually correct or whether an omitted breaking-change marker was needed.

For text-only transformations, `ctx.ai({tools: "none", prompt, output})` exposes only the result-submission tool. MCP connections are not started and enclosing step handoffs are not implicitly included; pass the selected data in the prompt. These prompts must fit within 32,000 characters because the call has no file tool to read larger context references. Project instructions still apply. Other calls retain their existing tool access.

Small blocks should have explicit input/output schemas, one responsibility, clear failure conditions and independent tests. Use models for judgment; keep Git inspection, validation and publication deterministic where possible. Splitting every trivial expression into an agent call adds latency and context cost without improving the contract.
