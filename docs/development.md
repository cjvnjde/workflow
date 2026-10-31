# Development

[Documentation](README.md) → Development

## Local setup

From the repository root:

```sh
bun install
bun run build
bun run workflow init
bun run dev
```

Run `bun run workflow init` once per checkout to create local `.workflow/` configuration; Git ignores this directory. The development script starts the live API, waits for readiness, then starts Vite at **http://127.0.0.1:5173**. The backend uses **4310** and that local configuration. `bun run dev:live` is a compatibility alias. Both `dev` and `start` use real AI when tasks request it; they do not silently substitute demo responses.

Use `bun run workflow --help` for the source CLI. `bun run start` serves the built distribution. Run `bun run compile` to rebuild a portable executable after changing the tool, then replace your installed copy.

An existing background host keeps the code it started with. After rebuilding or upgrading, use `workflow stop` and `workflow start --background` when ready to restart it; saved tasks remain available. Refresh the browser after the host restarts.

Do not run competing servers against the same project. Use disposable project directories for integration checks.

## Application structure

The browser entry is React 19. React owns the root and new screens use Tailwind CSS 4 with shadcn/ui components on its default neutral theme. Existing Vue 3 feature screens remain mounted in an isolated compatibility island while they are migrated; they use typed props/events and composables, Vue Flow for graphs, CodeMirror for source editing, and the Catppuccin Mocha palette. Keep the React theme tokens at their shadcn defaults.

The backend, CLI, SDK, and scripts are TypeScript on Bun. `node:*` imports use Bun's compatible APIs rather than requiring a separate Node process. Temporal's workflow bundle executes in its replayable environment; host effects belong in activities.

See [Architecture](architecture.md#source-map) for the source map and execution boundaries.

OAuth callback pages use Workflow's branding and palette through the versioned `pi-ai` patch in `patches/`. Bun reapplies it on install, and the portable build carries it into its runtime. When upgrading `pi-ai`, review and regenerate this patch so provider callback pages keep the project's styling.

## Build and typechecking

```sh
bun run typecheck
bun run build
bun run build:engine  # backend artifacts, without invoking Vite
bun run build:web     # GUI assets only
```

Typechecking covers React TSX and Vue scripts, templates, and component props. `scripts/typecheck.ts` integrates TypeScript with the Vue language engine directly for Bun. A regression test verifies that script, template, and prop errors fail.

The build typechecks, removes stale `dist` output, runs Vite, emits SDK declarations, bundles the public SDK and program runtime, bundles current and frozen legacy Temporal workflows, and builds the executable CLI.

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
bun run test:unit            # quick source-level tests; no build or services
bun run test                 # build, then backend and integration tests
bun run typecheck            # TS, React TSX, and Vue checks without rebuilding dist

# After a build, run a focused suite without rebuilding:
bun test --timeout 30000 tests/composition.test.ts
```

Tests use disposable projects. They cover SDK behavior, API validation, approval, commands/files, parallel execution, spending, worker loss, restart/recovery, CLI packaging, and terminal setup. Model integration fixtures use local fake providers or mocks; ordinary test suites do not need paid model credentials. Engine tests use real local Temporal services.

The regular CI workflow runs `bun run test:unit` on pushes to `main`, every pull request, and manual dispatch. The fast suites are listed in `scripts/test-unit.ts`; they use source imports, in-memory doubles and disposable files without a build, Temporal service, HTTP listener or browser. Keep new CI suites within those limits. Dependencies are installed from `bun.lock` without building the application, and superseded runs are cancelled. Full integration, browser and mutation suites remain explicit local commands.

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

## Mutation testing

Stryker requires Node.js 22+ for its coordinator; tests still run on Bun through its built-in command runner. See the [Stryker configuration reference](https://stryker-mutator.io/docs/stryker-js/configuration/).

```sh
bun run test:mutation        # focused budget, approval and usage mutations; fast tests only
bun run test:mutation:dry    # run the focused baseline once; no active mutants
bun run test:mutation:smoke  # smaller approval/usage scope with a 100% score gate
bun run test:mutation:full   # explicit whole-repository sweep; potentially days
```

The default configuration mutates budget calculation, snapshot/activity approval guards and usage display functions. It runs only their source-level tests, with no build or local services. Two independent runners execute mutants in parallel. Bun receives `--bail` so the first failing assertion kills the mutant without waiting for unrelated tests. This is a focused mutation score for the listed source ranges.

The command runner cannot select tests by coverage, so `coverageAnalysis` is off and every mutant runs the entire configured test command. It reports that command as one aggregate test: `Ran 1 tests` is not the number of Bun test cases, and `3/N Mutants tested` means three mutated versions completed. Select matching source and tests together when adding mutation targets. All mutation testing remains opt-in and separate from `check` and CI. Both the default and smoke runs require a 100% mutation score for their focused scopes.

Two equivalent budget mutants have line-specific Stryker comments with reasons: a string in the fallback tier array never matches a numeric threshold, and changing the default mode to another non-demo value still takes the live path. They stay visible as ignored in reports. Tests cover missing block definitions, absent/empty tiers, pricing boundaries, snapshot immutability and default live behavior. Mutants that decrement the visit counter or remove the loop body produce infinite loops; their bounded process timeouts count as detected mutations.

`test:mutation:full` uses `stryker.full.config.mjs` to mutate TypeScript across `src/` and `web/`, excluding declarations and frozen legacy sources. It builds the instrumented distribution once inside Stryker's sandbox, then runs the backend/integration suite for each mutant with one runner. With tens of thousands of mutants and a roughly nine-minute baseline, this can take days even with early exit on failures. Its baseline limit is 20 minutes. Vue components and browser journeys are outside this scope. Local `.workflow/` state and existing build output are excluded from every sandbox.

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

Run `bun run check` before submitting changes. It runs ESLint with zero warnings, checks Prettier formatting, typechecks TypeScript, React TSX, and Vue templates, builds the distributable artifacts, and runs the unit and integration tests. CI runs only the quick unit suite (`bun run test:unit`). Run browser journeys (`bun run test:e2e`) and mutation checks (`bun run test:mutation:smoke`) explicitly when needed.

Use `bun run lint:fix` for safe lint fixes and `bun run format` to format supported repository files. `bun run format:web` limits formatting to the browser application. ESLint uses its flat config with the recommended JavaScript, TypeScript and Vue rules; Prettier owns formatting. Prefer type-only imports, `const`, explicit module ownership, and meaningful error causes. Narrow, documented exceptions cover heterogeneous SDK generics, control-character validation and integrity checks during cleanup. Historical workflow sources are excluded from automated lint and formatting rewrites to preserve replay behavior.

`.editorconfig` and `.prettierrc.json` define shared formatting defaults. `.prettierignore` excludes generated files, local workflow state, dependency directories and lockfiles. Add production code to its owning module and import implementations directly; avoid creating compatibility re-export files for old source paths.
