# Autonomous automation implementation plan

## Baseline and ownership

At baseline `91176dc`, a project lease owns one engine/host, Temporal owns execution history, Pi owns model sessions, and `WorkflowEngine.approve` permits only one active run. TypeScript workflow archives freeze source, imported blocks/tools, model selections, and settings. Experimental GitHub triggers have an independent SQLite inbox/outbox with reservation-first dispatch. Existing histories and trigger tables remain readable and unchanged.

## Incremental cutover

1. Add validated provider-neutral automation definitions, reusable block/workflow targets, schedules, normalized signals, correlated cases, routes, jobs, audit entries, and immutable definition versions. Capture executable targets with existing compilation/archive mechanisms; no planner is necessary.
2. Add a project-owned SQLite automation store and service. Commit intake, deduplication, case updates, jobs, and discovery checkpoints together. Reserve stable run IDs before dispatch. Support interval, timezone cron, once, manual, and signal schedules; coalesce or skip downtime by policy with bounded catch-up. Use deterministic first-match routing and revision policies, not model-based identity.
3. Introduce managed Git worktree ownership and immutable run association. Route every operation through the owned execution root, retaining central evidence/journals/usage. Keep unmanaged runs exclusive. Admit isolated jobs using concurrency, case/environment locks, queue/cooldown limits, and spending reservations. Blocked jobs retain their case/worktree but release compute capacity after work stops.
4. Reconcile completed discovery into signals; dispatch targeted continuation and separately approved output jobs. Retry only explicitly read-only targets with bounded backoff. Never automatically replay uncertain mutations; retain evidence and require reconciliation or human resolution. Publication targets receive stable idempotency keys and reconciliation mode.
5. Expose lifecycle, ingestion, inspection, approvals, and recovery in the common application, authenticated HTTP API, SDK/client, CLI/terminal, and generic scheduler screen. Retain existing trigger APIs/UI for compatibility; no provider-specific concepts enter automation contracts.
6. Add deterministic offline demonstrations and tests: nightly verification, multi-candidate fixture discovery, GitHub-as-user-code issue/PR/CI/review reactions, concurrent worktrees, restart/races, stale revisions, budgets, and uncertain publication. Update user docs and explicit legacy migration guidance.
7. Build once after integration, run targeted and repository-required checks, exercise actual CLI/API/browser surfaces without paid model/network calls, audit acceptance, then commit/push the task changes.

## Safety invariants

- Definition edits affect future jobs, never queued/admitted snapshots or active run policy.
- A signal's deterministic identity survives restart; checkpoint advancement cannot outrun durable intake.
- Current-revision routes cannot run against retired revisions; case jobs serialize and queued obsolete jobs may be superseded.
- Every admitted run has a stable reservation and exclusive authorized workspace; no cleanup deletes dirty/unpublished evidence implicitly.
- Automation enablement approves only its configured bounded targets. Publication defaults to a separate approval gate; no built-in merge or deploy behavior.
- Credentials are environment references, never stored secret values. Local worktrees isolate checkouts, not hostile processes; existing execution-environment injection remains the stronger-isolation seam.
- Legacy manual runs and triggers retain their recovery and approval contracts.
