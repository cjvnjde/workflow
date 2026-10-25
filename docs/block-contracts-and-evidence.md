# Focused blocks and execution evidence

A block should own one clear result. Define `input` and `output` Zod schemas in
its TypeScript source. The engine validates both. Library `contract` notes
(`inputs`, `outputs`, `effects`, `failure`) document the handoff for humans and
planning; notes alone do not enforce a policy.

In Settings → Blocks, **Test this block** accepts JSON input and a request and
creates a one-step draft from the saved definition. Review and approve the draft
before it runs. It uses real project tools, frozen source, normal execution
limits, file recovery and evidence. It is not a sandbox. Unsaved blocks cannot
be tested through this control.

## Ownership per model call

```ts
await ctx.ai({
  role: "test-author",
  writablePaths: ["tests/**"],
  prompt: "Add and run the regression for the reported bug.",
});
await ctx.ai({
  role: "repair",
  protectedPaths: ["tests/**"],
  prompt: "Fix the demonstrated production defect; preserve the regression.",
});
await ctx.ai({ role: "verification", prompt: "Verify the repair and report evidence." });
```

`test-author` requires an explicit nonempty write allowlist; `repair` requires
explicit protected reproduction paths. `verification` and `review` enforce an
empty write allowlist and reject conflicting write permissions. Calls without a
role retain their previous behavior. Test defects belong to the test author,
production defects to repair, and infrastructure failures require diagnosis.
The workflow must route that feedback and rerun verification; roles do not
invent a graph or guarantee that a chosen test is correct.

Ownership checks audit the existing protected-path scope, including changed,
added and deleted files. They are not an OS sandbox and cannot prevent transient
shell edits or external side effects. Deterministic `ctx.exec` calls must still
respect their assigned work. Parallel writers need separate worktrees followed
by explicit integration and checks of the combined result.

## Select only needed capabilities

```ts
await ctx.ai({
  role: "review",
  capabilities: {
    skills: ["project-reference"],
    mcp: { documentation: ["lookup"] },
    optionalMcp: ["documentation"],
  },
  prompt: "Review the implementation using the project reference when relevant.",
});
```

Only selected MCP servers connect and only selected tools are exposed. Empty
`mcp: {}` connects none. Omitted selectors preserve legacy enabled-server
behavior; `optionalMcp` applies only to servers otherwise selected. Unknown
selected servers/skills fail clearly. Required connection or tool discovery
failures stop the call; explicitly optional failures emit visible warnings.
Cancellation is never swallowed. Legacy server `tools`/`planningTools` fields
remain discovery metadata, not permission selectors.

Enabled project skills are presented as a name/description catalog. The model
calls `load_skill` for instructions when relevant. The saved Markdown preserves
its source/base-directory context so supporting references and scripts remain
accessible through file and shell tools. Those supporting files remain live
project files, not frozen copies. Explicit block skills remain supplied in full.
`tools: "none"` starts no MCP servers and exposes only `submit_result`; selected
skill instructions are supplied directly because no loader is available.
Capability selection controls exposed tools, not OS access through shell.

## Read the evidence

- Graph groups expose the predicate source. Loop labels show true → exit,
  false → repeat, and failure at the limit. New runs record each evaluated
  boolean and selected route. An explicit step `repeat` records that the exit
  predicate was skipped. The limit bounds attempts; it does not force them.
- Results separate explicit acceptance from authoring success, retain host
  check exit codes/output, and show unresolved latest step results.
- Attempt overlap and completed model-session overlap are reported separately.
  Different workspace records establish different working directories, not
  successful integration. Inspect the joined verification and review results.
- Actual model calls report the effective provider/model/thinking, exposed tools,
  session duration and usage; an inner call can override the step default.
  Unknown prices remain visibly incomplete.
- Failed/interrupted runs show diagnostic recovery guidance and explain retained
  checkpoints and external side effects. Classification is a diagnostic hint,
  not an automatic retry decision.

Old runs do not acquire invented historical evidence. Frozen execution bundles
remain intact; decision checkpoints are version-gated for Temporal replay.
