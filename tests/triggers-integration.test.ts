import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApplication } from "../src/application.js";
import { createHttpServer } from "../src/http-server.js";
import { WorkflowClient, waitForRun } from "../src/client.js";
import { githubEventSchema, triggerConfigSchema, type GithubEvent } from "../src/trigger-schema.js";
import type { GithubTriggerSource } from "../src/github-trigger-source.js";
import { fixture } from "./helpers.js";

const source = `import { workflow, block, step, z } from "workflow";
const inputSchema = z.object({ event: z.object({ number: z.number() }).optional() });
const capture = block({ input: z.object({ number: z.number() }), run(ctx) {
  ctx.summary("captured #" + ctx.input.number); return ctx.input;
}});
export default workflow({ name: "Capture event", input: inputSchema,
  flow: step("capture", capture, { inputs: ctx => ({ number: inputSchema.parse(ctx.input).event?.number ?? 0 }) }) });`;

function item(number: number) {
  const time = new Date(Date.now() + 1000).toISOString();
  return githubEventSchema.parse({ id: `github:owner/repo:issue.opened:${number}`, repository: "owner/repo", kind: "issue.opened",
    number, title: "Test issue", body: "Untrusted input", url: `https://github.com/owner/repo/issues/${number}`,
    author: "octocat", labels: [], createdAt: time, updatedAt: time });
}

test("trigger API starts the frozen workflow with event input and survives application restart", async t => {
  const { project, cleanup } = await fixture(t);
  let events: GithubEvent[] = [];
  const adapter: GithubTriggerSource = { poll: async () => events, item: async (_config, number) => item(number),
    findComment: async () => undefined, comment: async () => { throw new Error("Unexpected publication"); } };
  const app = await createApplication({ project, mode: "demo", triggerSource: adapter }); cleanup(() => app.close());
  const http = await createHttpServer(app, 0); cleanup(() => http.close());
  const address = await http.listen({ port: 0, host: "127.0.0.1" });
  const client = new WorkflowClient({ baseUrl: address });
  const draft = await client.createProgram({ title: "Capture", task: "Summarize each event", source });
  const trigger = await client.saveTrigger(triggerConfigSchema.parse({ name: "New issues", repository: "owner/repo", event: "issue.opened", workflowRunId: draft.id, enabled: true }));
  await app.updateProgram(draft.id, { source: source.replace("captured #", "edited #") }, draft.revision);
  events = [item(1)];
  await client.pollTriggers();
  const job = (await client.triggers()).jobs[0]!;
  const run = await waitForRun(() => client.run(job.runId), { signal: AbortSignal.timeout(15_000) });
  assert.equal(run.status, "completed");
  assert.equal(run.executionVersion, trigger.executionVersion);
  assert.equal(run.attempts[0]!.result!.summary, "captured #1");
  assert.equal(run.program!.input.event && (run.program!.input.event as GithubEvent).number, 1);
  await http.close(); await app.close();
  const reopened = await createApplication({ project, mode: "demo", triggerSource: adapter }); cleanup(() => reopened.close());
  await reopened.triggers.tick(true);
  assert.equal(reopened.triggers.state().jobs.length, 1);
  assert.equal(reopened.triggers.state().jobs[0]!.status, "completed");
  assert.equal(reopened.listRuns().filter(saved => saved.id === job.runId).length, 1);
});

test("manual trigger drafts require approval and an edited automatic draft cannot be auto-approved", async t => {
  const { project, cleanup } = await fixture(t);
  const adapter: GithubTriggerSource = { poll: async () => [], item: async (_config, number) => item(number),
    findComment: async () => undefined, comment: async () => { throw new Error("Unexpected publication"); } };
  const app = await createApplication({ project, mode: "demo", triggerSource: adapter }); cleanup(() => app.close());
  const draft = await app.createProgram({ title: "Capture", task: "Capture inputs", source });
  const trigger = await app.triggers.save({ config: triggerConfigSchema.parse({ name: "Test", repository: "owner/repo", event: "issue.opened", workflowRunId: draft.id }) });
  const job = await app.triggers.test(trigger.id, { number: 9 });
  assert.equal(app.getRun(job.runId).status, "draft");
  assert.equal(app.getRun(job.runId).attempts.length, 0);
  const template = await app.engine.snapshotForTrigger(draft.id);
  await app.updateProgram(job.runId, { source: source.replace("captured #", "tampered #"), input: app.getRun(job.runId).program!.input }, 0);
  await assert.rejects(app.engine.createTriggeredRun(template, job.runId, job.event), /edited/);
  await app.approve(job.runId, app.getRun(job.runId).revision);
  const result = await waitForRun(() => app.getRun(job.runId), { signal: AbortSignal.timeout(15_000) });
  assert.equal(result.status, "completed");
  assert.equal(result.attempts[0]!.result!.summary, "tampered #9");
  await app.triggers.tick();
  assert.equal(app.triggers.state().jobs[0]!.status, "completed");
  const promoted = await app.engine.snapshotForTrigger(result.id);
  const next = await app.engine.createTriggeredRun(promoted, randomUUID(), item(10));
  assert.equal(next.plan.title, "Capture · owner/repo#10");
  assert.equal(next.plan.task, draft.plan.task);
  assert.equal(next.attempts.length, 0);
  assert.deepEqual(next.artifacts, {});
  assert.equal((next.program!.input.event as GithubEvent).number, 10);
});
