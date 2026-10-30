# Inspecting execution

[Documentation](README.md) → Inspecting execution

Use **Timeline** to follow a run from step visits through model requests and tool calls. Select a step in the graph, open Timeline, and choose a visit or operation. **Open exact evidence** opens the corresponding Data inspector. A repeated step visit and an automatic activity retry remain separate records.

The timeline uses saved start and completion records. Switch between wall-clock placement and operation sequence, zoom, or select a time range to focus the operation list. Unknown timing remains unavailable; an interrupted operation without a completion does not acquire an invented duration. Model-session duration includes tools and retries, while request spans describe individual provider invocations. Nested durations overlap and must not be summed as total elapsed time.

Tool calls consolidate start, progress, and result events. Expand parents to inspect child effects. Commands expose exit status and recorded output; file cards show captured lines or before/after text; unknown tools retain their structured input and output. Tool completion, a command's exit status, and workflow acceptance remain distinct.

## History and evidence

Activity offers grouped tool calls and raw event history. Older events load through append-order cursors, independently of the live 500-event feed. Timeline summaries cover the saved run's operation records; exact payloads load when a call is selected. Search explicitly covers operation summaries or the loaded raw-history window, rather than claiming to search unrequested file contents.

History snapshots carry a watermark. Reading earlier pages of a snapshot does not include later appends, and a refresh gets a new snapshot. Legacy text events remain available. Older operations with missing visit, attempt, parent, or timing evidence remain visibly incomplete instead of being reconstructed from current project files.

Execution summaries use a disposable in-memory cache that folds new events and rebuilds when the log changes outside the store. Historical pages and individual-call lookup still scan the retained log; they do not have a disk index. The browser bounds the rendered operation list to 80 rows per page, while the compact timeline response grows with the number of operations.

The terminal transcript uses the same operation projection as the browser within its retained window. The historical HTTP endpoints are also available to integrations:

- `GET /api/runs/:id/history?limit=200&before=<cursor>&asOf=<watermark>` returns a page in append order.
- `GET /api/runs/:id/execution` returns compact operation summaries and their watermark.
- `GET /api/runs/:id/operation-events?key=<key>` returns the selected operation's saved lifecycle records. Use the key returned by the summary API, URL-encoded as the query value.

## Request timing and context changes

Model request records identify their session and owning step visit. Timing begins at the client invocation of the provider stream function. First-token and generation intervals are recorded only when token deltas are observed; they are not provider-internal compute measurements. Requests that fail or are cancelled still retain their recorded boundaries. Retry backoff, context compaction, and the engine's budget queue have separate spans. Detailed timing is available in the selected request's recorded details.

The usage ledger remains the authority for costs. Request timing does not create extra model calls or add estimated per-tool charges. Compaction preserves the existing policy and accounting; its trace makes the event visible.

Compaction records include the triggering reason and available before/after token counts. The after count is explicitly an estimate. Result-only provider requests still record completion and usage, while first-token timing remains unavailable if no deltas were observed.

## Full command output

Direct TypeScript commands, built-in agent Bash calls, shared-tool commands using the local environment, and environment-backed checks can retain output under the owning attempt. Inline results remain bounded. The inspector can read output in pages or download the retained transcript; built-in agent sessions can use `read_output` to retrieve a scoped capture.

Captures retain stdout, stderr, and combined output, each bounded to 64 MiB. A capture reaching that limit is labeled truncated. The combined stream reflects observed chunk order. Interrupted commands retain captured output when process cleanup completes; abrupt host loss can leave an unfinished capture without a published manifest.

Output readers validate run, step, visit, capture identity, and stream. References do not accept arbitrary filesystem paths. Captures can contain project data and command output; include them in the same backup and retention policy as other private attempt evidence.

## Optional parallel reads

AI sessions run tools sequentially unless `maxParallelTools` is explicitly set, from 1 to 8, in a model profile or call override:

```ts
await ctx.ai({
  model: { maxParallelTools: 2 },
  prompt: "Inspect the relevant source files and report findings.",
});
```

Only trusted built-in read, list, and Git-inspection tools opt into parallel execution. Shared tools and MCP tools retain sequential execution. A batch containing an exclusive tool stays sequential. Cancellation removes queued calls and waits for active calls to settle. This is independent of workflow-step concurrency and replay safety. It can reduce waiting for independent reads; it does not guarantee an overall task speedup.
