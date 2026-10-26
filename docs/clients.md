# Engine and clients

[Documentation](README.md) → Engine and clients

Workflow has one application layer and several ways to use it. The application owns task planning, configuration, attachments, provider sessions, execution, and persistence. Presentation code chooses how to display and control that state.

```mermaid
flowchart LR
  Terminal[OpenTUI workspace / terminal commands] --> Client[WorkflowClient]
  Web[Vue web GUI] --> Client
  Native[Future desktop / mobile GUI] --> Client
  Client --> HTTP[HTTP adapter + SSE]
  HTTP --> App[WorkflowApplication]
  Direct[Embedded host / workflow exec] --> App
  App --> Engine[WorkflowEngine]
  Engine --> Temporal[Temporal + host activities]
```

The web GUI and [OpenTUI terminal workspace](terminal.md) use these boundaries today. Desktop and mobile GUIs can be built against the same interfaces.

`workflow tui` opens the interactive terminal workspace and attaches to the project's existing server when available, otherwise starting its own engine. Use `workflow tui --server URL` to select a remote engine. The terminal guide explains ownership, session controls, approval, and login.

## Run without a GUI

From an initialized project:

```sh
# Executes the file, waits, prints its final state, and shuts down the worker.
workflow exec verify.ts

# JSON result for scripts; input is passed to the authored workflow.
workflow exec verify.ts --input '{"request":"Check the project"}' --json
```

`exec` explicitly authorizes execution of the supplied workflow. It starts the application and Temporal worker without an HTTP listener or web assets. Completed results remain in `.workflow/`. Do not run it alongside another engine owning that project; the existing project lease prevents that.

Exit codes for `exec`, `watch`, and `--wait`: **0** completed, **1** failed/cancelled or a command error, **2** draft/paused/interrupted and needs attention. Interrupting `exec` shuts down its worker; it does not discard history. Start `workflow serve --no-web`, inspect the run, and explicitly resume or cancel it. Interrupting `watch` only stops the client; the server keeps running.

## Keep the engine running

```sh
# Long-lived API and worker, with no web assets or GUI routes.
workflow serve --no-web

# In another terminal:
workflow run verify.ts
workflow runs
workflow show <run-id>
workflow approve <run-id> --wait
workflow events <run-id>
workflow pause <run-id>
workflow resume <run-id> --wait

# Request-driven planning also works from the terminal:
workflow task "Review the project and report actionable findings"
workflow tasks
workflow task-show <task-id>
workflow answer <task-id> "Answer to the planner's question"
```

Task planning uses the project's approval setting, just like the web GUI. `task-show` exposes the linked run ID, planning failures, and any question. Inspect a review-mode draft with `show` and start it with `approve`. CLI control commands accept `--json` for machine-readable responses. `workflow run verify.ts --approve --wait` combines import, explicit approval, and waiting.

Running `workflow serve` without `--no-web` adds the bundled web GUI to the same API. The HTTP routes, revisions, concurrency guards, and event format are shared in both modes.

## A server on another machine

Run `workflow serve --no-web` in the project on that machine. The API remains loopback-only and single-user. A terminal client can select an explicit endpoint, for example through an SSH tunnel:

```sh
ssh -L 4312:127.0.0.1:4310 your-server
workflow runs --server http://127.0.0.1:4312
workflow tui --server http://127.0.0.1:4312
workflow show <run-id> --server http://127.0.0.1:4312
```

`--server` deliberately selects the endpoint's project; it skips the usual check that the server project matches the client's current directory. `run` still reads its source from the client's current project. Relative module imports are resolved on the engine machine, so referenced files must exist there too.

There is no public multi-user authentication or CORS configuration in this refactor. Keep the API on loopback, or place a deployment-specific authenticated proxy in front of it. A browser deployment should serve the GUI and proxy `/api/` on the same origin; the proxy must preserve the engine's host/origin guards. The GUI's optional `VITE_WORKFLOW_API_URL` build setting supports an API proxy prefix and is used for requests, event streams, and attachment links. An arbitrary cross-origin URL alone does not enable CORS.

## Embed the application

The installed package exports `predictable-workflow/engine`, `/http`, `/client`, and `/contracts`, in addition to the authoring SDK at `/workflow`.

```ts
import { createApplication } from "predictable-workflow/engine";
import { waitForRun } from "predictable-workflow/client";

const app = await createApplication({ project: process.cwd() });
try {
  const draft = await app.createProgram({
    title: "Verify", task: "Run the checks", filename: "verify.ts",
    source: await Bun.file("verify.ts").text(), input: {},
  });
  const unsubscribe = app.subscribe(event => console.log(event.kind, event.message));
  try {
    await app.approve(draft.id, draft.revision);
    console.log(await waitForRun(() => app.getRun(draft.id)));
  } finally { unsubscribe(); }
} finally { await app.close(); }
```

Initialize project configuration first with `workflow init`. `createApplication` takes optional model/planner service overrides, a block runner, execution mode, and Temporal options. It owns the project lease and cleans up failed startup. `close()` is idempotent, aborts and drains coordinator work, closes task/design services, and shuts down the engine. Subscribe once per presentation and unsubscribe when it closes. Events are live hints; read runs/tasks and persisted events for authoritative state.

Run events reach subscribers after their event-log write succeeds. Streamed `text_delta` events remain ephemeral but keep their order relative to saved run events; coordinator notifications remain live hints. Event reads, mutations that flush events, and shutdown also drain queued run notifications. Each subscriber receives its own event copy. A subscriber that throws or rejects is logged without failing execution or preventing delivery to other subscribers; the engine does not wait for asynchronous subscriber work.

An embedded host may attach HTTP separately:

```ts
import { createHttpServer } from "predictable-workflow/http";

const http = await createHttpServer(app, 4310);
await http.listen({ port: 4310, host: "127.0.0.1" });
// Later: stop requests/events without shutting down the application.
await http.close();
```

The host still owns `app.close()`. The old source-level `createServer(engine)` convenience entry point retains its original behavior: it attaches the application, API, and GUI and closes the engine with the server.

## Build another presentation

```ts
import { WorkflowClient } from "predictable-workflow/client";

const client = new WorkflowClient({ baseUrl: "http://127.0.0.1:4310" });
const runs = await client.runs();
const subscription = client.subscribe(event => console.log(event), {
  onOpen: () => { void client.runs().then(console.log); },
});
// On teardown:
subscription.close();
await subscription.done;
```

`WorkflowClient` uses Fetch, readable streams, and AbortSignal, with no Vue, DOM, Node, or Temporal dependency. Native runtimes without Fetch streaming can provide a compatible `fetch` implementation or poll the HTTP API. It shares response validation, errors, revision headers, and SSE reconnect behavior. `request(route, schema, options)` covers the rest of the API, including settings, authentication, and design conversations. `headers` can carry deployment-specific proxy credentials. Do not put credentials in URLs.

Import types and validation schemas from `/contracts`, not application internals. `stream()` exposes one event connection as an async iterator; `subscribe()` reconnects automatically. Reload persisted state in `onOpen` because the stream does not replay missed events. `waitForRun()` works with both an embedded application and an HTTP client.

Structured tool events include `event.operation` with call and parent IDs, lifecycle state, typed evidence and duration. Render these fields directly; older events retain their text format. Embedded hosts can supply a shared-tool execution environment through `createApplication({ environment })`. See [shared tools](tools.md) for the contract and recovery limits.

## Build separately

```sh
bun run build:engine   # CLI/TUI, application, HTTP/client/contracts, SDK and Temporal bundles
bun run build:web      # only dist/web; leaves engine artifacts alone
bun run build          # full build, including typechecking
```

An engine-only build does not invoke Vite and preserves existing `dist/web` if present. Typechecking still checks the whole repository. Engine runtime artifacts do not import a GUI; the CLI loads the native OpenTUI renderer only for `tui`. The repository's single package still lists presentation dependencies, so this is not yet a separately published minimal backend package.
