import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../src/core/application.js";
import { createHttpServer } from "../src/http/http-server.js";
import { WorkflowClient, waitForRun } from "../src/client/client.js";
import { createCommandCapture } from "../src/infrastructure/command-output.js";
import { attemptDirectory } from "../src/core/storage/attempt-store.js";
import { fixture, passingRunner } from "./helpers.js";

test("history and output APIs preserve snapshots and scope transcripts to a recorded attempt", async (t) => {
  const { project, cleanup } = await fixture(t);
  const app = await createApplication({ project, mode: "demo", runner: passingRunner });
  cleanup(() => app.close());
  const server = await createHttpServer(app, 0);
  cleanup(() => server.close());
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  const client = new WorkflowClient({ baseUrl: address });
  const draft = await app.createProgram({
    title: "History",
    task: "Record a pure step",
    source: `import {workflow,block,step} from "workflow"; export default workflow({name:"History",flow:step("one",block({run(ctx){ctx.summary("Done"); return {ok:true};}}))});`,
  });
  await app.approve(draft.id, draft.revision);
  const run = await waitForRun(() => app.getRun(draft.id), { signal: AbortSignal.timeout(15000) });
  assert.equal(run.status, "completed", run.error ?? "");
  const snapshot = await client.execution(run.id);
  const history = await client.history(run.id, { asOf: snapshot.asOf, limit: 500 });
  assert.equal(history.asOf, snapshot.asOf);
  assert.equal(history.total, snapshot.total);
  const evidence = await client.reportEvidence(run.id);
  assert.equal(evidence.available, true);
  assert.equal(evidence.asOf, snapshot.asOf);
  assert.equal(evidence.total, snapshot.total);
  await assert.rejects(
    client.reportEvidence("00000000-0000-4000-8000-000000000000"),
    /Workflow not found/,
  );
  const capture = await createCommandCapture(attemptDirectory(project, run.id, "one", 1));
  capture.append("stdout", "first\n");
  capture.append("stderr", "warning\n");
  const ref = await capture.finish();
  const page = await client.commandOutput(run.id, "one", 1, ref.id, "output", { limit: 6 });
  assert.equal(page.text, "first\n");
  assert.equal(page.hasMore, true);
  const tail = await client.commandOutput(run.id, "one", 1, ref.id, "output", {
    offset: page.nextOffset,
  });
  assert.equal(tail.text, "warning\n");
  const download = await fetch(client.commandOutputUrl(run.id, "one", 1, ref.id, "output", true));
  assert.match(download.headers.get("content-disposition")!, /attachment/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await download.text(), "first\nwarning\n");
  await assert.rejects(client.commandOutput(run.id, "one", 2, ref.id), /Unknown execution attempt/);
  await assert.rejects(
    client.commandOutput(run.id, "missing", 1, ref.id),
    /Unknown execution attempt/,
  );
  await assert.rejects(client.history(run.id, { limit: 501 }));
  await assert.rejects(client.commandOutput(run.id, "one", 1, ".."));
});
