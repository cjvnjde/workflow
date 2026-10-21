# Writing workflows

[Documentation](README.md) → Writing workflows

A workflow exports `workflow({ name, flow })` from a TypeScript file. The `flow` connects reusable blocks through high-level primitives; it is also the source of the graph shown before approval.

Import the SDK from `"workflow"`. Workflow resolves that name when it typechecks and bundles your source. Submit the file through the browser or `workflow run file.ts`; running it directly with `bun file.ts` does not schedule its steps.

## A review loop

This complete workflow passes review feedback into implementation and repeats until the reviewer approves, with at most three visits per step:

```ts
import { workflow, block, step, sequence, repeatUntil, z } from "workflow";

const implement = step("implement", block({
  input: z.object({ feedback: z.string() }),
  async run(ctx) {
    return ctx.ai({
      model: ctx.models.coder ?? ctx.model,
      instructions: "Implement the request and add focused tests. Do not commit or push.",
      prompt: `${ctx.request}\nAddress this feedback: ${ctx.input.feedback}`,
    });
  },
}), {
  maxVisits: 3,
  inputs: ctx => ({
    feedback: ctx.output<{ approved: boolean; feedback: string }>("review")?.feedback ?? "",
  }),
});

const review = step("review", block({
  async run(ctx) {
    const result = await ctx.ai({
      model: ctx.models.reviewer ?? ctx.model,
      instructions: "Review without editing. Inspect the changes and run relevant tests. Approve only if correct and tested.",
      prompt: ctx.request,
      output: z.object({ approved: z.boolean(), feedback: z.string() }),
    });
    ctx.summary(result.feedback);
    ctx.outcome(result.approved ? "pass" : "retry");
    return result;
  },
}), { maxVisits: 3, on: { retry: "continue" } });

export default workflow({
  name: "Implement and review",
  flow: repeatUntil("revision", {
    body: sequence(implement, review),
    until: ctx => ctx.output(review)?.approved === true,
    maxIterations: 3,
  }),
});
```

Profiles named `coder` and `reviewer` are optional here: each call falls back to its inherited model. A model still needs to be connected. The string reference to `"review"` allows feedback to refer to the later declaration; the step handle in `ctx.output(review)` infers its output type.

For a separate command-based test step, parallel inspection, and a conditional final report, use [examples/composed.ts](../examples/composed.ts).

## Composition primitives

| Primitive | Behavior |
| --- | --- |
| `step(id, blockOrSavedId, options?)` | Creates a durable invocation of a block. Declaration alone does not schedule it. |
| `sequence(a, b, c)` | Runs children in order. |
| `parallel([a, b], { concurrency?, label? })` | Runs independent branches and joins their results. Default concurrency is 4; allowed values are 1–8. |
| `when(id, condition, thenNode, elseNode?)` | Runs the selected branch. The unselected branch is marked skipped. Without an else branch, false simply continues. |
| `repeatUntil(id, { body, until, maxIterations })` | Runs the body at least once, then evaluates the condition. An unmet condition at the limit fails the workflow. |

Groups can nest. Step and explicit group IDs must be unique lowercase kebab-case, up to 64 characters. A loop reuses its step IDs on each iteration; do not declare the same step twice in the tree to reuse it. Create a new step ID when invoking the same block elsewhere.

A declaration supports at most 200 tree nodes and 20 levels. Empty groups and duplicate IDs are rejected. Unused local primitive declarations are also reported: if you define a publication group, attach it to the exported flow, for example `sequence(reviewLoop, publish)`. This check catches unused declarations, not every possible semantic omission.

## Step options

| Option | Meaning |
| --- | --- |
| `label` | Human-readable label in the graph. |
| `prompt` | Step goal; a string or synchronous function of flow context. |
| `inputs` | Explicit object passed to `block.run`; a literal or synchronous function of flow context. |
| `model` | Inherited model choice for AI calls in this step; accepts a model ID string or a model settings object. |
| `maxVisits` | Per-step limit, 1–30; defaults to 30. |
| `on` | Actions for `pass`, `retry`, and `fail`: `continue`, `stop`, or `repeat`. |

The run also has a total step limit, configured in **Settings → Execution** (default 30). Loop iterations and step visits are separate limits. A resumed interrupted attempt consumes another visit and another total step. Reaching either bound stops execution even if the loop would otherwise continue.

## Outcomes and conditions

Default actions are:

| Block outcome | Default action |
| --- | --- |
| `pass` | Continue to the next child. |
| `retry` | Stop with a failed workflow. |
| `fail` | Stop with a failed workflow. |

Use `on: { retry: "continue" }` when the loop's condition should inspect the returned review data. Use `on: { retry: "repeat" }` when a test failure should immediately restart the nearest enclosing loop and skip the remaining body. `repeat` requires an enclosing loop. Hard failures usually keep their default `stop` action.

`repeatUntil` checks its condition after a normally completed body. An explicit `repeat` skips that check and starts the next iteration. At the iteration limit, failure is explicit rather than silently accepting an unfinished result.

Returning `{ approved: false }` does not set an outcome. Calling `ctx.outcome("retry")` does not create an automatic retry policy by itself. Define both data and routing deliberately. Nonpassing attempts also affect [managed-file recovery](operations.md#file-recovery).

Conditions must return a synchronous boolean. Use `ctx.output(review)?.approved === true`, rather than a possibly undefined property or a Promise. Conditions, deferred prompts, and input builders must be deterministic and free of host effects.

## Passing context

Deferred inputs, prompts, and conditions receive:

| Field or method | Value |
| --- | --- |
| `ctx.request` | The original task request. |
| `ctx.input` | The workflow input object, validated by its optional input schema. |
| `ctx.models` | Enabled model profiles captured when the workflow was created. |
| `ctx.output(step)` | The step's latest completed returned data, with its inferred type. |
| `ctx.output<T>("step-id")` | The same lookup by ID, with an explicit expected type. |
| `ctx.result(step)` | The result envelope: `{ outcome, summary, artifacts, data }`. |
| `ctx.iteration("loop-id")` | Current one-based loop iteration, or 0 when absent. |

Before the first visit, a step has no result. Optional access and defaults make feedback loops work on their initial iteration. Skipping a step does not manufacture new output; these lookups retain its latest completed output, if any.

Only the `inputs` object becomes `block.run(ctx).input`; workflow inputs are not copied into every block automatically. Pass the exact fields a block needs. Outputs must be JSON-compatible values. Use artifacts and summaries for readable reports; typed returned data is better for programmatic conditions.

When using a saved block ID, inspect that block's actual return shape. A TypeScript generic does not transform `{ outcome, summary }` into `{ approved }`. Starter blocks that report outcomes can be checked with `ctx.result(review)?.outcome === "pass"`.

## Parallel behavior

Each branch starts with the outputs available before the fork. It can see results from its own preceding steps, but not partially completed siblings. Results merge after the join. The group's final summary comes from its last declared branch that ran, independent of completion order.

The scheduler permits at most eight active steps across nested groups. A failure stops admission of queued work and waits for already-running siblings. Pause drains active work; resume and cancellation operate on each attempt. [Operations](operations.md) describes interruption handling.

Parallel blocks share one working directory. Independent reads, checks without shared generated outputs, and disjoint edits are suitable. Put overlapping edits, Git mutations, or checks rebuilding the same files in sequence. Managed file writes reject conflicting active claims; shell and external effects are not isolated by that guard.

When an execution spending limit is set, AI sessions serialize against the remaining budget. Commands and other operations may still overlap. See [Configuration](configuration.md#execution-limits-and-costs).

## Preview, approval, and editing

Saving formats source with Prettier, typechecks it, bundles static imports, and produces the graph. Typechecking itself does not execute the module. Declarative preview evaluates module initialization in a bounded environment without host APIs; it never invokes blocks, conditions, or deferred inputs.

Keep declarations deterministic. Place file, process, network, and model effects inside blocks through their context methods. Static pure helper imports are supported and captured in the bundle; dynamic imports, host-module imports, and top-level await are rejected. A project script invoked by `ctx.exec` is read when it runs rather than bundled into the workflow.

Approved workflows retain their source, profiles, block catalog, and configuration. Editing Settings changes future proposals, not active runs. Update a draft's source to change its graph; dragging its visual nodes changes layout only.

## Existing formats

Imperative `workflow({ async run(ctx) { ... } })` is still supported. `await ctx.step(id, block, options)` invokes a block durably; code controls the next step. Await each step sequentially. Use declared `parallel()` composition for concurrent blocks and for a complete graph preview before execution. See [implement-reviewed.ts](../examples/implement-reviewed.ts).

Older JSON graphs retain explicit `on: { pass, retry, fail }` routes to other step IDs, `$complete`, or `$failed`, plus named artifact handoffs. Legacy `agent()` and `script()` definitions remain compatibility APIs. New reusable blocks use [the single `block()` interface](blocks.md).
