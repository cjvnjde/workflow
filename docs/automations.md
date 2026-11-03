# Durable automations

[Documentation](README.md) → Durable automations

Automations schedule an existing library block or a saved workflow without asking the planner to invent a new graph. The project host owns a durable queue; the ordinary Workflow engine, Temporal history, Pi sessions, tools, and recovery machinery execute each reserved run. Sources, routing, and output destinations are provider-neutral. An issue tracker, a local fixture, a command, or an MCP service belongs in ordinary user-authored code, not a provider setup wizard.

## Configure, inspect, then enable

1. Initialize the project and configure any models, skills, MCP servers, and credentials the target actually needs. Pure code targets need no model.
2. Save a reusable block or import a complete TypeScript workflow as a saved run. Choose **Settings → Automations → New automation**. Select **Library block** or **Saved workflow**, then the target, schedule, and **Direct** or **Discovery** mode.
3. Leave **Enable automatic execution** off. Set input JSON, workspace, environment reference names, execution limits, routes, admission/retry policy, and optional output configuration. **Save automation** captures executable targets and settings into an immutable version.
4. Select **Test automation**. Inspect its frozen draft and approve the job deliberately. A test executes real target code after approval; it is not a sandbox or a dry-run interpreter. Its returned results do not enqueue routes or configured output jobs. Do not put publishing side effects inside a target you intend to test safely.
5. Inspect the result and limits, then explicitly enable the definition. Enabling authorizes only its captured bounded targets under the configured job approval policies. `policy.approval: "required"` still gates each ordinary job. Output approval defaults to `required` independently.

**Refresh automations** reloads persisted state while retaining edits. On a stale revision, use **Reload saved automation** rather than overwriting someone else's change. **Check scheduler now** processes due work; **Run now** explicitly queues an enabled definition. The UI also shows versions, next fire, checkpoint, queue reasons, cases, observations, audit, usage, and linked workflow evidence. Scheduler-wide settings are inspected in the UI and changed through the CLI/API. There is no provider wizard or signal-submission form.

The host must remain running and awake. `workflow start --background` or `workflow serve --no-web` keeps scheduling independent of browser/TUI lifetime. A detached host does not restart itself after reboot; use a process supervisor when required. See [hosting](clients.md#keep-the-engine-running).

## Public configuration and frozen versions

The authoring SDK exports `automation(config)` from `predictable-workflow/workflow`; it validates/defaults a configuration without saving or enabling anything. JSON configuration can omit fields with defaults. For example, replace `verify` with an existing library block ID:

```json
{
  "name": "Nightly verification",
  "enabled": false,
  "schedule": { "kind": "cron", "expression": "0 2 * * *", "timezone": "UTC" },
  "target": { "kind": "block", "blockId": "verify" },
  "mode": "direct",
  "inputs": {},
  "execution": {
    "workspace": "worktree",
    "baseRef": "HEAD",
    "environment": [],
    "maxSteps": 30,
    "maxCommands": 50,
    "maxModelCalls": 0,
    "maxToolCalls": 100
  }
}
```

A complete saved workflow uses `target: { "kind": "workflow", "runId": "<saved-run-uuid>" }`. A block is wrapped using the existing compiler, not a planner. Targets may also be selected per route, for output, and for output reconciliation. Saving captures each executable archive, input defaults, model/resource selections, and execution settings. Later edits to the source run, block library, profiles, or definition do not rewrite queued/admitted jobs or their active policy. Save a new definition version to promote changes for future work.

Definitions have an optimistic `revision` and an immutable `versionId`. Updating requires the current definition revision; lifecycle actions can also carry it. Jobs retain their own version ID. `automationVersion(versionId)` exposes configuration and frozen target metadata/source for inspection, not credential values. State changes such as pause/disable do not mutate a previously captured job's policy.

Execution selects `workspace`, `baseRef`, environment variable names, named `resources` locks, optional `skills`, `mcpServers`, `modelProfile`/`agent`, and limits: `maxSteps`, `maxCommands`, `maxModelCalls`, `maxToolCalls`, and optional per-job `maxCostUsd`. Route/output execution overrides are complete normalized policies, not incremental patches. Inspect the saved version before enabling.

## Schedules and clock behavior

| Schedule      | Configuration                                                      | Behavior                                                                                                                                   |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Manual        | `{ "kind": "manual" }`                                             | No timer; use Run now after enablement.                                                                                                    |
| Signal intake | `{ "kind": "signal" }`                                             | No timer; normalized signals select routes.                                                                                                |
| Interval      | `{ "kind": "interval", "seconds": 300 }`                           | First fire one interval after initial save; subsequent due times stay anchored to the persisted schedule.                                  |
| Cron          | `{ "kind": "cron", "expression": "0 2 * * *", "timezone": "UTC" }` | Deterministic five-field minute/hour/day/month/weekday expression in an explicit timezone; seconds fields and randomized `H` are rejected. |
| Once          | `{ "kind": "once", "at": "2027-01-01T02:00:00Z" }`                 | One persisted due instant, including a past instant handled by the missed-run policy.                                                      |

Cron uses timezone-aware calendar rules, not a fixed 24-hour interval. In a spring-forward gap, a nonexistent local firing time shifts forward: `30 2 * * *` in `America/New_York` fires at `2026-03-08T07:30:00Z` (03:30 local), rather than skipping that day's 02:30 schedule.

During a fall-back fold, a repeated local wall-minute fires only at its **earlier occurrence**, for both forward scheduling and bounded catch-up. For `30 1 * * *` in `America/New_York`, November 1, 2026 fires at `05:30Z`, not again at `06:30Z`; the next daily fire is November 2 at `06:30Z`. This also skips the later copy of repeated minutes in a minutely schedule. Prefer UTC to avoid local DST shifts altogether.

Each due job has an absolute-time identity; a backward host-clock adjustment does not recreate previously scheduled jobs and waits for the persisted next-fire instant. A forward jump is treated as overdue work. Timers use the host clock with roughly one-second coordinator ticks, not a hard real-time deadline. Changing a schedule resets its next fire; saving the same schedule preserves the existing checkpoint.

`policy.missedRuns` controls downtime: `latest` (default) coalesces overdue work to the most recent due fire; `catch-up` keeps only the most recent `maxCatchUp` fires (default 3, maximum 20), in chronological order; `skip` drops a fire at least one second late. Older missed fires are not an unbounded backlog. `policy.overlap: "skip"` (default) drops a timer fire while a direct/discovery job remains pending; `queue` retains eligible fires subject to queue limits. Overlap and catch-up combine: an overlap skip may discard catch-up fires too. Scheduled jobs and the next-fire update commit together. Queue failure does not advance that transaction.

Pausing/disabling stops new timer scheduling and queued automatic starts, not an already executing job. Existing pending work, checkpoints, and history remain. Re-enabling applies the persisted missed-run policy. Signal intake can still record observations and queue work while disabled; admission waits for enablement. Pause/cancel individual jobs separately.

## Discovery, signals, and exact routing

A direct target performs one bounded task. A discovery target returns machine JSON, not Markdown:

```ts
import { discoveryResult, workSignal } from "predictable-workflow/workflow";

const result = discoveryResult({
  signals: [
    workSignal({
      sourceId: "local:backlog",
      resourceKey: "task:42",
      signalKind: "candidate",
      revision: "commit-or-source-revision",
      fingerprint: "stable-observation-version",
      observedAt: "2026-11-03T12:00:00Z",
      correlationKey: "task:42",
      payload: { ready: true },
      references: { report: "reports/task-42.json" },
    }),
  ],
  checkpoint: { cursor: "next-page" },
});
```

Return that value from the workflow. Discovery may return zero or many signals, up to 500 per batch. The checkpoint advances atomically with durable observations, deduplication, case updates, and routed jobs; intake failure leaves it unchanged. Keep payloads focused and put large evidence behind references. Machine workflow output is bounded JSON, separate from display summaries. A direct/reaction result containing `signals` can also deliver observations.

Machine results must be JSON within 256 KB. A manual workflow can still complete with its historical truncated display preview when its return value is larger or non-JSON. Automation delivery instead enters `needs_attention` with the recorded result error; it never routes or publishes that preview, and reconciliation does not replay the completed effects.

Inside a block, `await ctx.emitSignal(signal, { automationId? })` durably ingests a normalized signal; it does not execute a child workflow synchronously. An automation-owned run defaults to its owning definition and cannot redirect to another definition. A manual run must provide an explicit automation ID. Emission is a real side effect: unlike returned test results, an explicit emission is not a promise of a dry run. Keep stable identities across host-operation retries.

Signal identity is `(sourceId, id)` when an explicit delivery `id` exists; otherwise it is `(sourceId, resourceKey, signalKind, revision, fingerprint)`. Payload edits alone do not make a new observation. Deduplication is per automation and survives restart. Cases are project-wide, keyed by `(sourceId, correlationKey ?? resourceKey)`, so related resources can share one serialized continuation without sharing a model conversation.

Routes are ordered: the first matching `signalKind`, optional `sourceId`, and exact top-level scalar `match` payload fields wins. There is no model-based routing or fuzzy identity. A route with no target updates/observes the case without executing anything. Route `inputs`, `priority`, `approval`, and optional execution policy apply to its reaction job.

| `revisionPolicy`    | Meaning                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advance`           | Establish or advance the current revision, retiring the old one. Older observations/retired revisions cannot roll it backward. Use for authoritative source changes.                                                               |
| `current` (default) | React only to the case's current revision. An unknown/not-yet-current revision waits as `awaiting-revision`; it can be reconsidered when an advancing observation arrives. Use for CI/review feedback tied to a specific revision. |
| `any`               | Accept a matching observation independent of current/retired revision. Use deliberately; it does not make stale feedback authoritative.                                                                                            |

`policy.supersede` defaults to true: obsolete queued work may be cancelled before execution when a newer case revision arrives. Running work is not silently killed. Out-of-order observations remain visible in history with their disposition.

### Explicit context, not resumed conversations

Targets receive base inputs plus route inputs and scheduler-owned fields. At the workflow boundary, use `ctx.input`; a composed step must explicitly forward selected fields through its `inputs` callback. A block target receives the wrapper's input.

- `signal`: the normalized event that selected a reaction.
- `case`: current revision, persisted references/payload, and prior `lastJobId`/`lastRunId` when present.
- `prior`: bounded recent terminal case-job references/results added at admission; large results are reduced to identifiers/statuses.
- `automation`: `{ id, jobId, phase, checkpoint?, publicationKey? }`.

No previous model conversation is resumed or silently summarized into the next job. Author code chooses which evidence to read and which fields an AI call sees. Cases and prior results provide continuity; they do not grant source freshness or ownership beyond the captured revision.

## Queue, admission, and workspace ownership

Jobs progress through `queued` → `admitted` → `running`, then `completed`, `failed`, or `cancelled`. `waiting` covers approval or a paused run; `needs_attention` covers uncertain dispatch, interrupted execution, invalid result delivery, and uncertain publication. Job status and the linked workflow's `runStatus` are separate; inspect both and the persisted reason.

Admission reserves the job/run identity before dispatch. Restart reacquires that same run instead of blindly creating another one. Global and per-definition concurrency, queue limits, cooldown, case ownership, named resource locks, priorities with age-based fairness, and spending reservations determine eligibility. Pausing releases compute capacity only once execution actually stops; the case/workspace and uncertain-effect protections remain. Unmanaged manual/legacy-trigger runs still require exclusive project ownership. Distinct automation-owned worktrees can execute concurrently; `workspace: "project"` requires exclusive checkout access.

Restart reconciliation is asynchronous. An in-flight projection checkpoint can wait for its existing 30-second activity deadline before retrying, even after execution effects have finished. This does not authorize replaying mutating model/tool/command work. Inspect the linked run and recovery evidence rather than create another job to bypass that delay.

Default managed worktrees live under `.workflow/automation-workspaces/<runId>` on owned branches. Their reservation pins a resolved base commit and ownership metadata; later effect/approval/resume boundaries verify that ownership. Continuations can use a prior owned committed result through a fresh worktree rather than resuming a model session. Preserve the owned branch; do not detach or repurpose the checkout. Dirty prior work requires inspection/commit, not silent copying into another job.

**A worktree is not an OS sandbox.** It isolates Git checkouts, not hostile processes, filesystem access, or network access. Commands run as the host user. Environment configuration stores names, not secrets: `environment: ["GH_TOKEN"]` resolves the value from the host at execution. Command environments retain a small basic OS environment plus explicitly allowed references and Workflow's execution protocol. Existing Workflow-managed Pi credentials still serve model requests; MCP bearer-token references must be explicitly allowed for automated execution. Select only needed skills/MCP servers. See [configuration](configuration.md#automation-scope-and-credentials) and the existing execution-environment injection seam for stronger host-supplied isolation.

Per-job reservations use `execution.maxCostUsd`; automation `policy.maxCostUsd` and scheduler-wide `maxCostUsd` gate admission against one consistent snapshot of live/recorded spending plus outstanding reservations. These are cumulative stored-job limits, not automatically reset daily budgets. A configured spending cap requires a per-job reservation; unpriced requests and interrupted/orphaned model accounting block further capped admission rather than assuming missing charges were free. This uncertainty survives cancellation and retries. Calls, commands, tools, and steps also have frozen bounds; a code-only target can set `maxModelCalls: 0`.

The effective job cap is the smallest of the automation execution cap and the saved workflow's run/total caps. It binds the existing usage ledger: capped model sessions sharing that job's scope are admitted one at a time and recheck recorded spending after the preceding session. A saved cap still applies when the automation does not override it.

Automatic provider retries are disabled for dollar-capped automation sessions. A failed or aborted request after dispatch may already have been billed; retained usage is a lower bound and the ledger records incomplete accounting, blocking further capped calls rather than treating the missing charge as zero. A request rejected before dispatch remains known-free. Manual/uncapped Pi retry behavior is unchanged. The separately configured read-only discovery retry policy does not make an uncertain provider charge free.

Budgeted automation model calls additionally preflight every provider request after pending usage is recorded. They reserve the model's full context window at the highest frozen input/cache-read/cache-write price across tiers, conservatively including the one-hour cache-write rate of twice the input price, plus its full maximum output at the highest output price. If that worst-case request cannot fit the remaining run/session cap, execution rejects it **before** contacting the provider; it does not silently reduce output tokens. This intentionally conservative check can reject a short prompt under a small cap: select a smaller model or increase the explicit cap. Recorded usage at frozen prices, not the maximum reservation, decrements the remaining balance; it remains an estimate rather than a provider invoice or subscription-quota guarantee. Unknown prices are not treated as free. This additional request preflight applies to automations, not unchanged manual-run budgeting.

Cleanup is explicit and terminal-only, and visits every retained attempt. It refuses dirty worktrees, commits not reachable from remote refs, and checkouts still referenced by a case's latest run or a pending dependent job. It does not silently delete unpublished work, branches, or execution evidence. Back up scheduler state together with the rest of `.workflow/`, and preserve relevant Git/worktree data. Never remove the queue database to clear an error: that destroys deduplication and recovery state.

## Output approval and uncertain effects

An optional `output` target creates a separate job after successful direct/reaction work. It receives `result`, run/artifact references, case/signal context where applicable, and a stable `automation.publicationKey` (`workflow-automation:<parent-job-id>`). Output defaults to separate approval. Workflow provides no automatic merge/deploy behavior: any such operation would be explicit user-authored code under your chosen policy.

Outputs retain their parent's frozen revision policy and evidence; obsolete queued publication cannot bypass revision checks. Internal output/reconciliation jobs have bounded queue headroom (`maxQueued + concurrency`) so a queued successor cannot deadlock the stage that must complete first. New external intake still observes `maxQueued`.

Output code must check for the stable publication marker before writing. Core has no provider knowledge and cannot guarantee exactly-once remote effects. A failed/interrupted output is never automatically replayed. Inspect the job, local evidence, and remote state. With an `output.reconcile` target, **Reconcile job** cancels a suspended publication and queues a read-only check from an independent clean base using the same publication identity; it does not depend on the uncertain checkout being clean or terminal. Return `{ published: true, reference?: string }` to acknowledge an existing outcome, or `{ published: false }` to leave it human-gated. Reconciliation must not publish as a fallback. **Resolve job** is an explicit human confirmation of the external outcome, not a new execution.

Retries default to `safe: "never"`. Only direct/discovery targets explicitly declared `policy.retry.safe: "read-only"` receive bounded automatic retries after a failed run, with exponential backoff and deterministic jitter. This declaration is your responsibility, not a sandbox enforcement mechanism. Interrupted mutating work is never blindly retried. **Retry job** only retries failed admission with the same reserved identity before execution; inspect recovery and use explicit **Resume** for interrupted runs. **Reconcile** can retry durable result processing without rerunning a completed target. See [recovery boundaries](operations.md#file-recovery).

## CLI, terminal, and client API

```sh
workflow automation save automation.json --json
workflow automation list --json
workflow automation show <automation-id> --json
workflow automation test <automation-id>
workflow automation jobs <automation-id> --json
workflow automation job <job-id> approve
workflow automation enable <automation-id> <current-revision>
workflow automation run-now <automation-id>
workflow automation tick
workflow automation version <version-id> --json
```

Update with `workflow automation save automation.json <automation-id> <current-revision>`. `config <id>` exports configuration; `settings [settings.json]` reads/updates global settings with their revision. Definition actions are `enable`, `pause`, `disable`, `resume`, `run-now`, `test`; job actions are `approve`, `pause`, `resume`, `cancel`, `retry`, `reconcile`, `resolve`, `cleanup`, subject to state checks. Terminal `/automations` inspects definitions/jobs and opens linked runs.

`WorkflowClient` exposes `automations()`, `saveAutomation(config, id?, revision?)`, `automationAction(id, action, revision?)`, `automationJobAction(id, action)`, `automationVersion(versionId)`, `tickAutomations()`, `updateSchedulerSettings(settings)`, and `emitSignals(id, { signals, checkpoint? })`. Embedded hosts use `app.automations`; scheduling belongs to the shared application, not a browser timer. See [clients](clients.md#durable-automation-clients) and the [route reference](reference.md).

External signal submission uses `POST /api/automations/:id/signals` with `Authorization: Bearer <WORKFLOW_SIGNAL_TOKEN>`. The host must explicitly configure a token; there is no implicit default. The CLI reads the same variable in its local process: `workflow automation signals <automation-id> signals.json`. `WorkflowClient` accepts `signalToken` in its constructor options. Never include the token in configuration, inputs, URLs, or committed files. Existing loopback/origin guards still apply; this endpoint does not turn the local API into a public multi-user server. Ordinary UI actions keep their existing local trust boundary.

## Runnable examples

From the repository checkout, with an initialized project host already running, use its actual loopback URL and absolute project path:

```sh
bun examples/automations/bootstrap.ts http://127.0.0.1:4310 /absolute/project
# Optional GitHub user-code example (requires live credentials and configured models):
bun examples/automations/bootstrap.ts http://127.0.0.1:4310 /absolute/project owner/repository
```

The [bootstrap](../examples/automations/bootstrap.ts) copies ordinary example modules/fixtures into that project and creates saved workflow targets and disabled definitions. It does not enable them. Managed worktrees require an initialized Git repository with a committed HEAD. The bootstrap embeds fixture candidates in configuration, so that offline example does not depend on newly copied files being present in the clean checkout; other scripts/files read at execution must exist in the selected base revision. Review commands before approving. Re-running bootstrap creates new definitions; do not enable duplicate copies for the same source.

- [nightly.ts](../examples/automations/nightly.ts): deterministic scheduled verification, no model required. The bootstrap's default command installs locked dependencies then runs the repository test script; adapt it to your project. Package installation may need network/cache access, unlike fixture discovery.
- [fixture.ts](../examples/automations/fixture.ts) and [candidates.json](../examples/automations/candidates.json): offline multi-candidate discovery, stable identities, and routed handling.
- [github.ts](../examples/automations/github.ts): GitHub as ordinary `gh`/workflow code, issue intake, current-revision CI/review reactions, bounded repair/verification, independently gated publication, and marker reconciliation. Configure `GH_TOKEN` in the host environment and allow only its name in the execution policy. This example is not a built-in GitHub connector or an offline guarantee for its live operations.

The GitHub example advances cases with an observation-only `head-observed` route before current-revision CI/review reactions. Feedback work verifies the fetched commit against the signal revision in a newly owned clean worktree; it does not trust an older reference or parent checkout as the current PR head. Publication uses an explicit expected-base lease when pushing and refuses an existing PR update without a verified base. These are safeguards in the example's authored code, not provider-specific guarantees supplied by the scheduler.

Successful current-head CI also has an explicit path: a nonempty all-success check set emits `checks-passed`, which routes to a code-only report rather than implementation. Its separate output job still requires approval. The example's `alert` input defaults to `{ "kind": "pull-request" }`; use `{ "kind": "issue", "number": 99 }` to report on a configured alert issue instead. Publication checks paginated comments for its stable marker before posting, then emits `checks-reported` to retain the report reference on the current case. It does not merge the PR.

## Legacy trigger migration is explicit

Existing **Settings → Triggers**, trigger APIs, `.workflow/triggers/state.sqlite`, polling behavior, and histories remain unchanged. Generic automations use separate storage and do not import or rewrite trigger definitions/events. Existing trigger jobs remain on their legacy approval, exclusive-project, and recovery path.

To migrate, recreate the desired source/discovery and target behavior as a generic automation, test it disabled, and choose an explicit cutover observation window/checkpoint. Disable the old trigger and account for its queued/running jobs and pending output before enabling overlapping source work. Generic and legacy deduplication are independent: merely using the same repository/resource does not prevent duplicate processing across the two systems. Retain old trigger/run history for audit; do not delete it to simulate migration. See [legacy triggers](triggers.md#moving-to-generic-automations).
