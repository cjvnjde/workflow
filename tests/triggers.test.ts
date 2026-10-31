import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "vitest";
import { runSchema, type WorkflowRun } from "../src/contracts/domain.js";
import { createTemplate } from "../src/core/library/templates.js";
import { Triggers } from "../src/core/triggers/triggers.js";
import { instantiateTrigger } from "../src/core/triggers/trigger-template.js";
import {
  githubEventSchema,
  triggerConfigSchema,
  type GithubEvent,
} from "../src/contracts/trigger-schema.js";
import {
  GithubPollingSource,
  type GithubTriggerSource,
} from "../src/core/triggers/github-trigger-source.js";
import { fixture } from "./helpers.js";

const epoch = Date.parse("2026-10-26T10:00:00.000Z");
function event(number = 1, values: Partial<GithubEvent> = {}) {
  return githubEventSchema.parse({
    id: `github:owner/repo:issue.opened:${number}`,
    kind: "issue.opened",
    repository: "owner/repo",
    number,
    title: `Issue ${number}`,
    body: "External request",
    url: `https://github.com/owner/repo/issues/${number}`,
    author: "octocat",
    labels: ["workflow"],
    createdAt: new Date(epoch + 1000).toISOString(),
    updatedAt: new Date(epoch + 1000).toISOString(),
    ...values,
  });
}

async function setup(t: TestContext) {
  const { project, library, cleanup } = await fixture(t);
  const id = randomUUID(),
    now = new Date(epoch).toISOString();
  const template = runSchema.parse({
    id,
    createdAt: now,
    updatedAt: now,
    mode: "demo",
    status: "completed",
    plan: createTemplate("Report the event", "bug", library),
    config: library.config,
    blocks: library.blocks,
    executionProtocol: 2,
    executionVersion: "a".repeat(64),
    cursor: "prepare",
    visits: {},
    attempts: [],
    artifacts: {},
    program: {
      source: "frozen",
      input: { retained: true },
      catalog: library.blocks,
      models: {},
      composition: "graph",
    },
  });
  const runs = new Map<string, WorkflowRun>();
  let creations = 0,
    approvals = 0;
  const engine = {
    project,
    mode: "demo" as const,
    list: () =>
      [...runs.values()].map((run) => ({
        ...run,
        deletedAt: run.deletedAt,
        title: run.plan.title,
        task: run.plan.task,
      })),
    get: (id: string) => {
      const run = runs.get(id);
      if (!run) throw new Error("Workflow not found");
      return structuredClone(run);
    },
    snapshotForTrigger: async () => structuredClone(template),
    createTriggeredRun: async (value: WorkflowRun, id: string, input: GithubEvent) => {
      if (!runs.has(id)) {
        creations++;
        runs.set(id, await instantiateTrigger(value, id, input));
      }
      return engine.get(id);
    },
    approve: async (id: string) => {
      approvals++;
      runs.get(id)!.status = "running";
      return engine.get(id);
    },
  };
  let events = [event()],
    posted = 0;
  const comments = new Map<string, string>();
  const source: GithubTriggerSource = {
    poll: async () => structuredClone(events),
    item: async (_config, number) => event(number),
    findComment: async (_event, marker) => comments.get(marker),
    comment: async (_event, body) => {
      posted++;
      const url = `https://github.com/owner/repo/issues/1#issuecomment-${posted}`;
      comments.set(body.split("\n")[0]!, url);
      return url;
    },
  };
  let time = epoch;
  const open = async () => {
    const service = await Triggers.open(engine, source, () => time);
    cleanup(() => service.close());
    return service;
  };
  const service = await open();
  const config = triggerConfigSchema.parse({
    name: "Triage",
    repository: "owner/repo",
    event: "issue.opened",
    workflowRunId: id,
    enabled: true,
    labels: ["workflow"],
  });
  return {
    engine,
    runs,
    service,
    source,
    template,
    config,
    open,
    comments,
    counts: () => ({ creations, approvals, posted }),
    events: (value: GithubEvent[]) => {
      events = value;
    },
    advance: () => {
      time += 60_000;
    },
  };
}

test("trigger inbox deduplicates across restarts and queues behind active project work", async (t) => {
  const ctx = await setup(t);
  await ctx.service.save({ config: ctx.config });
  ctx.events([
    event(1),
    event(2),
    event(3, { labels: [] }),
    event(4, { createdAt: new Date(epoch - 1000).toISOString() }),
  ]);
  await ctx.service.tick(true);
  assert.equal(ctx.service.state().jobs.length, 2);
  assert.deepEqual(ctx.counts(), { creations: 1, approvals: 1, posted: 0 });
  const first = ctx.service.state().jobs.find((job) => job.status === "running")!;
  await ctx.service.close();
  const reopened = await ctx.open();
  await reopened.tick(true);
  assert.equal(reopened.state().jobs.length, 2);
  assert.equal(ctx.counts().creations, 1);
  ctx.runs.get(first.runId)!.status = "completed";
  await reopened.tick(true);
  assert.deepEqual(ctx.counts(), { creations: 2, approvals: 2, posted: 0 });
  assert.equal(reopened.state().jobs.filter((job) => job.status === "completed").length, 1);
  assert.equal(ctx.runs.get(first.runId)!.program!.input.retained, true);
  assert.equal((ctx.runs.get(first.runId)!.program!.input.event as GithubEvent).number, 1);
});

test("failed polling retains the checkpoint and disabled triggers do not admit or start work", async (t) => {
  const ctx = await setup(t);
  let trigger = await ctx.service.save({ config: { ...ctx.config, enabled: false } });
  await ctx.service.tick(true);
  assert.equal(ctx.service.state().jobs.length, 0);
  trigger = await ctx.service.save({
    id: trigger.id,
    revision: trigger.revision,
    config: ctx.config,
  });
  ctx.advance();
  const poll = ctx.source.poll;
  ctx.source.poll = async () => {
    throw new Error("Page two failed");
  };
  await ctx.service.tick(true);
  assert.equal(ctx.service.state().triggers[0]!.cursor, trigger.cursor);
  assert.match(ctx.service.state().triggers[0]!.error!, /Page two/);
  ctx.source.poll = poll;
  await ctx.service.tick(true);
  assert.notEqual(ctx.service.state().triggers[0]!.cursor, trigger.cursor);
  assert.equal(ctx.service.state().jobs.length, 1);
  await assert.rejects(
    ctx.service.save({ id: trigger.id, revision: trigger.revision - 1, config: ctx.config }),
    /changed/,
  );
});

test("manual tests create reviewable drafts even while disabled and never publish results", async (t) => {
  const ctx = await setup(t);
  const trigger = await ctx.service.save({
    config: { ...ctx.config, enabled: false, result: "github-comment" },
  });
  const job = await ctx.service.test(trigger.id, { number: 40 });
  assert.equal(job.status, "draft");
  assert.equal(ctx.counts().approvals, 0);
  await ctx.engine.approve(job.runId);
  ctx.runs.get(job.runId)!.status = "completed";
  await ctx.service.tick(true);
  assert.equal(ctx.service.state().jobs[0]!.status, "completed");
  assert.equal(ctx.counts().posted, 0);
});

test("queued events retain their captured workflow and budget through disabling and reconfiguration", async (t) => {
  const ctx = await setup(t);
  let trigger = await ctx.service.save({ config: { ...ctx.config, maxCostUsd: 1 } });
  ctx.events([event(1), event(2)]);
  await ctx.service.tick(true);
  const first = ctx.service.state().jobs.find((job) => job.status === "running")!;
  const queued = ctx.service.state().jobs.find((job) => job.status === "queued")!;
  trigger = await ctx.service.save({
    id: trigger.id,
    revision: trigger.revision,
    config: { ...ctx.config, enabled: false, maxCostUsd: 5 },
  });
  ctx.runs.get(first.runId)!.status = "completed";
  await ctx.service.tick(true);
  assert.equal(ctx.service.state().jobs.find((job) => job.id === queued.id)!.status, "queued");
  await ctx.service.close();
  const reopened = await ctx.open();
  await reopened.save({
    id: trigger.id,
    revision: trigger.revision,
    config: { ...ctx.config, maxCostUsd: 5 },
  });
  await reopened.tick(true);
  assert.equal(ctx.runs.get(queued.runId)!.config.budget?.maxCostUsd, 1);
  assert.equal(ctx.runs.get(queued.runId)!.executionVersion, trigger.executionVersion);
  assert.equal(ctx.counts().creations, 2);
});

test("recovering admission after a crash between run start and receipt does not create or approve another run", async (t) => {
  const ctx = await setup(t);
  await ctx.service.save({ config: ctx.config });
  const update = ctx.service["store"].update.bind(ctx.service["store"]);
  ctx.service["store"].update = () => {
    throw new Error("Simulated storage loss after start");
  };
  await assert.rejects(ctx.service.tick(true), /storage loss/);
  assert.equal(ctx.service.state().jobs[0]!.status, "queued");
  assert.equal(ctx.counts().approvals, 1);
  ctx.service["store"].update = update;
  await ctx.service.close();
  const reopened = await ctx.open();
  await reopened.tick(true);
  assert.equal(reopened.state().jobs[0]!.status, "running");
  // Complete the run whose start receipt was lost. Recovery must attach it.
  ctx.runs.values().next().value!.status = "completed";
  await reopened.tick(true);
  assert.equal(reopened.state().jobs[0]!.status, "completed");
  assert.deepEqual(ctx.counts(), { creations: 1, approvals: 1, posted: 0 });
});

test("a manual workflow winning an approval race leaves the event queued for later", async (t) => {
  const ctx = await setup(t);
  await ctx.service.save({ config: ctx.config });
  const approve = ctx.engine.approve;
  const manualId = randomUUID();
  ctx.engine.approve = async () => {
    ctx.runs.set(manualId, { ...structuredClone(ctx.template), id: manualId, status: "running" });
    throw new Error("Another workflow is running or paused in this project");
  };
  await ctx.service.tick(true);
  assert.equal(ctx.service.state().jobs[0]!.status, "queued");
  assert.equal(ctx.service.state().jobs[0]!.error, undefined);
  ctx.runs.get(manualId)!.status = "completed";
  ctx.engine.approve = approve;
  await ctx.service.tick(true);
  assert.equal(ctx.service.state().jobs[0]!.status, "running");
  assert.equal(ctx.counts().creations, 1);
  assert.equal(ctx.counts().approvals, 1);
});

test("comment publication reconciles a lost response after restart instead of posting twice", async (t) => {
  const ctx = await setup(t);
  await ctx.service.save({ config: { ...ctx.config, result: "github-comment" } });
  await ctx.service.tick(true);
  const job = ctx.service.state().jobs[0]!;
  ctx.runs.get(job.runId)!.status = "completed";
  const post = ctx.source.comment;
  ctx.source.comment = async (...args) => {
    await post(...args);
    throw new Error("Response lost");
  };
  await ctx.service.tick();
  assert.equal(ctx.service.state().jobs[0]!.delivery, "uncertain");
  await ctx.service.close();
  ctx.advance();
  const reopened = await ctx.open();
  await reopened.tick();
  assert.equal(reopened.state().jobs[0]!.delivery, "published");
  assert.equal(ctx.counts().posted, 1);
});

test("ambiguous publication with no visible comment is held for reconciliation, never blindly repeated", async (t) => {
  const ctx = await setup(t);
  await ctx.service.save({ config: { ...ctx.config, result: "github-comment" } });
  await ctx.service.tick(true);
  const job = ctx.service.state().jobs[0]!;
  ctx.runs.get(job.runId)!.status = "completed";
  let posts = 0;
  ctx.source.comment = async () => {
    posts++;
    throw new Error("Timed out");
  };
  await ctx.service.tick();
  ctx.advance();
  await ctx.service.tick();
  await ctx.service.action(job.id, "retry");
  await ctx.service.tick();
  assert.equal(posts, 1);
  assert.equal(ctx.service.state().jobs[0]!.delivery, "uncertain");
});

test("events and polling checkpoint commit together; a failed admission rolls back the entire batch", async (t) => {
  const ctx = await setup(t);
  const trigger = await ctx.service.save({ config: ctx.config });
  const one = ctx.service["job"](trigger, event(1));
  const invalid = { ...ctx.service["job"](trigger, event(2)), runId: "invalid" };
  assert.throws(() =>
    ctx.service["store"].admit({ ...trigger, cursor: new Date(epoch + 60_000).toISOString() }, [
      one,
      invalid,
    ]),
  );
  assert.equal(ctx.service.state().jobs.length, 0);
  assert.equal(ctx.service.state().triggers[0]!.cursor, trigger.cursor);
  ctx.advance();
  const admit = ctx.service["store"].admit.bind(ctx.service["store"]);
  ctx.service["store"].admit = () => {
    throw new Error("Inbox write failed");
  };
  await ctx.service.tick(true);
  assert.equal(ctx.service.state().triggers[0]!.cursor, trigger.cursor);
  assert.match(ctx.service.state().triggers[0]!.error!, /Inbox write failed/);
  assert.equal(ctx.service.state().jobs.length, 0);
  ctx.service["store"].admit = admit;
  await ctx.service.tick(true);
  assert.equal(ctx.service.state().jobs.length, 1);
});

test("GitHub polling follows pages, separates issues from PRs, and preserves the observed commit", async () => {
  const requests: string[] = [];
  const issue = (number: number, pr = false) => ({
    number,
    title: "Item",
    body: "data",
    user: { login: "octocat" },
    labels: [{ name: "workflow" }],
    created_at: new Date(epoch).toISOString(),
    updated_at: new Date(epoch).toISOString(),
    ...(pr ? { pull_request: {} } : {}),
  });
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/pulls/2"))
      return Response.json({
        head: { sha: "abc", ref: "feature" },
        base: { sha: "def", ref: "main" },
        draft: false,
      });
    if (url.endsWith("page=1"))
      return Response.json([issue(1), issue(2, true)], {
        headers: { link: '<https://api.github.com/next>; rel="next"' },
      });
    return Response.json([issue(3)]);
  }) as typeof fetch;
  const source = new GithubPollingSource("/tmp", fetcher);
  source["token"] = async () => "test-token";
  const config = triggerConfigSchema.parse({
    name: "PRs",
    repository: "Owner/Repo",
    event: "pull_request.opened",
    workflowRunId: randomUUID(),
  });
  const result = await source.poll(
    config,
    new Date(epoch).toISOString(),
    new AbortController().signal,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.headSha, "abc");
  assert.equal(result[0]!.url, "https://github.com/owner/repo/pull/2");
  assert.ok(requests.some((url) => url.endsWith("page=2")));
  assert.ok(requests[0]!.includes("since=2026-10-26T09%3A58%3A00.000Z"));
});
