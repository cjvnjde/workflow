# Development

[Documentation](README.md) → Development

## Local setup

From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run dev
```

The development script starts the live API, waits for readiness, then starts Vite at **http://127.0.0.1:5173**. The backend uses **4310** and the checkout's `.workflow/` configuration. `bun run dev:live` is a compatibility alias. Both `dev` and `start` use real AI when tasks request it; they do not silently substitute demo responses.

Use `bun run workflow --help` for the source CLI. `bun run start` serves the built distribution. Rebuild after changing the tool when using a `bun link` installation, since the linked command runs `dist/cli.js`.

Do not run competing servers against the same project. Use disposable project directories for integration checks.

## Application structure

The frontend is Vue 3 with TypeScript `<script setup>`, typed props/events, and composables for state and lifecycle management. Vue Flow renders graphs; CodeMirror provides source editing; Prettier formats authored code. The palette is Catppuccin Mocha.

The backend, CLI, SDK, and scripts are TypeScript on Bun. `node:*` imports use Bun's compatible APIs rather than requiring a separate Node process. Temporal's workflow bundle executes in its replayable environment; host effects belong in activities.

See [Architecture](architecture.md#source-map) for the source map and execution boundaries.

## Build and typechecking

```sh
bun run typecheck
bun run build
bun run build:engine  # backend artifacts, without invoking Vite
bun run build:web     # GUI assets only
```

Typechecking includes Vue scripts, templates, and component props through the Vue language engine. `scripts/typecheck.ts` integrates it directly for Bun. A regression test verifies that script, template, and prop errors fail.

The build typechecks, removes stale `dist` output, runs Vite, emits SDK declarations, bundles the public SDK and program runtime, bundles current and frozen legacy Temporal workflows, and builds the executable CLI.

Main outputs:

| Output | Purpose |
| --- | --- |
| `dist/application.js` and declarations | Embeddable application and lifecycle. |
| `dist/http-server.js` and declarations | Optional HTTP adapter. |
| `dist/client.js`, `dist/contracts.js` and declarations | Portable client and public data contracts. |
| `dist/cli.js` | Executable Bun CLI. |
| `dist/tui.js` | Lazily loaded OpenTUI terminal workspace. |
| `dist/tool-worker.js` | Bounded worker for frozen shared-tool implementations. |
| `dist/web/` | Browser UI and assets. |
| `dist/workflow-sdk.js` and declaration files | SDK used to compile authored workflows/blocks. |
| `dist/program-runtime.js` | Runtime included in compiled user workflow versions. |
| `dist/workflow-bundle.js` | Current engine workflow bundle. |
| `dist/workflow-v1-bundle.js` | Frozen compatibility bundle. |

Do not rebuild or remove `dist` while tests or live runs are loading it. Build once, then run checks against that stable distribution. Runtime dependencies remain beside the CLI; the package is not a standalone native binary.

## Automated checks

```sh
bun run test                 # build, then backend and integration tests
bun run typecheck            # TS and Vue checks without rebuilding dist

# After a build, run a focused suite without rebuilding:
bun test --timeout 30000 tests/composition.test.ts
```

Tests use disposable projects. They cover SDK behavior, API validation, approval, commands/files, parallel execution, spending, worker loss, restart/recovery, CLI packaging, and terminal setup. Model integration fixtures use local fake providers or mocks; ordinary test suites do not need paid model credentials. Engine tests use real local Temporal services.

The terminal tests render through OpenTUI's native test renderer and exercise typing, command completion, graph layout, resizing, and masked secret input. Controller tests use the real HTTP adapter, and a Bun pseudo-terminal test runs the packaged `tui` command through planning, approval, execution, and clean shutdown. Run them after building with `bun test --timeout 45000 tests/tui*.test.ts`. Markdown parser caches and credentials use isolated test directories. Source development uses `bun run workflow tui`.

For browser checks:

```sh
bunx --bun playwright install chromium
bun run test:e2e

# Or use an installed Chromium executable:
WORKFLOW_CHROMIUM_PATH=/usr/bin/chromium bun run test:e2e

# Focused browser check after a build:
WORKFLOW_CHROMIUM_PATH=/usr/bin/chromium bun --bun run playwright test tests/e2e/composition.e2e.ts
```

Browser tests run headlessly against an isolated fixture server on port 4311. Keep that port free. They cover graph previews, editing, active states, parallel streams, results, settings, and responsive controls.

The pinned Temporal SDK may print `v8.promiseHooks.createHook is not available` on Bun. Workflow stack-trace collection is unavailable there; the execution and replay tests still exercise real Temporal behavior.

## Real-model smoke tests

`bun run test:live` explicitly uses the existing Workflow ChatGPT sign-in and consumes subscription/model usage. It creates a temporary project and a local bare Git remote, keeps Chromium headless, and prints the report/screenshot directory. It does not ask the model to implement changes in this checkout.

```sh
WORKFLOW_CHROMIUM_PATH=/usr/bin/chromium bun run test:live

# Select one scenario:
WORKFLOW_LIVE_SCENARIO=composition WORKFLOW_CHROMIUM_PATH=/usr/bin/chromium bun run test:live
```

| Scenario | Check |
| --- | --- |
| `all` (default) | Review with no commits, settings design, screenshot-driven implementation, tests/review, commit/push, results, parallel composition, and automatic mode. |
| `publication` | Screenshot request through implementation, verification, commit, and push to the fixture remote. |
| `composition` | Concurrent real AI calls, model overrides, typed joins, loop conditions, and a conditional result. |
| `automatic` | Planning and execution without an approval click. |
| `cancellation` | Stop planning and an active command, retain cancellation after reload, then run another task. |
| `blocks` | AI-designed TypeScript block applied through Settings and executed without an AI call. |

`WORKFLOW_LIVE_MODEL` overrides the smoke-test model (currently defaulting to `gpt-6-luna`). The selected model must be available through the connected catalog. Use these opt-in checks when testing provider-dependent behavior; they are not required for prose-only edits.

## Packaging

`bun.lock` is authoritative. Link a development checkout with `bun link`, or produce a package:

```sh
bun pm pack
# Install the resulting archive:
bun add --global --ignore-scripts ./predictable-workflow-0.1.0.tgz
```

`pack` runs the prepare build unless scripts are disabled. After a separate successful build, `bun pm pack --ignore-scripts` can package that output without rebuilding it.

The package includes `dist/`, examples, README, and docs. It excludes this project's `.workflow/` state, source, and tests. Distribution still requires Bun and packaged runtime dependencies. The repository is not documented as an already-published registry package.

## Keeping documentation useful

Keep the root README focused on purpose, first use, and entry points. Put behavior/reference details in the relevant guide and link to them. Current capabilities belong in these guides; unimplemented possibilities should be clearly identified rather than mixed into setup instructions.

When changing the SDK or runtime, update the examples and describe any difference between declared composition and compatibility formats. Check commands against `src/cli.ts`, API bodies against the server/schemas, and defaults against their schemas. Typecheck complete TypeScript examples against the built SDK, validate local links and code-fence syntax, and check that packaged docs are included when changing the package manifest.

Tests and live runs can produce private project data under `.workflow/`. Keep local settings and generated execution history out of unrelated commits. Preserve old execution bundles and compatibility contracts when changing the engine.
