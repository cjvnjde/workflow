# Development

[Documentation](README.md) → Development

## Local setup

Install Node.js **24 LTS** (recommended) or **26+**, plus Bun **1.4.2+** for the application runtime. Keep Node's `node` and `npm` on `PATH` even when using Bun to install dependencies and run package scripts.

From the repository root:

```sh
bun install
bun run build
bun run workflow init
bun run workflow
```

Run `bun run workflow init` once per checkout to create local `.workflow/` configuration; Git ignores this directory. `bun run workflow` opens the terminal workspace and starts a source host with the hot-reloading web app on the same port as the API (**4310** by default). Use `/web` in the terminal for its browser link, or `bun run workflow --web` to open the browser directly. These commands use real AI when tasks request it; they do not silently substitute demo responses.

### Web hot reload

Source hosts embed Vite's development middleware and HMR WebSocket in the existing HTTP server. The browser, `/api/` routes, and hot reload all use **http://127.0.0.1:4310**, or the port selected with `--port`. No second server, proxy, or frontend command is required.

While editing `web/`, Vite updates CSS in place and React Fast Refresh preserves local state for compatible component edits. Changes outside a Fast Refresh boundary may reload the page. `--no-web` skips Vite entirely. The host closes Vite and its watchers when stopped.

`bun run dev` invokes the source CLI with `--web`. `bun run start` and installed executables serve built production assets without Vite or hot reload. Backend source changes still require a backend restart; an automatic watcher must not compete with the stateful host's project lease.

Use `bun run workflow --help` for the source CLI. `bun run start` serves the built distribution. Run `bun run compile` to rebuild a portable executable after changing the tool, then replace your installed copy.

An existing background host keeps the code it started with. If a host was already running before these changes, use `bun run workflow stop`, then `bun run workflow` to start the source host with HMR. Reusing a built host does not turn it into a development host. After rebuilding or upgrading an installed executable, use `workflow stop` and `workflow start --background` when ready to restart it; saved tasks remain available. Refresh the browser after the host restarts.

Do not run competing servers against the same project. Use disposable project directories for integration checks.

### Tooling and runtime boundaries

Bun remains the preferred package manager; `bun.lock` is the canonical dependency lock. Ordinary tool commands are runtime-neutral package scripts, not Bun shell or build APIs:

| Task                                        | Command                                              | Runtime                                |
| ------------------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| Frontend development / HMR                  | `npm run dev:web`                                    | Node + Vite                            |
| Typecheck                                   | `npm run typecheck`                                  | TypeScript CLI                         |
| Build all artifacts / backend only          | `npm run build` / `npm run build:engine`             | Node + tsx + Vite/Rolldown             |
| Portable unit tests / watch mode            | `npm run test:unit` / `npm run test:watch`           | Node + Vitest                          |
| Lint / format                               | `npm run lint` / `npm run format:check`              | Node + ESLint/Prettier                 |
| Browser journeys                            | `npm run test:e2e:run`                               | Node + Playwright; Bun fixture backend |
| Integrated development host                 | `bun run dev`                                        | Bun + embedded Vite HMR                |
| Runtime approval tests / all runtime suites | `bun run test:runtime:unit` / `bun run test:runtime` | Bun + Vitest                           |
| Full test suite, without rebuilding         | `bun run test:run`                                   | Bun + Vitest, all three projects       |
| Standalone executable compilation           | `bun run compile`                                    | Node build, then Bun compiler          |

The Node tooling commands also work through `bun run`; the tool CLIs use Node rather than `bun --bun`. Builds do not require Bun's bundler. Portable tests do not load the backend. The backend, CLI, OpenTUI renderer, real runtime tests, live-model/screenshot helpers, and standalone compiler still require Bun. Remaining runtime dependencies include `bun:sqlite`, `bun:ffi`, `Bun.Transpiler`, `Bun.build` for authored workflow compilation, and Bun archive/process APIs. Running `node dist/cli.js` is **not supported**; this is a tooling separation, not a completed runtime migration.

For an npm-installed tooling checkout instead of Bun's isolated install:

```sh
npm install --prefix tooling/eslint --package-lock=false
npm install --install-links=false --package-lock=false
npm run typecheck
npm run test:unit
npm run build
```

Install the local lint package separately and retain its file link: it must resolve TypeScript 6 from its own `node_modules`, while the application resolves TypeScript 7. Do not use a fully nested root install: duplicate Temporal protobuf packages share a process-global registry and cannot coexist. Do not use `--force` or `--legacy-peer-deps`. npm resolves manifest ranges rather than `bun.lock`; use `bun install --frozen-lockfile` for reproducible repository/CI installs, and do not maintain a second lockfile.

### Separate Node frontend

`npm run dev:web` starts Vite at **http://127.0.0.1:5173** independently of Bun. Start the backend separately, for example `bun run workflow serve --no-web`, after initializing the project and building its Temporal bundles. Vite proxies `/api` requests, mutations, and SSE streams to **http://127.0.0.1:4310**. To use another backend:

```sh
WORKFLOW_API_URL=http://127.0.0.1:4320 npm run dev:web
```

This environment variable belongs to the dev server, not browser assets. The frontend binds to loopback and fails if port 5173 is occupied. Same-origin proxy requests are translated to the backend origin; foreign origins remain subject to backend rejection. React Fast Refresh and CSS HMR work in this mode as well as the integrated host. No backend or fake data is automatically started when the API is unavailable.

## Application structure

The browser UI uses React 19 and [TanStack Start SPA mode](https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode), with TanStack Router owning typed URL search state and navigation guards. Canonical session links use `?task=<id>` or `?run=<id>`; settings use `?view=settings`. Existing hash links are converted on entry. Fastify owns the API; source hosts embed Vite for the web app, while built hosts serve the generated static shell.

TanStack Query owns project, run, task, setup, and usage caches, request cancellation, polling, and SSE-driven invalidation. Revision-aware merging prevents stale responses from overwriting newer mutations. Streaming text and UI state remain local. TanStack Form owns data-entry state and submission lifecycles; TanStack Table v9 renders model usage and execution evidence. Query already covers the server-state requirements, so there is no additional TanStack DB store.

Tailwind CSS 4 and shadcn/ui use the [recommended CSS-variable theming](https://ui.shadcn.com/docs/theming): one `:root`/`.dark` token set, `@theme inline` mappings, and `components.json` with `cssVariables: true`. Workspace layout CSS consumes those tokens without a second palette, scoped theme islands, or hard overrides of shadcn controls. React Flow and CodeMirror use the same semantic tokens.

React Compiler runs through Vite's Babel compiler preset for React 19 in development and production. ESLint enables the official Hooks/Compiler rules, React component rules, and Vite Fast Refresh checks. Do not bypass these checks with compiler opt-outs or blanket rule disables.

Composer validation errors wrap within the available width, including long filenames and multiline diagnostics. Editors use React `useId` for document-unique identities.

The backend, CLI, and SDK runtime remain TypeScript on Bun. Development/build tooling uses Node-compatible APIs and standard tool CLIs. Temporal's workflow bundle executes in its replayable environment; host effects belong in activities.

See [Architecture](architecture.md#source-map) for the source map and execution boundaries.

Provider-owned OAuth callback pages retain the upstream library's presentation; Workflow does not patch their branding or theme.

Security overrides in `package.json` keep `glob`, `minimatch`, `qs`, and `undici` on patched releases while upstream dependencies still constrain vulnerable versions. The portable runtime copies these overrides. Run `bun audit` after dependency changes; remove an override only when the resolved upstream tree remains patched without it.

The current shadcn CLI brings the development-only `deepmerge` 4.3.1 advisory [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) (low severity). No patched `deepmerge` release is available. It is not part of the production runtime; use trusted registries and track an upstream fix rather than substituting an incompatible merge implementation.

## Build and typechecking

```sh
bun run typecheck
bun run build
bun run build:engine  # backend artifacts, without invoking Vite
bun run build:web     # GUI assets only
```

The application pins TypeScript 7.0.2 for browser/backend checking, SDK declarations, runtime workflow diagnostics, and ownership analysis. Runtime analysis uses TypeScript's asynchronous native API because its synchronous pipe transport requires Node internals unavailable in Bun. Validation remains non-evaluating, including imported-module safety checks and unused-flow diagnostics.

The lint toolchain is an explicit exception: current `typescript-eslint` and React lint utilities require the legacy compiler API. `tooling/eslint` isolates their TypeScript 6.0.3 dependency; `bunfig.toml` enables isolated installs so it cannot replace the application's TypeScript 7. No application code imports the legacy compiler. See [Microsoft's compatibility guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60). Preserve this dependency boundary until the lint libraries support the native API.

The Node/tsx build typechecks with the standard TypeScript CLI, removes stale `dist` output, builds the Start client and temporary server renderer with Vite, prerenders `dist/web/index.html`, emits SDK declarations, bundles public modules and the program runtime with Rolldown (the bundler used by Vite 8), bundles current and frozen legacy Temporal workflows, and builds the executable Bun CLI. Server dependencies remain external and flat bundle paths remain stable. The build-only renderer stays in ignored `.tanstack/start-server`; production serves static assets without a second web server.

Main outputs:

| Output                                                                      | Purpose                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `dist/core.js`, `dist/web.js`, `dist/terminal.js` and matching declarations | Public execution, web-host, and terminal module entries. |
| `dist/application.js` and declarations                                      | Embeddable application and lifecycle.                    |
| `dist/http-server.js` and declarations                                      | Optional HTTP adapter.                                   |
| `dist/client.js`, `dist/contracts.js` and declarations                      | Portable client and public data contracts.               |
| `dist/cli.js`                                                               | Executable Bun CLI.                                      |
| `dist/tui.js`                                                               | Lazily loaded OpenTUI terminal workspace.                |
| `dist/tool-worker.js`                                                       | Bounded worker for frozen shared-tool implementations.   |
| `dist/web/`                                                                 | Browser UI and assets.                                   |
| `dist/workflow-sdk.js` and declaration files                                | SDK used to compile authored workflows/blocks.           |
| `dist/program-runtime.js`                                                   | Runtime included in compiled user workflow versions.     |
| `dist/workflow-bundle.js`                                                   | Current engine workflow bundle.                          |
| `dist/workflow-v1-bundle.js`                                                | Frozen compatibility bundle.                             |

Do not rebuild or remove `dist` while tests or live runs are loading it. Build once, then run checks against that stable distribution. Runtime dependencies remain beside the CLI; the package is not a standalone native binary.

## Automated checks

```sh
bun run test:unit             # portable Node/Vitest tests; no build or services
bun run test:watch            # watch portable tests while editing
bun run test:runtime:unit     # Bun-only approval boundary tests; no build or services
bun run test                 # Node build, then all Vitest projects on Bun
bun run typecheck            # native TypeScript 7 and React TSX checks without rebuilding dist

# After a build, run a focused suite without rebuilding:
bun run test:run tests/composition.test.ts
```

Vitest owns unit and integration tests in `tests/*.test.ts`; `@playwright/test` owns browser journeys and screenshot visual tests. The `unit` project runs on Node and supports watch mode. The build-free `runtime-unit` project retains engine approval tests that import Bun-native dependencies; `integration` covers the remaining runtime suites. `test:run` selects all three projects under Bun, while `test:runtime` selects only the two Bun-required projects. Their launcher invokes Vitest's entry point directly with Bun: `bun --bun` would shadow `node` on `PATH` and break fixtures that deliberately exercise Node.js. All build-free run commands accept file filters and Vitest options, for example `bun run test:unit tests/budget.test.ts --bail 1` or `bun run test:run tests/engine-approval.test.ts`. Use these package scripts, not `bun test`, which invokes Bun's separate test runner.

Tests use disposable projects. They cover SDK behavior, API validation, approval, commands/files, parallel execution, spending, worker loss, restart/recovery, CLI packaging, and terminal setup. Model integration fixtures use local fake providers or mocks; ordinary test suites do not need paid model credentials. Engine tests use real local Temporal services.

Regular CI runs portable unit tests on Node 24 and 26 and build-free Bun approval suites on pushes to `main`, every pull request, and manual dispatch. A separate Node 24 job installs with npm, lints, builds/typechecks, and runs portable tests without setting up Bun. Projects in `vitest.config.ts` keep portable and Bun-native suites separate without dropping approval coverage. The Bun-installed jobs use the canonical lockfile; the npm-only job exercises the alternate manifest-based install. Superseded runs are cancelled. Full integration, browser and mutation suites remain explicit local commands.

The terminal tests render through OpenTUI's native test renderer and exercise typing, command completion, graph layout, resizing, and masked secret input. Controller tests use the real HTTP adapter, and a Bun pseudo-terminal test runs the packaged `tui` command through planning, approval, execution, and clean shutdown. Run them after building with `bun run test:run tests/tui --testTimeout 45000`. Markdown parser caches and credentials use isolated test directories. Source development uses `bun run workflow tui`.

For browser checks:

```sh
bun run test:browser:install  # install Playwright's Chromium
bun run test:e2e             # build + all Playwright journeys and visual tests
bun run test:visual          # build + screenshot tests tagged @visual
bun run test:visual:update   # build + deliberately regenerate visual baselines

# Or use an installed Chromium executable:
WORKFLOW_CHROMIUM_PATH=/usr/bin/chromium bun run test:e2e

# Focused browser journey after a build, without rebuilding:
bun run test:e2e:run tests/e2e/composition.e2e.ts
```

Native Playwright Test runs on Node.js and owns browser fixtures, assertions, and journeys. Visual tests are tagged `@visual` and compare the real application UI using Playwright's `toHaveScreenshot`. Review and commit the macOS/Chromium golden baselines when deliberately updating visuals. Compare and regenerate them on macOS with the same Chromium revision; rendering can differ across platforms. `test:e2e:run` accepts file filters and Playwright options, for example `bun run test:e2e:run --grep @visual`; unlike `test:e2e`, it does not rebuild.

Browser tests run headlessly against an isolated fixture backend started with `bun tests/e2e/server.ts` on port 4311. Keep that port free. Journeys cover graph previews, editing, active states, parallel streams, results, settings, and responsive controls. They honor `WORKFLOW_CHROMIUM_PATH`; otherwise they use Playwright's installed Chromium.

For executable packaging checks, `bun run test:standalone` compiles and then tests the standalone executable. After compilation, `bun run test:standalone:run` tests the built executable without rebuilding; release CI uses this build-free command.

The pinned Temporal SDK may print `v8.promiseHooks.createHook is not available` on Bun. Workflow stack-trace collection is unavailable there; the execution and replay tests still exercise real Temporal behavior.

## Mutation testing

Stryker runs its coordinator on Node; its command runner explicitly selects portable and Bun-native Vitest projects under Bun for focused mutation tests. See the [Stryker configuration reference](https://stryker-mutator.io/docs/stryker-js/configuration/).

The current Stryker 10.1.1 coordinator still expects the legacy TypeScript compiler API (`parseConfigFileTextToJson`), which TypeScript 7 no longer exports. Mutation startup is blocked by that incompatibility before Vitest runs; it needs an upstream-compatible coordinator. The normal Vitest runtime and Playwright browser commands do not use that API.

```sh
bun run test:mutation        # focused budget, approval and usage mutations; fast tests only
bun run test:mutation:dry    # run the focused baseline once; no active mutants
bun run test:mutation:smoke  # smaller approval/usage scope with a 100% score gate
bun run test:mutation:full   # explicit whole-repository sweep; potentially days
```

The default configuration mutates budget calculation, snapshot/activity approval guards and usage display functions. It runs only their source-level tests, with no build or local services. Two independent runners execute mutants in parallel. Vitest receives `--bail 1` so the first failing assertion kills the mutant without waiting for unrelated tests. This is a focused mutation score for the listed source ranges.

The command runner cannot select tests by coverage, so `coverageAnalysis` is off and every mutant runs the entire configured test command. It reports that command as one aggregate test: `Ran 1 tests` is not the number of Vitest test cases, and `3/N Mutants tested` means three mutated versions completed. Select matching source and tests together when adding mutation targets. All mutation testing remains opt-in and separate from `check` and CI. Both the default and smoke runs require a 100% mutation score for their focused scopes.

Two equivalent budget mutants have line-specific Stryker comments with reasons: a string in the fallback tier array never matches a numeric threshold, and changing the default mode to another non-demo value still takes the live path. They stay visible as ignored in reports. Tests cover missing block definitions, absent/empty tiers, pricing boundaries, snapshot immutability and default live behavior. Mutants that decrement the visit counter or remove the loop body produce infinite loops; their bounded process timeouts count as detected mutations.

`test:mutation:full` uses `stryker.full.config.mjs` to mutate TypeScript across `src/` and `web/`, excluding declarations and frozen legacy sources. It builds the instrumented distribution once inside Stryker's sandbox, then runs the backend/integration suite for each mutant with one runner. With tens of thousands of mutants and a roughly nine-minute baseline, this can take days even with early exit on failures. Its baseline limit is 20 minutes. Browser journeys are outside this scope. Local `.workflow/` state and existing build output are excluded from every sandbox.

HTML and JSON reports go to `reports/mutation/`, full-sweep reports to `reports/mutation/full/`, and smoke reports to `reports/mutation-smoke/`. Reports and `.stryker-tmp/` are ignored by Git, ESLint, and Prettier. The smoke configuration inherits the default configuration and narrows mutation to usage arithmetic/formatting and the engine's snapshot/activity approval guards. Keep source line ranges aligned when those functions move.

To narrow the default run to budget calculation while retaining its quick test command:

```sh
bun run test:mutation --mutate src/core/execution/budget.ts
```

## UI screenshots

The README execution screenshots use deterministic demonstration records rendered by the built browser UI. Regenerate them after building, with port 4311 free:

```sh
WORKFLOW_CHROMIUM_PATH=/usr/bin/chromium bun scripts/capture-execution.ts
```

The script starts an isolated fixture server, opens the expanded timeline and grouped calls, and saves `docs/screenshots/execution-timeline.png` and `docs/screenshots/tool-calls.png`. It creates a disposable demo workflow and supplies recorded-history fixtures for repeatable timings and captured file contents; it makes no model requests. It closes the browser and fixture server afterward. Omit `WORKFLOW_CHROMIUM_PATH` when Playwright's bundled Chromium is installed.

To capture the terminal renderer connected to a running task or run:

```sh
WORKFLOW_CHROMIUM_PATH=/usr/bin/chromium bun run screenshot:terminal \
  --server http://127.0.0.1:4310 --session <task-or-run-id> \
  --output docs/screenshots/terminal-workspace.png
```

The script loads real state through `WorkflowClient`, renders the native OpenTUI cells, and rasterizes their captured colors and text. It does not invent a terminal layout. Real PTY attach/input/cleanup behavior is covered separately by the terminal integration tests. Omit `WORKFLOW_CHROMIUM_PATH` when Playwright's bundled Chromium is installed.

## Real-model smoke tests

`bun run test:live` explicitly uses the existing Workflow ChatGPT sign-in and consumes subscription/model usage. It creates a temporary project and a local bare Git remote, keeps Chromium headless, and prints the report/screenshot directory. It does not ask the model to implement changes in this checkout.

```sh
WORKFLOW_CHROMIUM_PATH=/usr/bin/chromium bun run test:live

# Select one scenario:
WORKFLOW_LIVE_SCENARIO=composition WORKFLOW_CHROMIUM_PATH=/usr/bin/chromium bun run test:live
```

| Scenario        | Check                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all` (default) | Review with no commits, settings design, screenshot-driven implementation, tests/review, commit/push, results, parallel composition, and automatic mode. |
| `publication`   | Screenshot request through implementation, verification, commit, and push to the fixture remote.                                                         |
| `composition`   | Concurrent real AI calls, model overrides, typed joins, loop conditions, and a conditional result.                                                       |
| `automatic`     | Planning and execution without an approval click.                                                                                                        |
| `cancellation`  | Stop planning and an active command, retain cancellation after reload, then run another task.                                                            |
| `blocks`        | AI-designed TypeScript block applied through Settings and executed without an AI call.                                                                   |

`WORKFLOW_LIVE_MODEL` overrides the smoke-test model (currently defaulting to `gpt-6-luna`). The selected model must be available through the connected catalog. Use these opt-in checks when testing provider-dependent behavior; they are not required for prose-only edits.

## Packaging

Build a portable executable for the current OS and architecture:

```sh
bun install
bun run compile
mkdir -p ~/.local/bin
mv dist/workflow ~/.local/bin/workflow
```

`compile` runs the normal build, stages production dependencies using the committed lockfile, and embeds the runtime archive in a minified Bun executable. This preserves file paths used by Temporal's compiler, native libraries, and workers. On first launch, it publishes the runtime to `cache/runtime/<build-hash>/` under the Workflow user directory; concurrent invocations reuse a complete published runtime. Child hosts and Bun scripts use the executable's embedded Bun interpreter. No checkout or separate Bun/Node.js installation is needed at runtime.

Run `bun run test:standalone` to build and test the executable after moving it into a disposable directory, with no Bun or Node.js on PATH. The checks cover initialization, background host startup, UI assets, workflow compilation, shared tool workers, the embedded interpreter, and execution. `tests/setup-cli.test.ts` covers default setup waiting and detachment.

For SDK consumers, `bun pm pack` still produces a package containing `dist/`, examples, README, and docs; its `prepack` hook builds the distribution. It excludes this project's `.workflow/` state, source, and tests. This package format requires Bun and its runtime dependencies. The repository is not documented as an already-published registry package.

## Releases

Push a tag beginning with `v` to create a GitHub Release automatically. Commit the release workflow and your changes before tagging the commit you want to publish:

```sh
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

Tags with a prerelease suffix, such as `v0.0.1-alpha.1`, create a GitHub prerelease and are not marked as the latest stable release.

[The release workflow](../.github/workflows/release.yml) checks lint, formatting, quick unit tests, and the build. It then compiles executables on native Linux and macOS runners for both x64 and ARM64 and tests each executable after relocation. Native builds include the matching runtime dependencies; the current release matrix covers the platforms supported by the managed Temporal server.

After every build and executable test passes, the workflow publishes generated release notes and four archives, each containing a single `workflow` executable:

- `workflow-linux-x64.tar.gz`
- `workflow-linux-arm64.tar.gz`
- `workflow-macos-x64.tar.gz`
- `workflow-macos-arm64.tar.gz`

Each archive has a companion `.sha256` checksum file. Download the archive for your OS and architecture from [GitHub Releases](https://github.com/cjvnjde/workflow/releases), extract it, and move `workflow` to a folder on PATH. Bun and the source checkout are not required. If a release job is rerun, it updates the assets on the existing release for that tag. Only the publication job has repository write permission; it uses GitHub's built-in token, with no additional secret to configure.

## Keeping documentation useful

Keep the root README focused on purpose, first use, and entry points. Put behavior/reference details in the relevant guide and link to them. Current capabilities belong in these guides; unimplemented possibilities should be clearly identified rather than mixed into setup instructions.

When changing the SDK or runtime, update the examples and describe any difference between declared composition and compatibility formats. Check commands against `src/cli/index.ts`, API bodies against the server/schemas, and defaults against their schemas. Typecheck complete TypeScript examples against the built SDK, validate local links and code-fence syntax, and check that packaged docs are included when changing the package manifest.

Tests and live runs can produce private project data under `.workflow/`. Keep local settings and generated execution history out of unrelated commits. Preserve old execution bundles and compatibility contracts when changing the engine.

The installed CLI and `bun run start` default to a detached host. Use `bun run start serve` for a foreground built host; `bun run dev` already runs its backend in the foreground. Lifecycle tests exercise detached processes and explicitly stop their hosts during cleanup.

## Code quality

Run `bun run check` before submitting changes. It runs ESLint with zero warnings, checks Prettier formatting, typechecks TypeScript and React TSX, builds the distributable artifacts, and runs the unit and integration tests. CI runs only the quick unit suite (`bun run test:unit`). Run visual regression tests (`bun run test:visual`), all browser tests (`bun run test:e2e`), and mutation checks (`bun run test:mutation:smoke`) explicitly when needed.

Use `bun run lint:fix` for safe lint fixes and `bun run format` to format supported repository files. `bun run format:web` limits formatting to the browser application. ESLint uses its flat config with recommended JavaScript, TypeScript, React, Hooks/Compiler, and Fast Refresh rules; Prettier owns formatting. Prefer type-only imports, `const`, explicit module ownership, and meaningful error causes. Narrow, documented exceptions cover heterogeneous SDK generics, control-character validation and integrity checks during cleanup. Historical workflow sources are excluded from automated lint and formatting rewrites to preserve replay behavior.

`.editorconfig` and `.prettierrc.json` define shared formatting defaults. `.prettierignore` excludes generated files, local workflow state, dependency directories and lockfiles. Add production code to its owning module and import implementations directly; avoid creating compatibility re-export files for old source paths.
