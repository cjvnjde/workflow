# Terminal workspace

[Documentation](README.md) → Terminal workspace

`workflow tui` opens a full-screen [OpenTUI](https://opentui.com/packages/opentui-core/) workspace with a conversation, live AI responses and tool activity, a workflow graph, and execution controls. It uses the same engine and HTTP client as the browser.

## Start

Run from the project you want Workflow to work on:

```sh
workflow tui

# Explicit simulation: no model calls.
workflow tui --demo --port 0

# Attach to a selected running engine, including through an SSH tunnel.
workflow tui --server http://127.0.0.1:4312
```

From this repository, `bun run workflow tui` runs the source version; `bun run start tui` runs the built version. Build first so the Temporal bundles are available. The renderer requires an interactive terminal with Bun 1.4.2+; use `workflow exec` or the plain CLI commands in scripts.

By default, the workspace checks port 4310 and attaches if a Workflow server already owns this project. `--port N` changes that check. If no server is found, it starts its own engine with an ephemeral loopback API and no web assets. `--port 0` skips discovery. The project lease still prevents two engines from owning the same project.

Closing a workspace that started its own engine stops that worker and saves its history. Inspect and resume interrupted work on the next launch. Closing a workspace attached to a server leaves execution running there. The welcome notice identifies which mode is active. For a persistent engine, start `workflow serve --no-web` separately before opening the TUI.

## Work through a task

1. Type your request and press **Enter**. **Shift+Enter** or **Ctrl+J** inserts a new line.
2. Watch planning activity. If the planner needs information, type your answer or an option number.
3. Review the graph in the sidebar, or open `/graph` for a full-width view. `/source` shows the proposed code; `/step` opens step details.
4. Type another message to refine a draft. Use `/cancel` to stop an unfinished refinement. Choose **Approve & start** or `/approve` when ready, or `/reject` to decline it.
5. Follow live responses, command/tool results, active steps, checks, and the final result. Click long tool cards to expand them. Use `/pause`, `/resume`, or `/cancel` to control execution.

Sequences, parallel groups, branches, and loop limits appear in the graph. Step colors distinguish running, completed, and failed attempts. At 110 columns or wider, the graph sits beside the conversation. Smaller terminals use `/graph` or **Ctrl+G** to switch views.

`/auto on` makes **new tasks created in this workspace** start after planning. `/auto off` restores review. The footer always shows the selected mode. This choice does not change the project's global setting or approve existing drafts. A new TUI launch starts from the project setting. Recovery tasks always require review.

`/new` opens an empty composer without cancelling work already started. `/sessions` reopens saved tasks and standalone runs, including their graph, persisted activity, questions, answers, and results. Refinement messages and coordinator streaming are retained only while this workspace remains open; the updated draft is saved by the engine. The conversation displays the latest 150 activity cards, with individual tool bodies limited to 16,000 characters; `/step` exposes saved attempt evidence.

## Commands and navigation

Type `/` to see commands, use **↑/↓** to select, and **Tab** to complete. Session, model, and settings pickers support typing to filter and **Enter** to select.

| Command | Action |
| --- | --- |
| `/new`, `/sessions` | Start another conversation or reopen task/run history. |
| `/graph`, `/source`, `/step [id]` | Inspect composition, code, or a step's instructions and results. |
| `/approve`, `/reject` | Accept the current draft revision or decline it. |
| `/auto [on\|off]` | Set approval for new tasks in this workspace; omit the argument to toggle. |
| `/pause`, `/resume`, `/cancel` | Pause after active steps, resume/retry interrupted execution, or stop work. |
| `/retry` | Retry failed or cancelled task planning. |
| `/recover` | Retry managed-file recovery after resolving conflicts. |
| `/settings` | Open model, thinking, approval, and connection settings; inspect project configuration. |
| `/models [search]`, `/thinking` | Set the project's default model or its supported thinking level. |
| `/login [provider]`, `/logout` | Connect or disconnect a model provider. |
| `/help`, `/quit` | Show help or close the workspace. |

| Shortcut | Action |
| --- | --- |
| **Ctrl+N** | New session. |
| **Ctrl+P** | Session history. |
| **Ctrl+G** | Toggle full graph view. |
| **PgUp / PgDn** | Scroll conversation or details; mouse scrolling also works. |
| **Esc** | Return to the conversation; cancel pending sign-in. |
| **Ctrl+C** | Close the workspace and restore the terminal. |

## Connect a model

Open `/login`, select a provider and connection method, then follow the authorization link/device-code instructions or paste an API key into the masked field. Secrets never enter the conversation or the regular text editor. **Ctrl+U** clears a secret field; **Esc** cancels unfinished sign-in. Closing the TUI cancels a sign-in it opened or resumed.

After connecting, use `/models` and `/thinking`. These update the engine project's defaults; existing model profiles keep their own assignments. Settings also exposes the project's execution limits, profiles, task instructions, and capabilities for inspection. Full library/profile/capability editing remains available in the browser workspace.

Credentials are stored by the engine in its private Workflow store. With `--server`, provider login configures that server's account; it is not authentication to the Workflow API. The API remains single-user and loopback-oriented. See [server access](clients.md#a-server-on-another-machine) for SSH tunnelling and the deployment boundary.
