import { AsyncLocalStorage } from "node:async_hooks";

export type AutomationLimit = "commands" | "models" | "tools";
export interface AutomationBoundary {
  environment: string[];
  consume: (kind: AutomationLimit) => Promise<void>;
  commandReserved?: boolean;
}
export const automationBoundary = new AsyncLocalStorage<AutomationBoundary>();
const baseline = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
];
/** Environment references are resolved at the process boundary, never serialized. Local execution is not a sandbox. */
export function automationEnvironment(): Record<string, string> | undefined {
  const boundary = automationBoundary.getStore();
  if (!boundary) return undefined;
  return Object.fromEntries(
    [...new Set([...baseline, ...boundary.environment])]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]!]),
  );
}
export async function consumeAutomationLimit(kind: AutomationLimit) {
  await automationBoundary.getStore()?.consume(kind);
}
