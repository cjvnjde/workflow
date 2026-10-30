/** Terminal presentation. Model execution and persistence belong to the core host. */
export { connectTerminal, runTerminalWorkspace } from "./workspace.js";
export type { TerminalOptions } from "./workspace.js";
export { TerminalController } from "./controller.js";
export { runClientCommand } from "../cli/terminal-client.js";
