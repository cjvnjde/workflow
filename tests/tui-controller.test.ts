import assert from "node:assert/strict";
import path from "node:path";
import { cp } from "node:fs/promises";
import { userPaths } from "../src/infrastructure/user-paths.js";
import test, { type TestContext } from "node:test";
import { createApplication, type ApplicationServices } from "../src/core/application.js";
import { createHttpServer } from "../src/http/http-server.js";
import { WorkflowClient } from "../src/client/client.js";
import { TerminalController } from "../src/terminal/controller.js";
import { connectTerminal } from "../src/terminal/workspace.js";
import { stopProjectHost } from "../src/host/host-lifecycle.js";
import { BrowserAuth } from "../src/core/models/browser-auth.js";
import { createTemplate } from "../src/core/library/templates.js";
import { loadOrchestration } from "../src/core/settings/orchestration-settings.js";
import { authRuntime } from "./auth-fixture.js";
import { fixture, passingRunner } from "./helpers.js";
import { bundleSchema } from "../src/contracts/domain.js";

const model = {
  provider: "test",
  id: "careful",
  name: "Careful",
  reasoning: true,
  thinkingLevels: ["low", "medium", "high"],
  contextWindow: 32000,
  maxTokens: 4000,
  cost: null,
};
async function context(
  t: TestContext,
  options: {
    question?: boolean;
    auth?: BrowserAuth;
    plan?: ApplicationServices["plan"];
    design?: ApplicationServices["design"];
  } = {},
) {
  const { project, library, cleanup } = await fixture(t);
  const cache = path.join(userPaths().directory, "cache", "temporal");
  const previous = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = path.join(project, "user-settings");
  await cp(cache, path.join(project, "user-settings", "cache", "temporal"), {
    recursive: true,
  }).catch(() => {});
  t.after(() => {
    if (previous === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = previous;
  });
  const app = await createApplication({
    project,
    mode: options.question || options.plan || options.design ? "live" : "demo",
    runner: passingRunner,
    plan: options.plan,
    design: options.design,
    catalog: async () => ({ models: [model], warnings: [] }),
    providers: async () => [],
    auth: options.auth,
    taskPlanner: async ({ task, emit }) => {
      emit("text_delta", "Let me clarify the integration.");
      if (!task.answers.length)
        return {
          kind: "question",
          question: { question: "Which service?", options: ["Internal", "External"] },
        };
      return {
        kind: "plan",
        plan: createTemplate(task.prompt, "feature", library),
        library,
        rationale: "Use the chosen service",
        suggestedBlocks: [],
      };
    },
  });
  cleanup(() => app.close());
  const server = await createHttpServer(app, 0);
  cleanup(() => server.close());
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const controller = new TerminalController(new WorkflowClient({ baseUrl: address }));
  cleanup(() => controller.close());
  await controller.initialize();
  return { app, controller, project, library, address };
}
async function until(controller: TerminalController, check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    await controller.refresh();
    if (check()) return;
    await Bun.sleep(30);
  }
  throw new Error(
    `State transition timed out: ${controller.state.error} ${controller.state.task?.status}/${controller.state.run?.status}; setup ${controller.state.setupJob?.status}: ${controller.state.setupJob?.error ?? ""}`,
  );
}

test("terminal requests produce reviewable drafts; stale approval is refused, auto mode affects only new tasks", async (t) => {
  const { controller, app, project } = await context(t);
  await controller.submit("Build a terminal feature");
  await until(controller, () => controller.state.run?.status === "draft");
  const run = controller.state.run!;
  assert.equal(controller.state.task?.approval, "review");
  await controller.submit("/graph");
  assert.equal(controller.state.screen, "graph");
  await controller.submit("/auto on");
  assert.equal(app.getRun(run.id).status, "draft");
  assert.equal((await loadOrchestration(project)).settings.approval, "review");
  await app.updatePlan(run.id, { ...run.plan, title: "Edited elsewhere" }, run.revision);
  await assert.rejects(controller.runAction("approve"), /Draft changed/);
  await controller.refresh();
  await controller.submit("/reject");
  assert.equal(app.getRun(run.id).status, "rejected");
  await controller.submit("/new");
  await controller.submit("Run this automatically");
  await until(controller, () => controller.state.run?.status === "completed");
  assert.equal(controller.state.task?.approval, "automatic");
  await controller.submit("/sessions");
  const first = controller.state.choices.find(
    (choice) => choice.label === "Build a terminal feature",
  );
  assert.ok(first);
  await controller.choose(first.id);
  assert.equal(controller.state.run?.id, run.id);
  assert.equal(controller.state.run?.status, "rejected");
});

test("planner questions, answers, model settings and thinking selection work through the terminal client", async (t) => {
  const { controller, app, project, address } = await context(t, { question: true });
  await assert.rejects(
    connectTerminal({ project, server: address, demo: true }),
    /selected server is live/,
  );
  const attached = await connectTerminal({ project, server: address });
  assert.equal(attached.owned, false);
  await attached.close();
  assert.equal(
    (await attached.client.project()).project,
    app.project,
    "detaching must leave the engine running",
  );
  await controller.submit("Integrate a service");
  await until(controller, () => controller.state.task?.status === "needs_input");
  await controller.submit("1");
  await until(controller, () => controller.state.run?.status === "draft");
  assert.equal(controller.state.task?.answers[0]?.answer, "Internal");
  await controller.submit("/models");
  await controller.choose("test/careful");
  assert.equal((await app.setup()).projectAgent.model, "careful");
  await controller.submit("/thinking");
  await controller.choose("high");
  assert.equal((await app.setup()).projectAgent.thinking, "high");
  assert.equal(controller.state.run?.status, "draft");
});

test("session IDs reopen the same task and run across terminal controllers with shareable browser links", async (t) => {
  const { controller, address } = await context(t);
  await controller.submit("Review a shared session");
  await until(controller, () => controller.state.run?.status === "draft");
  const taskId = controller.state.task!.id,
    runId = controller.state.run!.id;
  const other = new TerminalController(new WorkflowClient({ baseUrl: address }));
  try {
    await other.initialize();
    await other.openSessionById(taskId);
    assert.equal(other.state.task?.id, taskId);
    assert.equal(other.state.run?.id, runId);
    assert.equal(other.browserUrl(), `${address}/#task=${taskId}`);
    await other.submit("/web");
    assert.equal(other.state.screen, "session");
    assert.match(other.state.detail, new RegExp(`workflow attach ${taskId}`));
    await other.submit(`/open run:${runId}`);
    assert.equal(other.state.task, undefined);
    assert.equal(other.state.run?.id, runId);
    assert.equal(other.browserUrl(), `${address}/#run=${runId}`);
    await other.submit("/reject");
    await controller.refresh();
    assert.equal(controller.state.run?.status, "rejected");
    await assert.rejects(other.openSessionById(crypto.randomUUID()), /not found in this project/);
    await assert.rejects(other.openSessionById("partial-id"), /full task or run ID/);
    assert.equal(other.state.run?.id, runId);
  } finally {
    await other.close();
  }
});

test("terminal setup attaches to a shared job and resumes only its unfinished stages after detaching", async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const { controller, app, address } = await context(t, {
    design: async (options) => {
      calls.push(options.scope);
      if (options.scope === "profiles")
        return {
          message: "Profiles saved",
          proposal: {
            scope: "profiles",
            summary: "Use an independent reviewer",
            coordinatorProfile: "",
            profiles: [
              {
                id: "reviewer",
                name: "Reviewer",
                description: "Review the result",
                enabled: true,
                agent: { provider: "test", model: "careful", thinking: "high" },
              },
            ],
          },
        };
      if (options.scope === "cases") {
        if (calls.filter((scope) => scope === "cases").length === 1) {
          entered.resolve();
          await release.promise;
          throw new Error("Transient setup fixture failure");
        }
        return {
          message: "Task instructions saved",
          proposal: {
            scope: "cases",
            summary: "Keep reusable task instructions",
            instructions: "Use focused handoffs",
            suggestBlocks: true,
            cases: options.settings.cases,
          },
        };
      }
      return {
        message: "Blocks validated",
        proposal: {
          scope: "blocks",
          summary: "Add a deterministic text helper",
          changes: {
            summary: "Normalize short notes",
            blocks: [
              {
                rationale: "No model request needed",
                bundle: bundleSchema.parse({
                  definition: {
                    id: "format-note",
                    name: "Format note",
                    description: "Trim a short note",
                    executor: {
                      kind: "code",
                      source:
                        'import {block,z} from "workflow";export default block({input:z.object({text:z.string()}),run(ctx){return ctx.input.text.trim();}});',
                    },
                  },
                  skills: [],
                }),
              },
            ],
          },
        },
      };
    },
  });
  const initial = await app.setup();
  await app.updateProjectModel({
    configRevision: initial.configRevision,
    agent: { provider: "test", model: "careful", thinking: "low" },
  });
  await controller.submit("/setup");
  assert.equal(controller.state.screen, "setup");
  assert.equal(controller.state.setupJob, undefined);
  assert.deepEqual(calls, [], "Opening setup is read-only");
  await controller.submit("/setup start --max-setup-cost 1");
  assert.equal(controller.state.error, "");
  await Promise.race([
    entered.promise,
    Bun.sleep(10_000).then(() => {
      throw new Error("Setup did not enter cases");
    }),
  ]);
  const jobId = controller.state.setupJob!.id;
  await controller.close();
  const other = new TerminalController(new WorkflowClient({ baseUrl: address }));
  try {
    await other.initialize();
    await other.submit(`/setup ${jobId}`);
    assert.equal(other.state.setupJob?.id, jobId);
    assert.equal(
      other.state.setupJob?.status,
      "running",
      "Detaching the first terminal must not cancel the job",
    );
    assert.equal(other.state.setupJob?.stages[0]?.status, "completed");
    release.resolve();
    await until(other, () => other.state.setupJob?.status === "failed");
    const scope = other.state.setupJob!.usageScopeId;
    await other.submit("/setup resume --max-setup-cost 2");
    assert.equal(other.state.error, "");
    await until(other, () => other.state.setupJob?.status === "completed");
    assert.deepEqual(calls, ["profiles", "cases", "cases", "blocks"]);
    assert.equal(other.state.setupJob?.usageScopeId, scope);
    assert.equal(other.state.setupJob?.maxSetupCostUsd, 2);
    assert.equal(other.state.setup?.completedSetup?.jobId, jobId);
    assert.equal(other.state.setupJob?.actions.canCancel, false);
    assert.equal(other.state.setupJob?.actions.canResume, false);
  } finally {
    release.resolve();
    await other.close();
  }
});

test("a terminal-started background engine survives both clients and is discovered on an ephemeral port", async (t) => {
  const { project, cleanup } = await fixture(t);
  const host = await connectTerminal({ project, port: 0, demo: true });
  cleanup(() => stopProjectHost(project, 0));
  assert.equal(host.owned, false);
  assert.equal(host.started, true);
  const response = await fetch(host.client.sessionUrl());
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html|Workflow API is ready/);
  const attached = await connectTerminal({ project, demo: true });
  assert.equal(attached.owned, false);
  assert.equal(attached.client.sessionUrl(), host.client.sessionUrl());
  await attached.close();
  await host.close();
  assert.equal((await host.client.project()).mode, "demo");
});

test("terminal login handles prompts without putting secrets into activity, and cancels sign-in on exit", async (t) => {
  let received = "";
  const auth = new BrowserAuth(async () =>
    authRuntime(async (_provider, _method, interaction) => {
      received = await interaction.prompt({ type: "secret", message: "API key" });
      return { type: "api_key", key: received };
    }),
  );
  const { controller } = await context(t, { auth });
  await controller.submit("/login test");
  await controller.choose("test/api_key");
  await until(controller, () => !!controller.state.auth?.prompt);
  await controller.respondAuth("fake-test-key-not-a-credential");
  await until(controller, () => controller.state.auth?.status === "succeeded");
  assert.equal(received, "fake-test-key-not-a-credential");
  assert.ok(!JSON.stringify(controller.state).includes(received));
  await controller.submit("/login test");
  await controller.choose("test/api_key");
  await until(controller, () => !!controller.state.auth?.prompt);
  await controller.close();
  for (let i = 0; i < 30 && auth.current()?.status === "pending"; i++) await Bun.sleep(10);
  assert.equal(auth.current()?.status, "cancelled");
});

test("draft refinement keeps streaming across refreshes, ignores unrelated activity, and can be cancelled", async (t) => {
  const entered = Promise.withResolvers<AbortSignal>();
  const { controller, app, library } = await context(t, {
    plan: async (options) => {
      options.emit?.("text_delta", "Checking the revised plan.");
      entered.resolve(options.signal);
      await new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => resolve(), { once: true });
        if (options.signal.aborted) resolve();
      });
      return { ...options.previousPlan!, title: "Must not be published" };
    },
  });
  await until(controller, () => controller.state.connected);
  app.engine.coordinatorActivity("text_delta", "Unrelated planning");
  await Bun.sleep(30);
  assert.deepEqual(controller.state.live, {});
  const draft = await app.engine.create(
    createTemplate("Refine this workflow", "feature", library),
    library,
  );
  await controller.openSession({ id: draft.id, kind: "run" });
  const work = controller.submit("Make review more thorough");
  try {
    const signal = await entered.promise;
    await until(controller, () =>
      Object.values(controller.state.live).includes("Checking the revised plan."),
    );
    await controller.refresh();
    assert.ok(Object.values(controller.state.live).includes("Checking the revised plan."));
    assert.ok(
      controller.state.events.some(
        (event) => event.kind === "user_message" && event.message === "Make review more thorough",
      ),
    );
    await controller.submit("/cancel");
    await work;
    for (let i = 0; !signal.aborted && i < 100; i++) await Bun.sleep(10);
    assert.equal(signal.aborted, true);
    assert.equal(app.getRun(draft.id).revision, draft.revision);
    assert.deepEqual(controller.state.live, {});
  } finally {
    await controller.close();
    await work;
  }
});
