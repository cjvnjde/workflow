import { workflow, block, step, z } from "workflow";

// A first trigger workflow that needs no model and makes no project-file changes.
// Replace or extend the report step after testing the event input in your project.
const eventInput = z.object({
  event: z.object({
    kind: z.enum(["issue.opened", "pull_request.opened"]),
    repository: z.string(),
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    bodyTruncated: z.boolean(),
    url: z.string().url(),
    author: z.string(),
    labels: z.array(z.string()),
    headSha: z.string().optional(),
    baseSha: z.string().optional(),
  }),
});
const report = block({
  name: "Report the incoming GitHub item",
  input: eventInput,
  run(ctx) {
    const event = ctx.input.event;
    const summary = [
      `Received ${event.kind}: ${event.repository}#${event.number}`,
      `Title: ${event.title}`,
      `Author: ${event.author}`,
      `Labels: ${event.labels.join(", ") || "none"}`,
      `Source: ${event.url}`,
      ...(event.headSha ? [`Observed PR commit: ${event.headSha}`] : []),
      "",
      event.body,
      ...(event.bodyTruncated
        ? ["", "The description was truncated; read the original item for the full text."]
        : []),
    ].join("\n");
    ctx.summary(summary.slice(0, 15_000));
    ctx.artifact("github-event.txt", summary);
    return { repository: event.repository, number: event.number, url: event.url };
  },
});

export default workflow({
  name: "GitHub event report",
  input: eventInput,
  flow: step("report-event", report, { inputs: (ctx) => ctx.input }),
});
