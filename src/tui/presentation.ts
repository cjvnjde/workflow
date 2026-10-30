import type { FlowStructure, RunEvent, Setup, SetupJob, TaskRequest, UsageReport, WorkflowRun } from "../contracts.js";

export const colors = {
  base: "#11131d", panel: "#191c29", raised: "#222637", border: "#343b50",
  text: "#dce2f1", muted: "#8b94ad", faint: "#5b6580", mint: "#8ce0ba",
  blue: "#8cbbff", lavender: "#c3a6ff", yellow: "#efcd88", red: "#f397a6",
};
export function plain(value: string) {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
export function short(value: string, length = 100) {
  const text = plain(value).replace(/\s+/g, " ");
  return [...text].length > length ? [...text].slice(0, length - 1).join("") + "…" : text;
}
export function setupSummary(setup?: Setup, job?: SetupJob, usage?: UsageReport) {
  const completed = setup?.completedSetup;
  const agent = { ...setup?.userAgent, ...setup?.projectAgent };
  const lines = ["Profiles, task instructions and reusable blocks share one saved setup job.",
    agent.provider && agent.model ? `Default: ${agent.provider}/${agent.model} · thinking ${agent.thinking ?? "default"}` : "Choose a project model with /models.",
    completed ? `Last published: ${completed.completedAt} · ${completed.model.provider}/${completed.model.model}` : "No completed setup has been published yet."];
  if (job) {
    lines.push("", `Job ${job.id}`, `${job.status.toUpperCase()} · ${job.model.provider}/${job.model.model} · thinking ${job.model.thinking}`, "");
    const names = { profiles: "Model profiles", cases: "Task instructions", blocks: "Reusable blocks", validation: "Validation", applying: "Publish settings" };
    for (const stage of job.stages) {
      const mark = stage.status === "completed" ? "✓" : stage.status === "running" ? "●" : stage.status === "pending" ? "○" : "!";
      lines.push(`${mark} ${names[stage.id]} · ${stage.status}${stage.attempt ? ` · attempt ${stage.attempt}` : ""}`);
      if (stage.summary || stage.error) lines.push(`  ${short(stage.error ?? stage.summary!, 240)}`);
    }
    if (usage) lines.push("", `Reported cost: $${usage.total.costUsd.toFixed(4)}${usage.incomplete ? " · partial / incomplete" : ""}${job.maxSetupCostUsd === undefined ? "" : ` · limit $${job.maxSetupCostUsd}`}`, `${usage.total.requests} model request${usage.total.requests === 1 ? "" : "s"} across all attempts`);
    if (job.activity) lines.push("", short(job.activity, 500));
    if (job.error) lines.push("", `Needs attention: ${job.error}`);
    if (job.conflict) lines.push(job.conflict.requiresRegeneration ? "Settings changed. Review your edits and use /setup regenerate." : "Resolve the listed file conflict, then resume setup.");
    if (job.actions.canResume) lines.push("", "/setup resume continues from the unfinished stage.");
    if (job.actions.canCancel) lines.push("/setup cancel stops this job.");
    if (job.status === "running" && job.stage === "applying") lines.push("Publication is finishing; cancellation is no longer available.");
  } else lines.push("", "Choose a model with /models, then use /setup start.");
  lines.push("", "Setup runs in the core host. Closing this terminal only detaches.", "Esc returns to your task. /setup regenerate designs a new setup.");
  return plain(lines.join("\n"));
}
export type Card = { id: string; title: string; body: string; tone: keyof typeof colors; markdown?: boolean; live?: boolean };
const names: Record<string, string> = {
  user_message: "You", planning: "Planning", classification: "Understanding the request", plan_ready: "Plan ready", plan_validation: "Refining the plan",
  agent_start: "AI started", agent_message: "Assistant", agent_retry: "Retrying provider", agent_continuation: "Continuing",
  node_start: "Step started", node_end: "Step result", run_end: "Workflow finished", draft: "Workflow proposed",
  approved: "Approved", rejected: "Rejected", paused: "Paused", resumed: "Resumed", interrupted: "Needs attention",
  planning_error: "Planning stopped", question: "A question for you", recovery: "File recovery", flow_decision: "Routing decision",
  script_start: "Command", script_output: "Command output", script_end: "Command finished", script_error: "Command failed",
  check_start: "Running a check", check: "Check result", function_start: "Function", function_end: "Function result",
};
export function activityCard(event: RunEvent): Card | undefined {
  if (event.operation) {
    const op = event.operation;
    return { id: `operation-${op.id}`, title: `${op.parentId ? "↳ " : ""}${op.name} · ${op.state}`,
      tone: op.state === "completed" ? "mint" : ["failed", "interrupted"].includes(op.state) ? "red" : "blue",
      body: plain([op.summary, op.input === undefined ? "" : `Input\n${JSON.stringify(op.input, null, 2)}`,
        op.output === undefined ? "" : `Result\n${JSON.stringify(op.output, null, 2)}`,
        op.details === undefined ? "" : `Details\n${JSON.stringify(op.details, null, 2)}`, op.truncated ? "Evidence abbreviated." : ""].filter(Boolean).join("\n\n")) };
  }
  if (["task_state", "usage", "text_delta", "group_state"].includes(event.kind)) return;
  let title = names[event.kind] ?? event.kind.replaceAll("_", " ");
  let body = plain(event.message);
  let tone: Card["tone"] = event.kind === "user_message" ? "lavender" : /error|failed|interrupted/.test(event.kind) ? "red" : /end|ready|approved/.test(event.kind) ? "mint" : "muted";
  if (event.kind.startsWith("tool_")) {
    const [first, ...rest] = body.split("\n");
    const name = first?.match(/^[\w.-]+/)?.[0] ?? "tool";
    title = `${event.kind === "tool_start" ? "↳" : "✓"} ${name.replace(/^mcp_/, "MCP · ").replaceAll("_", " ")}`;
    if (event.kind === "tool_start") {
      tone = "blue";
      try { body = JSON.stringify(JSON.parse(body.slice(name.length).trim()), null, 2); } catch { /* retain the tool's text */ }
    } else {
      const failed = /: error\b|: exit (?!0\b)/.test(first ?? "");
      tone = failed ? "red" : "mint";
      if (failed) title = title.replace("✓", "×");
      body = rest.join("\n") || first || "Finished";
    }
  } else if (event.kind === "model_session" || event.kind === "model_session_end") {
    try {
      const detail = JSON.parse(body);
      title = event.kind === "model_session" ? "Model session" : "Model usage";
      body = event.kind === "model_session" ? `${detail.provider}/${detail.model} · thinking ${detail.thinking}` : body;
    } catch { /* retain evidence */ }
  }
  return { id: event.id, title: event.nodeId ? `${title} · ${event.nodeId}` : title, body: body.slice(0, 16_000), tone,
    markdown: event.kind === "agent_message" || event.kind === "node_end" };
}
export function stepStatus(run: WorkflowRun, id: string) {
  if (run.activeNodes?.includes(id) || run.status === "running" && run.cursor === id) return { icon: "●", tone: "blue" as const, label: "running" };
  const attempt = run.attempts.findLast(item => item.nodeId === id);
  if (attempt?.error || attempt?.result?.outcome === "fail") return { icon: "×", tone: "red" as const, label: "failed" };
  if (attempt?.result?.outcome === "retry") return { icon: "↻", tone: "yellow" as const, label: "retry" };
  if (attempt?.finishedAt) return { icon: "✓", tone: "mint" as const, label: "done" };
  if (attempt) return { icon: "◉", tone: "yellow" as const, label: run.status };
  return { icon: "○", tone: "muted" as const, label: "pending" };
}
export type GraphLine = { text: string; tone: keyof typeof colors };
export function graphLines(run: WorkflowRun): GraphLine[] {
  const rows: GraphLine[] = [];
  if (run.program?.structure) {
    const visit = (node: FlowStructure, prefix: string, last: boolean, root = false) => {
      const connector = root ? "" : last ? "└─ " : "├─ ";
      const status = node.kind === "step" ? stepStatus(run, node.id) : undefined;
      const group = run.groups?.[node.id];
      const label = node.kind === "parallel" ? `⑂ ${node.label} · parallel ×${node.concurrency ?? node.children.length}`
        : node.kind === "loop" ? `↻ ${node.label} · ≤${node.maxIterations} rounds`
        : node.kind === "when" ? `◇ ${node.label} · branch`
        : node.kind === "sequence" ? `↓ ${node.label || "Sequence"}` : `${status!.icon} ${node.label || node.id}`;
      rows.push({ text: `${prefix}${connector}${plain(label)}`, tone: status?.tone ?? (group?.state === "failed" ? "red" : "lavender") });
      const next = root ? "" : prefix + (last ? "   " : "│  ");
      if (node.condition) rows.push({ text: `${next}   ${short(node.condition, 160)}`, tone: "faint" });
      node.children.forEach((child, i) => {
        if (node.kind === "when") rows.push({ text: `${next}  ${i === 0 ? "then" : "otherwise"}`, tone: "yellow" });
        visit(child, next, i === node.children.length - 1);
      });
      if (group?.decision) rows.push({ text: `${next}   → ${plain(group.decision.reason)}`, tone: "muted" });
    };
    visit(run.program.structure, "", true, true);
  } else {
    rows.push({ text: `START → ${run.plan.entry}`, tone: "lavender" });
    for (const node of run.plan.nodes) {
      const status = stepStatus(run, node.id);
      rows.push({ text: `${status.icon} ${node.label ?? node.id}`, tone: status.tone });
      for (const [outcome, target] of Object.entries(node.on)) rows.push({ text: `  ├─ ${outcome} → ${target}`, tone: "muted" });
      rows.push({ text: "", tone: "faint" });
    }
    if (run.program && !run.program.structure) rows.push({ text: "Runtime-defined steps appear as execution proceeds. Use /source to inspect the program.", tone: "yellow" });
  }
  return rows;
}
export function transcript(task?: TaskRequest, run?: WorkflowRun, events: RunEvent[] = [], live: Record<string, string> = {}): Card[] {
  const cards: Card[] = [];
  const prompt = task?.prompt ?? run?.plan.task;
  if (prompt) cards.push({ id: "request", title: "You", body: plain(prompt), tone: "lavender" });
  for (const [i, answer] of (task?.answers ?? []).entries()) {
    cards.push({ id: `question-${i}`, title: "Workflow", body: plain(answer.question), tone: "blue" },
      { id: `answer-${i}`, title: "You", body: plain(answer.answer), tone: "lavender" });
  }
  const latest = new Map<string, RunEvent>();
  for (const event of events.slice(-150)) {
    const key = event.operation ? `operation-${event.operation.id}` : event.id;
    const previous = latest.get(key);
    latest.set(key, event.operation ? { ...event, operation: { ...previous?.operation, ...event.operation } } : event);
  }
  cards.push(...[...latest.values()].flatMap(event => activityCard(event) ?? []));
  for (const [id, body] of Object.entries(live)) if (body.trim()) cards.push({ id: `live-${id}`, title: "Assistant · writing", body: plain(body), tone: "blue", markdown: true, live: true });
  if (task?.rationale) cards.push({ id: "rationale", title: "The plan", body: plain(task.rationale), tone: "mint", markdown: true });
  if (task?.question) cards.push({ id: "question", title: "Your input is needed", body: plain(task.question.question) + (task.question.options.length ? "\n\n" + task.question.options.map((option, i) => `${i + 1}. ${option}`).join("\n") : ""), tone: "yellow" });
  if (task?.error) cards.push({ id: "task-error", title: "Planning needs attention", body: plain(task.error), tone: "red" });
  if (run?.error) cards.push({ id: "run-error", title: "Execution needs attention", body: plain(run.error), tone: "red" });
  if (run?.output) cards.push({ id: "output", title: "Result", body: plain(run.output), tone: "mint", markdown: true });
  return cards;
}
export const commands = [
  ["/open", "Open a task or run by its full session ID"],
  ["/web", "Show the browser link for this session"],
  ["/id", "Show the current session ID"],
  ["/new", "Start a new session"], ["/sessions", "Open task and run history"], ["/graph", "Inspect the workflow graph"],
  ["/approve", "Approve the displayed draft"], ["/reject", "Reject the draft"], ["/auto", "Auto-approve new tasks: on / off"],
  ["/pause", "Pause after active steps"], ["/resume", "Resume or retry interrupted work"], ["/cancel", "Stop planning or execution"],
  ["/retry", "Retry failed task planning"], ["/recover", "Retry managed-file recovery"],
  ["/settings", "Project settings and connections"], ["/models", "Choose the project model"], ["/thinking", "Choose model thinking level"],
  ["/setup", "Project setup: status, start, resume, cancel, regenerate"],
  ["/login", "Connect a provider"], ["/logout", "Disconnect a provider"], ["/source", "Read workflow source"],
  ["/step", "Inspect a step and its results"], ["/help", "Commands and keyboard shortcuts"], ["/quit", "Close the terminal workspace"],
] as const;
