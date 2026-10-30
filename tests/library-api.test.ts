import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowEngine } from "../src/core/engine.js";
import { createServer } from "../src/http/server.js";
import { createTemplate } from "../src/core/library/templates.js";
import { loadLibrary } from "../src/core/library/library.js";
import {
  libraryProposalSchema,
  type AvailableModel,
} from "../src/contracts/library-editor-schema.js";
import { fixture, passingRunner } from "./helpers.js";

const headers = { host: "127.0.0.1:4310", "x-workflow-client": "1" };
const models: AvailableModel[] = [
  {
    provider: "test",
    id: "reasoner",
    name: "Test reasoner",
    reasoning: true,
    thinkingLevels: ["off", "medium", "high"],
    contextWindow: 100_000,
    maxTokens: 8000,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  },
];

test("live API generates reviewed block proposals from the allowed catalog without altering existing runs", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const original = await engine.create(createTemplate("Feature", "feature", library), library);
  const server = await createServer(engine, 4310, {
    catalog: async (_signal, refresh) => ({ models, warnings: refresh ? ["Test refresh"] : [] }),
    generateLibrary: async (options) => {
      assert.equal(options.models.length, 1);
      assert.equal(options.instructions, "Use stronger review");
      const bundle = structuredClone(options.library.blocks.review!);
      bundle.prompt = "Review requirements carefully with independent evidence.";
      bundle.definition.agent = { provider: "test", model: "reasoner", thinking: "high" };
      return {
        summary: "Improve independent review",
        blocks: [{ bundle, rationale: "Use reasoning for difficult code review" }],
      };
    },
  });
  cleanup(() => server.close());
  assert.equal(
    (await server.inject({ method: "GET", url: "/api/models", headers })).json().models[0].id,
    "reasoner",
  );
  assert.deepEqual(
    (
      await server.inject({ method: "POST", url: "/api/models/refresh", headers, payload: {} })
    ).json().warnings,
    ["Test refresh"],
  );
  const generated = await server.inject({
    method: "POST",
    url: "/api/library/proposals",
    headers,
    payload: {
      kind: "regenerate",
      instructions: "Use stronger review",
      allowedModels: ["test/reasoner"],
    },
  });
  assert.equal(generated.statusCode, 200, generated.body);
  const proposal = libraryProposalSchema.parse(generated.json());
  assert.equal((await loadLibrary(project)).blocks.review!.prompt, library.blocks.review!.prompt);
  const applied = await server.inject({
    method: "POST",
    url: `/api/library/proposals/${proposal.id}/apply`,
    headers,
    payload: {},
  });
  assert.equal(applied.statusCode, 200, applied.body);
  const updated = await loadLibrary(project);
  assert.equal(updated.blocks.review!.definition.agent!.thinking, "high");
  assert.equal(engine.get(original.id).blocks.review!.prompt, library.blocks.review!.prompt);
  const next = await engine.create(createTemplate("Next feature", "feature", updated), updated);
  assert.equal(next.blocks.review!.prompt, updated.blocks.review!.prompt);
  const unavailable = await server.inject({
    method: "POST",
    url: "/api/library/proposals",
    headers,
    payload: { kind: "models", allowedModels: ["test/missing"] },
  });
  assert.equal(unavailable.statusCode, 409);
  assert.match(unavailable.json().error, /unavailable/);
});

test("AI refinement preserves draft snapshots and refuses to overwrite concurrent edits", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = await createServer(engine, 4310, {
    catalog: async () => ({ models, warnings: [] }),
    plan: async (options) => {
      assert.ok(options.previousPlan);
      assert.equal(options.library.blocks.review!.prompt, library.blocks.review!.prompt);
      if (options.instructions === "Slow edit") {
        entered!();
        await hold;
      }
      const plan = structuredClone(options.previousPlan);
      plan.title = "AI-refined graph";
      return plan;
    },
  });
  cleanup(() => server.close());
  const run = await engine.create(createTemplate("Feature", "feature", library), library);
  const successful = await server.inject({
    method: "POST",
    url: `/api/runs/${run.id}/refine`,
    headers,
    payload: { instructions: "Improve review" },
  });
  assert.equal(successful.statusCode, 200, successful.body);
  assert.equal(engine.get(run.id).plan.title, "AI-refined graph");
  assert.equal(engine.get(run.id).status, "draft");
  const slow = server.inject({
    method: "POST",
    url: `/api/runs/${run.id}/refine`,
    headers,
    payload: { instructions: "Slow edit" },
  });
  await started;
  const current = engine.get(run.id);
  const edited = await server.inject({
    method: "PUT",
    url: `/api/runs/${run.id}/plan`,
    headers,
    payload: { ...current.plan, title: "Manual graph change" },
  });
  assert.equal(edited.statusCode, 200);
  release!();
  const conflict = await slow;
  assert.equal(conflict.statusCode, 409);
  assert.match(conflict.json().error, /changed since you loaded it/);
  assert.equal(engine.get(run.id).plan.title, "Manual graph change");
});

test("demo API supports manual block review but does not simulate AI library generation", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "demo", passingRunner);
  const server = await createServer(engine, 4310, {
    catalog: async () => ({ models: [], warnings: [] }),
  });
  cleanup(() => server.close());
  const bundle = structuredClone(library.blocks.review!);
  bundle.prompt = "User's precise review instructions";
  const manual = await server.inject({
    method: "POST",
    url: "/api/library/proposals",
    headers,
    payload: {
      kind: "manual",
      changes: {
        summary: "Manual review change",
        blocks: [{ bundle, rationale: "User preference" }],
      },
    },
  });
  assert.equal(manual.statusCode, 200, manual.body);
  const discarded = await server.inject({
    method: "POST",
    url: `/api/library/proposals/${manual.json().id}/reject`,
    headers,
    payload: {},
  });
  assert.equal(discarded.json().status, "rejected");
  assert.equal((await loadLibrary(project)).blocks.review!.prompt, library.blocks.review!.prompt);
  const ai = await server.inject({
    method: "POST",
    url: "/api/library/proposals",
    headers,
    payload: { kind: "regenerate" },
  });
  assert.equal(ai.statusCode, 409);
  assert.match(ai.json().error, /needs live mode/);
});
