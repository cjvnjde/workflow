import type { RunEvent } from "../src/domain.js";
import type { IconName } from "./icons.js";

export const activityCategories = [
  ["all", "All activity"],
  ["updates", "AI & progress"],
  ["tools", "Tools"],
  ["checks", "Checks"],
  ["usage", "Usage"],
] as const;
export type ActivityCategory = (typeof activityCategories)[number][0];
export type ActivityItem = {
  event: RunEvent;
  category: Exclude<ActivityCategory, "all">;
  title: string;
  preview: string;
  detail: string;
  icon: IconName;
  state?: string;
  tone?: "success" | "error" | "working" | "warning";
  markdown: boolean;
};

function object(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const toolLabels: Record<string, string> = {
  read_file: "Read file",
  list_files: "Find files",
  write_file: "Write file",
  edit_file: "Edit file",
  git_changes: "Inspect Git changes",
  git: "Git command",
  bash: "Run command",
  run_check: "Run check",
  submit_result: "Submit result",
  submit_plan: "Submit workflow",
  choose_task_case: "Choose task instructions",
  ask_question: "Ask a question",
  propose_settings: "Propose settings",
};
const labels: Record<string, string> = {
  agent_start: "Model started",
  agent_message: "AI update",
  agent_retry: "Provider retry",
  agent_continuation: "Completing the response",
  node_start: "Step started",
  node_end: "Step result",
  run_end: "Workflow finished",
  draft: "Workflow proposed",
  rejected: "Workflow rejected",
  planning: "Understanding the request",
  classification: "Task classified",
  plan_ready: "Workflow ready",
  plan_validation: "Refining the workflow",
  planning_error: "Planning stopped",
  question: "Needs your input",
  block_proposal: "Block suggested",
  recovery: "File recovery",
  function_start: "Function started",
  function_end: "Function result",
};

/** Presentation only: retain the original event, including truncated/unknown formats. */
export function describeActivity(event: RunEvent): ActivityItem {
  const firstLine = event.message.split("\n")[0] ?? "";
  const item: ActivityItem = {
    event,
    category: "updates",
    title: labels[event.kind] ?? event.kind.replaceAll("_", " "),
    preview: firstLine,
    detail: event.message,
    icon: "spark",
    markdown: false,
  };
  if (event.kind === "usage") {
    item.category = "usage";
    item.title = "Reported model usage";
    item.icon = "chart";
    const usage = object(event.message);
    if (usage) {
      const number = (key: string) =>
        typeof usage[key] === "number" &&
        Number.isFinite(usage[key]) &&
        usage[key] >= 0
          ? usage[key]
          : undefined;
      const requests = number("requests");
      const tokens = [
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
      ].map(number);
      const cost = number("costUsd");
      item.preview =
        [
          requests === undefined
            ? ""
            : `${requests.toLocaleString()} ${requests === 1 ? "request" : "requests"}`,
          tokens.some((n) => n !== undefined)
            ? `${tokens.reduce<number>((sum, n) => sum + (n ?? 0), 0).toLocaleString()} tokens`
            : "",
          cost === undefined ? "" : `$${cost.toFixed(4)} reported`,
        ]
          .filter(Boolean)
          .join(" · ") || firstLine;
      item.detail = JSON.stringify(usage, null, 2);
    }
  } else if (event.kind.startsWith("tool_")) {
    item.category = "tools";
    item.icon = "terminal";
    const name = firstLine.match(/^([^\s:]+)/)?.[1] ?? "Tool";
    item.title =
      toolLabels[name] ?? name.replace(/^mcp_/, "MCP · ").replaceAll("_", " ");
    const args =
      event.kind === "tool_start"
        ? object(event.message.slice(name.length).trim())
        : undefined;
    if (args) {
      const preview = [
        args.path,
        args.command,
        args.pattern,
        args.summary,
        args.reason,
      ].find((value) => typeof value === "string" && value.length);
      item.preview =
        typeof preview === "string"
          ? preview.split("\n")[0]!
          : "Inspect the tool arguments below.";
      item.detail = JSON.stringify(args, null, 2);
    }
    if (event.kind === "tool_start") {
      item.state = "Started";
      item.tone = "working";
    } else {
      const exit = firstLine.match(/: exit (-?\d+|unknown)\b/);
      const failed = /: error\b/.test(firstLine) || (exit && exit[1] !== "0");
      const succeeded = /: finished\b/.test(firstLine) || exit?.[1] === "0";
      item.state = failed ? "Error" : succeeded ? "Finished" : "Ended";
      item.tone = failed ? "error" : succeeded ? "success" : undefined;
      item.preview =
        event.message
          .split("\n")
          .slice(1)
          .find((line) => line.trim()) ?? firstLine;
    }
  } else if (event.kind === "check" || event.kind === "check_start") {
    item.category = "checks";
    item.icon = "shield";
    item.title =
      event.kind === "check_start" ? "Running host check" : "Host check result";
    item.state =
      event.kind === "check_start"
        ? "Started"
        : /condition NOT met/.test(firstLine)
          ? "Not met"
          : /condition met/.test(firstLine)
            ? "Met expectation"
            : "Recorded";
    item.tone =
      event.kind === "check_start"
        ? "working"
        : item.state === "Not met"
          ? "error"
          : item.state === "Met expectation"
            ? "success"
            : undefined;
  } else {
    item.markdown = ["agent_message", "node_end", "function_end"].includes(
      event.kind,
    );
    if (event.kind === "node_end") {
      item.state = firstLine.startsWith("PASS")
        ? "Passed"
        : firstLine.startsWith("RETRY")
          ? "Retry"
          : firstLine.startsWith("FAIL")
            ? "Failed"
            : undefined;
      item.tone =
        item.state === "Passed"
          ? "success"
          : item.state === "Retry"
            ? "warning"
            : item.state === "Failed"
              ? "error"
              : undefined;
      item.icon = "workflow";
    } else if (event.kind === "planning_error") {
      item.tone = "error";
      item.icon = "alert";
    } else if (
      event.kind === "agent_retry" ||
      event.kind === "plan_validation"
    ) {
      item.tone = "warning";
    } else if (event.kind === "run_end") {
      item.tone = firstLine.startsWith("COMPLETED")
        ? "success"
        : firstLine.startsWith("FAILED")
          ? "error"
          : undefined;
      item.icon = "workflow";
    }
  }
  return item;
}

export function matchesActivity(
  item: ActivityItem,
  query: string,
  nodeLabel = "",
) {
  return `${item.title}\n${item.event.kind}\n${item.event.nodeId ?? ""}\n${nodeLabel}\n${item.event.message}`
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}
