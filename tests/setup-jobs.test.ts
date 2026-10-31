import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vitest";
import { SetupJobs } from "../src/core/setup/setup-jobs.js";
import { bundleSchema } from "../src/contracts/domain.js";
import { emptyUsage } from "../src/core/execution/budget.js";
import type { AvailableModel } from "../src/contracts/library-editor-schema.js";
import type { designSettings } from "../src/core/design/settings-designer.js";
import { publishSetup } from "../src/core/settings/settings-publication.js";
import { UsageStore } from "../src/core/storage/usage-store.js";
import { fixture } from "./helpers.js";
import { WorkflowEngine } from "../src/core/engine.js";
import { attachApplication } from "../src/core/application.js";
import { createHttpServer } from "../src/http/http-server.js";

const model = { provider: "fixture", model: "small", thinking: "low" as const };
const models: AvailableModel[] = [
  {
    provider: model.provider,
    id: model.model,
    name: "Small",
    reasoning: true,
    thinkingLevels: ["low"],
    contextWindow: 32000,
    maxTokens: 4000,
    cost: null,
  },
];
const catalog = async () => ({ models, warnings: [] });
const design: typeof designSettings = async (options) => {
  if (options.scope === "profiles")
    return {
      message: "Profiles",
      proposal: {
        scope: "profiles",
        summary: "One economical role",
        coordinatorProfile: "",
        profiles: [
          {
            id: "simple",
            name: "Simple",
            description: "Routine work",
            enabled: true,
            agent: model,
          },
        ],
      },
    };
  if (options.scope === "cases")
    return {
      message: "Cases",
      proposal: {
        scope: "cases",
        summary: "Existing task presets",
        instructions: "Use focused evidence",
        cases: options.settings.cases,
        suggestBlocks: true,
      },
    };
  return {
    message: "Blocks",
    proposal: {
      scope: "blocks",
      summary: "A deterministic formatter",
      changes: {
        summary: "Add a reusable formatter",
        blocks: [
          {
            rationale: "No model needed",
            bundle: bundleSchema.parse({
              definition: {
                id: "format",
                name: "Format",
                description: "A deterministic formatter",
                executor: {
                  kind: "code",
                  source:
                    'import {block} from "workflow"; export default block({run(){return "formatted";}});',
                },
              },
              skills: [],
            }),
          },
        ],
      },
    },
  };
};
async function configured(project: string) {
  const file = path.join(project, ".workflow/config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...config, agent: model }));
}
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Setup state did not settle");
}

test("a failed stage resumes after host restart without repeating accepted stages or changing identity", async (t) => {
  const { project, cleanup } = await fixture(t);
  await configured(project);
  const calls: string[] = [];
  let fail = true;
  const designer: typeof designSettings = async (options) => {
    calls.push(options.scope);
    if (options.scope === "cases" && fail) throw new Error("Provider disconnected");
    return design(options);
  };
  const first = new SetupJobs(project, { catalog, design: designer });
  await first.initialize();
  cleanup(() => first.close());
  const started = await first.start();
  assert.equal((await first.start()).id, started.id, "Multiple clients attach to one job");
  const failed = await first.wait(started.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.stages[0]?.status, "completed");
  await first.close();
  const restored = new SetupJobs(project, { catalog, design: designer });
  await restored.initialize();
  cleanup(() => restored.close());
  assert.deepEqual(calls, ["profiles", "cases"], "Host restart never makes model calls");
  assert.equal(
    (await restored.start()).status,
    "failed",
    "Ordinary start attaches; retry is explicit",
  );
  fail = false;
  await restored.resume(started.id, { revision: restored.get(started.id).revision });
  const done = await restored.wait(started.id);
  assert.equal(done.status, "completed", done.error ?? "");
  assert.equal(done.usageScopeId, started.usageScopeId);
  assert.deepEqual(calls, ["profiles", "cases", "cases", "blocks"]);
  assert.equal((await restored.completed())?.jobId, started.id);
});

test("host shutdown interrupts a running stage and explicit resume retains previous checkpoints", async (t) => {
  const { project, cleanup } = await fixture(t);
  await configured(project);
  const calls: string[] = [];
  let wait = true;
  const designer: typeof designSettings = async (options) => {
    calls.push(options.scope);
    if (options.scope === "blocks" && wait)
      await delay(20_000, undefined, { signal: options.signal });
    return design(options);
  };
  const first = new SetupJobs(project, { catalog, design: designer });
  await first.initialize();
  cleanup(() => first.close());
  const job = await first.start();
  await until(() => calls.includes("blocks"));
  await first.close();
  assert.equal(first.get(job.id).status, "interrupted");
  const second = new SetupJobs(project, { catalog, design: designer });
  await second.initialize();
  cleanup(() => second.close());
  assert.deepEqual(calls, ["profiles", "cases", "blocks"]);
  wait = false;
  await second.resume(job.id, { revision: second.get(job.id).revision });
  assert.equal((await second.wait(job.id)).status, "completed");
  assert.deepEqual(calls, ["profiles", "cases", "blocks", "blocks"]);
});

test("cancellation while an accepted checkpoint is being persisted keeps that stage for resume", async (t) => {
  const { project, cleanup } = await fixture(t);
  await configured(project);
  const calls: string[] = [];
  const jobs = new SetupJobs(project, {
    catalog,
    design: async (options) => {
      calls.push(options.scope);
      return design(options);
    },
  });
  await jobs.initialize();
  cleanup(() => jobs.close());
  const save = jobs["save"].bind(jobs);
  let entered = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  jobs["save"] = async (record) => {
    if (!entered && record.accepted.profiles && record.stage === "profiles") {
      entered = true;
      await gate;
    }
    return save(record);
  };
  cleanup(async () => {
    release();
  });
  const job = await jobs.start();
  await until(() => entered);
  const cancelled = jobs.cancel(job.id, { revision: jobs.get(job.id).revision });
  release();
  await cancelled;
  assert.equal(jobs.get(job.id).status, "cancelled");
  assert.equal(jobs.get(job.id).stages[0]?.status, "completed");
  await jobs.resume(job.id, { revision: jobs.get(job.id).revision });
  assert.equal((await jobs.wait(job.id)).status, "completed");
  assert.deepEqual(calls, ["profiles", "cases", "blocks"]);
});

test("an explicit resume budget increase keeps previous spending and avoids regenerating paid stages", async (t) => {
  const { project, cleanup } = await fixture(t);
  await configured(project);
  const calls: string[] = [];
  const jobs = new SetupJobs(project, {
    catalog,
    design: async (options) => {
      const session = await new UsageStore(project).beginSession(
        options.accounting!,
        {
          ...model,
          pricing: {
            source: "catalog",
            rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        },
        options.signal,
      );
      calls.push(options.scope);
      await session.update({ ...emptyUsage(), requests: 1, costUsd: 0.06 });
      await session.finish("completed");
      session.release();
      return design(options);
    },
  });
  await jobs.initialize();
  cleanup(() => jobs.close());
  const job = await jobs.start({ maxSetupCostUsd: 0.1 });
  assert.equal((await jobs.wait(job.id)).status, "failed");
  await assert.rejects(
    jobs.resume(job.id, { revision: jobs.get(job.id).revision, maxSetupCostUsd: 0.05 }),
    /cannot be lower/,
  );
  await jobs.resume(job.id, { revision: jobs.get(job.id).revision, maxSetupCostUsd: 0.3 });
  assert.equal((await jobs.wait(job.id)).status, "completed");
  assert.deepEqual(calls, ["profiles", "cases", "blocks"]);
  const usage = await jobs.usage(job.id);
  assert.equal(usage.total.costUsd, 0.18);
  assert.equal(usage.limits.totalCostUsd, 0.3);
  assert.equal(jobs.get(job.id).usageScopeId, job.usageScopeId);
});

test("failed regeneration preserves earlier completion and prepublication conflict permits a new job", async (t) => {
  const { project, cleanup } = await fixture(t);
  await configured(project);
  let conflict = false;
  const jobs: SetupJobs = new SetupJobs(project, {
    catalog,
    design,
    publish: async (...args) => {
      if (conflict)
        throw new Error(
          "Project settings changed during setup. Regenerate against current settings.",
        );
      assert.equal(
        jobs.get(args[1].jobId).actions.canCancel,
        false,
        "Publication has a clear non-cancellable boundary",
      );
      return publishSetup(...args);
    },
  });
  await jobs.initialize();
  cleanup(() => jobs.close());
  const original = await jobs.start();
  assert.equal((await jobs.wait(original.id)).status, "completed");
  conflict = true;
  const second = await jobs.start({ regenerate: true });
  assert.equal((await jobs.wait(second.id)).status, "conflicted");
  assert.equal((await jobs.completed())?.jobId, original.id);
  const third = await jobs.start({ regenerate: true });
  assert.notEqual(third.id, second.id);
  await jobs.wait(third.id);
});

test("legacy completed setup imports its original accounting scope without requesting generation", async (t) => {
  const { project, cleanup } = await fixture(t);
  await configured(project);
  const scopeId = randomUUID(),
    store = new UsageStore(project);
  await store.ensureScope({ owner: { kind: "setup", id: scopeId } });
  const session = await store.beginSession(
    { project, scopeId, phase: "setup", operationId: "legacy" },
    {
      ...model,
      pricing: { source: "catalog", rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    },
    AbortSignal.timeout(5000),
  );
  await session.update({ ...emptyUsage(), requests: 1, costUsd: 0.2 });
  await session.finish("completed");
  session.release();
  await writeFile(
    path.join(project, ".workflow/setup.json"),
    JSON.stringify({
      version: 1,
      completedAt: new Date().toISOString(),
      model,
      libraryProposalId: randomUUID(),
      usageScopeId: scopeId,
    }),
  );
  const jobs = new SetupJobs(project, {
    catalog: async () => {
      throw new Error("Must not call provider");
    },
  });
  await jobs.initialize();
  cleanup(() => jobs.close());
  const imported = await jobs.start();
  assert.equal(imported.status, "completed");
  assert.equal(imported.usageScopeId, scopeId);
  assert.equal((await jobs.usage(imported.id)).total.costUsd, 0.2);
});

test("a committed publication recovers its completion marker after restart without model calls", async (t) => {
  const { project, cleanup } = await fixture(t);
  await configured(project);
  const jobs = new SetupJobs(project, { catalog, design });
  await jobs.initialize();
  cleanup(() => jobs.close());
  const job = await jobs.start();
  assert.equal((await jobs.wait(job.id)).status, "completed");
  await jobs.close();
  const filename = path.join(project, ".workflow/setup-jobs", `${job.id}.json`);
  const record = JSON.parse(await readFile(filename, "utf8"));
  record.status = "running";
  record.result = undefined;
  record.stages.at(-1).status = "running";
  await writeFile(filename, JSON.stringify(record));
  await rm(path.join(project, ".workflow/setup.json"));
  const restored = new SetupJobs(project, {
    catalog: async () => {
      throw new Error("Must not request models");
    },
    design: async () => {
      throw new Error("Must not regenerate");
    },
  });
  await restored.initialize();
  cleanup(() => restored.close());
  assert.equal(restored.get(job.id).status, "completed");
  assert.equal((await restored.completed())?.jobId, job.id);
});

test("a setup model override stays frozen for every stage and becomes the default only on publication", async (t) => {
  const { project, cleanup } = await fixture(t);
  await configured(project);
  const other = { ...model, model: "careful" };
  const seen: string[] = [];
  let release!: () => void,
    entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const jobs = new SetupJobs(project, {
    catalog: async () => ({
      models: [...models, { ...models[0]!, id: other.model }],
      warnings: [],
    }),
    design: async (options) => {
      seen.push(options.library.config.agent.model!);
      if (options.scope === "profiles") {
        entered = true;
        await gate;
      }
      return design(options);
    },
  });
  await jobs.initialize();
  cleanup(() => jobs.close());
  cleanup(async () => {
    release();
  });
  const job = await jobs.start({ model: other });
  await until(() => entered);
  const configFile = path.join(project, ".workflow/config.json");
  assert.equal(JSON.parse(await readFile(configFile, "utf8")).agent.model, model.model);
  await assert.rejects(jobs.start({ model }), /frozen/);
  assert.equal((await jobs.start()).id, job.id);
  release();
  assert.equal((await jobs.wait(job.id)).status, "completed");
  assert.deepEqual(seen, [other.model, other.model, other.model]);
  assert.equal(JSON.parse(await readFile(configFile, "utf8")).agent.model, other.model);
});

test("demo setup endpoints refuse generation and resume before contacting models while status remains readable", async (t) => {
  const { project, cleanup } = await fixture(t);
  let modelCalls = 0;
  const app = await attachApplication(
    new WorkflowEngine(project, "demo", async () => {
      throw new Error("This test must not execute a workflow");
    }),
    {
      startTriggers: false,
      catalog: async () => {
        modelCalls++;
        throw new Error("Demo must not contact model catalog for setup");
      },
      design: async () => {
        modelCalls++;
        throw new Error("Demo must not generate setup");
      },
    },
  );
  cleanup(() => app.close());
  const server = await createHttpServer(app, 0);
  cleanup(() => server.close());
  const headers = { host: "localhost", "x-workflow-client": "1" };
  for (const url of ["/api/setup-jobs", `/api/setup-jobs/${randomUUID()}/resume`]) {
    const response = await server.inject({ method: "POST", url, headers, payload: {} });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /live mode/);
  }
  assert.equal(modelCalls, 0);
  const state = await server.inject({ method: "GET", url: "/api/setup-jobs/latest", headers });
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json(), { job: null });
});
