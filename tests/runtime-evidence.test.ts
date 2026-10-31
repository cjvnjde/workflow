import assert from "node:assert/strict";
import { test } from "vitest";
import {
  block,
  step,
  parallel,
  sequence,
  repeatUntil,
  describeFlow,
  type StepResult,
} from "../src/sdk/workflow-sdk.js";
import { executeFlow } from "../src/core/execution/composition-runtime.js";
import type { EvidenceDependency } from "../src/contracts/evidence-value.js";

const result = (data: unknown): StepResult => ({
  outcome: "pass",
  summary: "Done",
  artifacts: {},
  data,
});

test("named parallel handoffs retain JSON types and exact producer visits for both input and prompt reads", async () => {
  const frontend = step("frontend", block({ run: () => ({ files: ["ui.ts"], tests: 2 }) }));
  const backend = step("backend", block({ run: () => ({ files: ["api.ts"], tests: "3" }) }));
  const consumer = step("combine", block({ run: () => "combined" }), {
    inputs: (ctx) => ({ frontend: ctx.output(frontend), backend: ctx.output(backend) }),
    prompt: (ctx) => `Review ${ctx.result(frontend)?.summary}`,
  });
  const flow = sequence(parallel([frontend, backend], { concurrency: 2 }), consumer);
  const actualVisits: Record<string, number> = { frontend: 3, backend: 2, combine: 1 };
  let seen: unknown,
    dependencies: EvidenceDependency[] = [];
  await executeFlow({
    flow,
    structure: describeFlow(flow),
    input: {},
    request: "Inspect the join",
    models: {},
    visit: (id) => actualVisits[id]!,
    group: async () => {},
    step: async (node, options, _stopped, reads) => {
      if (node.id === "frontend") return result({ files: ["ui.ts"], tests: 2 });
      if (node.id === "backend") return result({ files: ["api.ts"], tests: "3" });
      seen = options.inputs;
      dependencies = reads;
      return result("combined");
    },
  });
  assert.deepEqual(seen, {
    frontend: { files: ["ui.ts"], tests: 2 },
    backend: { files: ["api.ts"], tests: "3" },
  });
  assert.deepEqual(dependencies, [
    { producerNodeId: "frontend", producerVisit: 3, kind: "result", usedBy: "prompt" },
    { producerNodeId: "frontend", producerVisit: 3, kind: "output", usedBy: "inputs" },
    { producerNodeId: "backend", producerVisit: 2, kind: "output", usedBy: "inputs" },
  ]);
});

test("parallel branch provenance never sees sibling partial results and loop visits remain separate", async () => {
  const producer = step("producer", block({ run: () => 1 }));
  const observer = step("observer", block({ run: () => 1 }), {
    inputs: (ctx) => ({ sibling: ctx.output(producer) }),
  });
  const consumer = step("consumer", block({ run: () => 1 }), {
    inputs: (ctx) => ({ producer: ctx.output(producer), observer: ctx.output(observer) }),
  });
  const flow = repeatUntil("repeat", {
    body: sequence(parallel([producer, observer], { concurrency: 1 }), consumer),
    until: (ctx) => ctx.iteration("repeat") === 2,
    maxIterations: 2,
  });
  const visits = new Map<string, number>();
  const snapshots: { id: string; values: unknown; reads: EvidenceDependency[] }[] = [];
  await executeFlow({
    flow,
    structure: describeFlow(flow),
    input: {},
    request: "Inspect visits",
    models: {},
    group: async () => {},
    visit: (id) => visits.get(id)!,
    step: async (node, options, _stopped, reads) => {
      visits.set(node.id, (visits.get(node.id) ?? 0) + (node.id === "producer" ? 2 : 1));
      snapshots.push({ id: node.id, values: options.inputs, reads });
      return result(visits.get(node.id));
    },
  });
  const observations = snapshots.filter((value) => value.id === "observer");
  assert.deepEqual(
    observations.map((value) => value.values),
    [{ sibling: undefined }, { sibling: 2 }],
  );
  assert.deepEqual(
    observations.map((value) => value.reads[0]?.producerVisit),
    [null, 2],
  );
  const consumers = snapshots.filter((value) => value.id === "consumer");
  assert.deepEqual(
    consumers.map((value) => value.values),
    [
      { producer: 2, observer: 1 },
      { producer: 4, observer: 2 },
    ],
  );
  assert.deepEqual(
    consumers.map((value) => value.reads.map((read) => read.producerVisit)),
    [
      [2, 1],
      [4, 2],
    ],
  );
});

test("input previews distinguish literals and deferred callbacks without invoking callbacks or custom toString", () => {
  let called = false;
  const deferred = () => {
    called = true;
    throw new Error("Must not execute during preview");
  };
  deferred.toString = () => {
    called = true;
    throw new Error("Custom toString must not run");
  };
  const flow = sequence(
    step("literal", block({ run: () => "" }), {
      inputs: { number: 2, text: "2" },
      prompt: "Read this",
    }),
    step("deferred", block({ run: () => "" }), { inputs: deferred, prompt: deferred }),
  );
  const preview = describeFlow(flow, { evidence: true });
  assert.equal(called, false);
  assert.deepEqual(preview.children[0]?.step?.inputPreview, {
    kind: "literal",
    value: { state: "json", value: { number: 2, text: "2" } },
  });
  assert.equal(preview.children[1]?.step?.inputPreview?.kind, "deferred");
  assert.match(preview.children[1]!.step!.inputPreview!.expression!, /Must not execute/);
  assert.equal(preview.children[1]?.step?.promptPreview?.truncated, false);
  const legacy = describeFlow(flow);
  assert.equal(
    legacy.children[0]?.step?.inputPreview,
    undefined,
    "Legacy canonical structure retains its original shape",
  );
  assert.equal(legacy.children[1]?.step?.options.inputs, undefined);
});

test("prompt and input callbacks retain their shared context and original evaluation order", async () => {
  let promptContext: unknown, observed: unknown;
  const flow = step("shared", block({ run: () => "done" }), {
    prompt: (ctx) => {
      promptContext = ctx;
      (ctx.input.nested as { value: string }).value = "from prompt";
      return "Inspect";
    },
    inputs: (ctx) => {
      assert.equal(ctx, promptContext);
      return { value: (ctx.input.nested as { value: string }).value };
    },
  });
  const input = { nested: { value: "original" } };
  await executeFlow({
    flow,
    structure: describeFlow(flow),
    input,
    request: "Preserve behavior",
    models: {},
    group: async () => {},
    step: async (_node, options) => {
      observed = options.inputs;
      return result("done");
    },
  });
  assert.deepEqual(observed, { value: "from prompt" });
  assert.deepEqual(
    input,
    { nested: { value: "original" } },
    "The original workflow input remains isolated from callback copies",
  );
});
