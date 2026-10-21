import type { BlockBundle, Library } from "./domain.js";
import { pushScript } from "./script-examples.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Normalize editable libraries only; never rewrite approved run snapshots. */
export function scriptBundle(bundle: BlockBundle, commands: Library["config"]["commands"]): BlockBundle {
  const executor = bundle.definition.executor;
  if (!executor || executor.kind === "script" || executor.kind === "code") return bundle;
  if (executor.kind === "function") {
    return { ...bundle, definition: { ...bundle.definition, executor: pushScript(executor.remote) } };
  }
  const command = commands[executor.command];
  if (!command) throw new Error(`Block ${bundle.definition.id} uses undefined command ${executor.command}`);
  return { ...bundle, definition: { ...bundle.definition, executor: {
    kind: "script", language: "bash", runtime: "bash", expect: executor.expect,
    timeoutMs: command.timeoutMs, code: `exec ${command.argv.map(quote).join(" ")}\n`,
  } } };
}
export function scriptLibrary(library: Library): Library {
  return { ...library, blocks: Object.fromEntries(Object.entries(library.blocks)
    .map(([id, bundle]) => [id, scriptBundle(bundle, library.config.commands)])) };
}
