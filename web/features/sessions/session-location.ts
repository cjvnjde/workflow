/** Session links select local persisted work; they never navigate to a pasted host. */
export type SessionLocation = { id: string; kind?: "task" | "run" };

export function parseSessionLocation(value: string): SessionLocation {
  let source = value.trim();
  if (!source) throw new Error("Enter a task or run ID, or paste a Workflow link.");
  let kind: SessionLocation["kind"];
  if (source.startsWith("#") || /^https?:\/\//i.test(source)) {
    const url = new URL(source, "http://workflow.local");
    const hash = new URLSearchParams(url.hash.slice(1));
    const selection = hash.has("task") || hash.has("run") ? hash : url.searchParams;
    kind = selection.has("task") ? "task" : selection.has("run") ? "run" : undefined;
    source = (kind ? selection.get(kind) : url.searchParams.get("session")) ?? "";
  }
  const prefix = /^(task|run):/.exec(source);
  if (prefix) {
    kind = prefix[1] as SessionLocation["kind"];
    source = source.slice(prefix[0].length);
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(source)) {
    throw new Error("Use the full task or run ID shown in Workflow, or a link to that session.");
  }
  return { id: source.toLowerCase(), ...(kind ? { kind } : {}) };
}

export function sessionLink(base: string, session: SessionLocation): string {
  const url = new URL(base);
  for (const key of ["session", "view", "task", "run"]) url.searchParams.delete(key);
  url.searchParams.set(session.kind ?? "run", session.id);
  url.hash = "";
  return url.href;
}
