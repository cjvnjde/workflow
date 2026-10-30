/** Terminal presentation. Model execution and persistence belong to the core host. */
export { connectTerminal, runTerminalWorkspace } from "../tui.js";
export type { TerminalOptions } from "../tui.js";
export { TerminalController } from "../tui/controller.js";
export { runClientCommand } from "../terminal-client.js";
