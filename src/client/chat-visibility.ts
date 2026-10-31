import type { RunEvent } from "../contracts/domain.js";

export type ChatVisibility = { tools: boolean; thinking: boolean };
export const defaultChatVisibility: Readonly<ChatVisibility> = { tools: false, thinking: false };

const progressKinds = new Set([
  "planning",
  "classification",
  "agent_start",
  "agent_continuation",
  "node_start",
  "group_state",
  "flow_decision",
  "model_session",
  "model_session_end",
  "usage",
  "thinking",
  "thinking_delta",
  "reasoning",
  "reasoning_delta",
]);

/** Hide routine evidence, never questions, responses, unknown events or failure diagnostics. */
export function chatEventVisible(event: RunEvent, visibility: Readonly<ChatVisibility>): boolean {
  const { kind, operation } = event;
  if (operation) {
    if (operation.state === "failed" || operation.state === "interrupted") return true;
    return operation.kind === "ai" ? visibility.thinking : visibility.tools;
  }
  if (kind.endsWith("_error") || kind === "agent_retry" || kind === "plan_validation") return true;
  if (
    kind.startsWith("tool_") ||
    kind.startsWith("script_") ||
    kind.startsWith("function_") ||
    kind === "check" ||
    kind === "check_start"
  ) {
    // Legacy events encode their outcome in the first line rather than an operation record.
    const first = event.message.split("\n", 1)[0] ?? "";
    if (/: error\b|: exit (?!0\b)|\bcondition NOT met\b|\btimed out\b/i.test(first)) return true;
    return visibility.tools;
  }
  return !progressKinds.has(kind) || visibility.thinking;
}
