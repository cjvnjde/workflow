# Project review: shared engine and project setup

Reviewed against the intended install → login → init → configure → generate → work flow on 2026-10-30.

## What changed

| Area | Finding | Result |
| --- | --- | --- |
| Architecture | A headless application existed, but its public module boundaries were hard to see. | Explicit `core`, `web`, and `terminal` entries expose the responsibilities while preserving compatibility imports. |
| Shared sessions | A TUI-owned host was API-only, and opening a saved task required navigating history. | Both interfaces share the host; ID/link navigation, terminal attach, and project-local host discovery make switching explicit. |
| Initialization | `init` could spend model usage before the user finished configuring defaults. | `init` is deterministic. `setup` is the separate AI bootstrap. |
| Default model | Planning silently favored a different model; old coordinator settings could survive regeneration. | Saved defaults are honored. Setup clears legacy coordinator overrides, and unsupported thinking levels are normalized during model selection. |
| Generated library | AI setup only generated profiles. UI-managed source could shadow editable disk files. | Setup generates profiles, task instructions, and validated TypeScript blocks. Applied `block.ts` files are editable and authoritative. |
| Costs and handoffs | Sessions were already fresh, but omitting inherited workflow context was tied to tool selection. | `ctx.ai({ context: "none" })` selects prompt-only context independently of tools. Explicit typed inputs and deterministic command blocks remain available. |
| First-run UI | Connection/default/library state and session switching were difficult to discover. | Setup checklist, default summary, open-by-ID dialog, and copyable browser/terminal links. |
| Reliability | Separate server/library leases collided inside the lock library. Web-only builds could delete web module declarations. | Separate lock targets with a heartbeat regression test, and public declarations outside the browser asset directory. |

## Intended flow

```sh
workflow login openai
workflow model
cd /path/to/project
workflow init
workflow setup
workflow serve

# Another terminal, same project:
workflow tui
workflow attach <task-or-run-id>
```

Use Settings to refine defaults, profiles, blocks, instructions, and execution limits. Task presets describe review, bug fixes, features, and documentation; the selected planner composes a graph for the actual request. Models come from the refreshed connected catalog. An expensive model is not automatically assigned to every step.

## Verification

Validation passed: **325 unit/integration tests** and **56 browser tests**, plus TypeScript/Vue checking, production packaging, and real PTY attachment. A real OpenAI OAuth setup run generated four profiles, six task presets, and nine editable blocks in a disposable Bun project. Invalid generated TypeScript was rejected, corrected by the model, then applied successfully. Repeating setup retained the configuration without another model call.

A real read-only task used the selected Sol default to compose its graph and Luna to execute the requested review and run the fixture's tests. It completed without changing the fixture's source files. This verifies the provider, planning, typed block, tools, and execution path; generated review findings still require human judgment.

The shared demo task was created in the browser, reopened in the terminal, approved, and completed. Screenshots show the actual web workspace and captured native terminal cells:

- [Web workspace](screenshots/web-workspace.jpg)
- [Expanded graph](screenshots/web-graph.jpg)
- [Terminal workspace](screenshots/terminal-workspace.png)
- [Generated project setup](screenshots/web-setup.jpg)

The deterministic tests cover model precedence, no-context calls, generated source editing, stale proposals, source recovery, concurrent server/library leases, shared session selection, and terminal cleanup. Browser tests cover both the new session controls and the existing editing, approval, mobile, login, and recovery flows. Cancelling a delayed session lookup aborts its requests and preserves a newer task draft; Cancel, close, and Escape are covered.

## Current boundaries

- The three modules ship together. They are not separately published packages.
- A TUI that owns its engine stops it on exit. Run `workflow serve` separately when execution must outlive clients. Persisted work can be reopened afterward; resuming execution is an explicit action.
- A session ID identifies a persisted task/run in one project. It does not restore a model's complete conversation. Interrupted model activities retain the existing retry/recovery boundary.
- Task instructions are reusable workflow intents. Concrete graphs are composed per request and saved as runs; setup does not produce a fixed graph for every possible task.
- Context selection controls automatically supplied information. Tools, shell commands, and MCP still run with the host's access; this is not an OS sandbox.
- Setup validates all generated proposals before publishing. Its files are not one filesystem transaction: a concurrent settings edit or write failure after block publication can require retrying setup. Errors identify that partial-save state.
- Catalog availability depends on the provider/account. Refresh failures retain cached models and show a warning. Estimated model prices are not a subscription bill, and setup/planning usage is separate from execution budgets.

[Architecture](architecture.md) · [Configuration](configuration.md) · [Terminal guide](terminal.md)
