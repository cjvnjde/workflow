# GitHub triggers

[Documentation](README.md) → GitHub triggers

**Alpha:** Triggers are marked experimental in Settings.

Triggers turn newly created GitHub issues and pull requests into runs of a saved workflow. The application polls GitHub in the background, persists matching events, and starts queued runs when the project is available. The browser can be closed. Temporal remains responsible for workflow execution.

## Configure and test

1. Create a TypeScript workflow through **New task → Use a TypeScript workflow**. The [GitHub event report example](../examples/github-event-report.ts) produces a report without a model call or project-file changes and can be saved as a draft without initial event input.
2. Open **Settings → Triggers**, name the trigger, and enter `owner/repository`.
3. Choose **New issue** or **New pull request**, and select a draft or completed workflow. Saving captures its executable archive, source, blocks, models, input defaults, and project settings. Later source/library edits do not change this snapshot. To promote a new version, select a different saved run.
4. Optionally filter by labels and authors, set a spending limit, and choose a result destination. Every required label must match; any allowed author may match. Draft PRs are excluded by default.
5. Save with automatic execution disabled. Enter an existing issue/PR number under **Test this trigger** and select **Create test draft**. Tests bypass creation time, label, author and draft filters; the item must still be the correct issue/PR type. Open the draft from event history, inspect it, and approve it to test execution. Test runs never publish a result comment automatically.
6. Enable automatic execution and save. New matching events will run without per-run approval. Choose **Poll now** to check immediately.

New triggers watch items created from their first save time; they do not import the repository's old issues. Disabling pauses polling and queued starts, retaining the checkpoint for catch-up on re-enable. Changing the repository or event type starts a new observation window. Already admitted events retain their original workflow, filters, budget and result destination. Already running workflows and their result delivery continue when a trigger is disabled.

Only one workflow runs per project. Paused or interrupted workflows retain ownership and hold the queue. Resolve, resume, or cancel those runs through the normal workspace. Trigger dispatch never automatically retries an interrupted mutating step.

## Event input and outputs

Each new run retains the saved workflow's input defaults and replaces `input.event` with:

```ts
{
  id: "github:owner/repository:issue.opened:42",
  kind: "issue.opened", // or "pull_request.opened"
  repository: "owner/repository",
  number: 42,
  title: "Issue title",
  body: "Issue description",
  bodyTruncated: false,
  url: "https://github.com/owner/repository/issues/42",
  author: "octocat",
  labels: ["workflow"],
  createdAt: "2026-10-26T10:00:00.000Z",
  updatedAt: "2026-10-26T10:00:00.000Z",
  // PRs also include headSha, baseSha, headRef, baseRef and draft.
}
```

Declare `event` in the workflow's Zod input schema if it has one; otherwise a schema that strips unknown fields could discard it. In a composition, pass the event into blocks with `inputs: ctx => ({ event: ctx.input.event })`. In an imperative workflow, read `ctx.input.event`. Treat descriptions as external data when building model prompts.

Bodies are limited to 32,000 characters and indicate truncation. PR commits are captured when polling observes the PR. Workflow does not fetch or check out PR branches automatically. A review workflow must explicitly inspect the captured commit, for example in an isolated worktree, and state its review scope. This release detects new items; it does not trigger on every later commit, comment, label change, or historical webhook action. Filters use the current item state at observation, so an item created after trigger setup can qualify when it is labeled later.

Results always remain in the normal workflow history with artifacts and checks. Selecting **Also post a GitHub comment** explicitly enables posting a summary on the originating issue or PR after completion, failure, or cancellation. It uses workflow output when available, otherwise step summaries, and includes the workflow status/run ID and observed PR commit. It does not approve or merge PRs.

## GitHub access

The server uses `GH_TOKEN`, then `GITHUB_TOKEN`, then the token from `gh auth token --hostname github.com`. Public repositories can be read anonymously. For private repositories, configure a credential with Issues read access and Pull requests read access when watching PRs. Publishing comments also requires appropriate Issues or Pull requests write access. Use GitHub CLI sign-in or supply the token to the server environment; tokens are not stored in trigger definitions or passed to workflow event inputs.

Polling is outbound HTTPS to GitHub.com; no public receiver or tunnel is required. The default interval is 60 seconds (minimum 30). All response pages must be processed before the checkpoint advances. API failures retain the checkpoint and are shown on the trigger. Use **Poll now** after fixing authentication or repository access.

Real GitHub access requires live mode. Demo mode never contacts GitHub. Embedded test hosts can inject a fixture adapter through `triggerSource`.

## Persistence and recovery

`.workflow/triggers/state.sqlite` contains configuration versions, frozen templates, event identities, checkpoints, run reservations, and result-delivery state. SQLite transactions commit the admitted events and checkpoint together. Each event reserves a run ID before contacting the engine, so restart can reacquire a draft or execution whose dispatch receipt was interrupted. Duplicate polling results are ignored for that trigger, including after restart. Manual tests always create separate drafts.

Queued events survive application restarts. The event history shows the latest 100 entries; older identities remain in storage for deduplication. **Retry dispatch** retries run admission, not completed workflow execution. **Cancel queued event** prevents that event from starting. An edited automatic draft fails its frozen-snapshot check instead of being silently approved.

Comment publishing uses a persistent outbox and a unique marker. After a lost response, the dispatcher looks for the original comment. If the outcome remains uncertain, it holds delivery rather than posting again. **Check delivery again** reconciles it. If GitHub never accepted the comment, inspect the issue and publish manually as needed; this conservative behavior avoids duplicate comments. No general exactly-once guarantee is made for effects inside user workflow blocks.

Back up the entire `.workflow/` directory with the application stopped, including triggers, execution versions, run files and Temporal state. Do not delete the inbox to clear errors; doing so removes deduplication history. Saved workflows keep the same activity recovery limits described in [Operations](operations.md).

## Keep it running

`workflow serve` runs the engine, triggers, API and web workspace. `workflow serve --no-web` runs the same automation without GUI assets. Closing the browser does not stop either. The host must remain awake and connected for timely execution; polling catches up from its checkpoint after downtime while matching items remain available through GitHub's API.

The one-shot `workflow exec` command does not start background triggers. Embedded hosts can likewise pass `startTriggers: false` to `createApplication`.

On a Linux host, adapt the [systemd user-service example](../examples/workflow.service) with absolute project, Bun and installation paths, and a PATH containing your workflow tools. Install the unit in your systemd user directory, then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now workflow.service
journalctl --user -u workflow.service -f
```

User services normally follow the login session. Use an always-on host or configure user lingering if you want them to survive logout. Stop any manually launched server before starting the service: one process owns a project. The default API remains bound to loopback. The example does not install or enable a service automatically.
