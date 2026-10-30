import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { createApplication } from "../src/application.js";
import { MemoryStore } from "../src/memory-store.js";
import { fixture } from "./helpers.js";

test("ordinary execution collects only when enabled and deletion stays effective after a host restart", async t => {
  const { project, cleanup } = await fixture(t);
  let modelCalls = 0;
  const options = { project, mode: "live" as const, startTriggers: false,
    runner: async () => { modelCalls++; throw new Error("No AI request expected"); },
    providers: async () => [], catalog: async () => ({ models: [], warnings: [] }),
  };
  let app = await createApplication(options); cleanup(() => app.close());
  const memory = new MemoryStore(project);
  const source = 'import {workflow,step,block} from "workflow"; export default workflow({name:"Pure code report",flow:step("report",block({run(){return {checks:3};}}))});';
  const execute = async () => {
    const draft = await app.createProgram({ title: "Pure code report", task: "Produce a small report without a model", source });
    await app.approve(draft.id, draft.revision);
    for (let i = 0; i < 750; i++) {
      const run = app.getRun(draft.id);
      if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
        assert.equal(run.status, "completed", run.error);
        return run;
      }
      await Bun.sleep(20);
    }
    throw new Error("Report did not settle");
  };
  const observed = async () => {
    for (let i = 0; i < 250; i++) {
      const state = await memory.state();
      if (state.entries.length) return state;
      await Bun.sleep(20);
    }
    throw new Error("Completed run did not publish its memory observation");
  };
  await execute();
  assert.deepEqual((await memory.state()).entries, []);
  await assert.rejects(access(path.join(project, ".workflow", "memory", "state.json")));
  await memory.setEnabled({ revision: (await memory.state()).revision, enabled: true });
  const run = await execute();
  const state = await observed();
  assert.equal(state.entries.length, 1);
  const entry = await memory.get(state.entries[0]!.id);
  assert.equal(entry.kind, "observation");
  assert.equal(entry.observation!.runs, 1);
  assert.equal(entry.observation!.visits, 1);
  assert.equal(entry.observation!.model, null);
  assert.equal(entry.observation!.sessions, 0);
  assert.equal(entry.observation!.sources[0]!.runId, run.id);
  assert.ok(!entry.details.includes(source));
  await app.engine.remove(run.id);
  assert.equal((await memory.get(entry.id)).observation!.runs, 1, "Hiding run history must preserve compact memory and its receipt");
  await memory.remove(entry.id, { revision: state.revision });
  await app.close(); app = await createApplication(options);
  assert.deepEqual((await memory.state()).entries, [], "Restart must not resurrect deleted observations from retained runs");
  const later = await execute();
  const next = await observed();
  const laterEntry = await memory.get(next.entries[0]!.id);
  assert.notEqual(laterEntry.id, entry.id);
  assert.equal(laterEntry.observation!.runs, 1, "New facts must not reimport deleted historical counts");
  assert.equal(laterEntry.observation!.sources[0]!.runId, later.id);
  await memory.setEnabled({ revision: next.revision, enabled: false });
  await execute();
  assert.equal((await memory.get(laterEntry.id)).observation!.runs, 1);
  assert.deepEqual((await memory.descriptions()).entries, []);
  assert.equal(modelCalls, 0);
});
