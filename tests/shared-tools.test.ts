import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { WorkflowEngine } from "../src/engine.js";
import { localExecutionEnvironment } from "../src/execution-environment.js";
import { WorkflowVersions } from "../src/workflow-versions.js";
import { executeTool, describeTools } from "../src/tool-runner.js";
import { compileProgram, checkProgram } from "../src/program-compiler.js";
import { describeActivity } from "../web/activity.js";
import { activityCard } from "../src/tui/presentation.js";
import { fixture, passingRunner } from "./helpers.js";
import { runPiBlock } from "../src/block-runner.js";
import { userPaths } from "../src/user-settings.js";
import { waitForRun } from "../src/client.js";

const reader = `
const readSource = defineTool({name:"read_source",description:"Read source",replay:"safe",input:z.object({path:z.string()}),output:z.object({text:z.string()}),
  async execute(input,ctx){ctx.summary("Source inspected");ctx.details({path:input.path});ctx.present({card:"file-read",path:input.path,title:"Captured source"});return {text:prefix+await ctx.env.readText(input.path)};}});
`;

test("shared tools retain frozen imports, typed outputs, journaled writes and structured activity", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await writeFile(
    path.join(project, "helper.ts"),
    'export const prefix="reviewed:";',
  );
  await writeFile(path.join(project, "input.txt"), "source");
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source = `import {workflow,block,defineTool,step,z} from "workflow"; import {prefix} from "./helper.ts"; ${reader}
    const writeReport=defineTool({name:"write_report",description:"Save report",input:z.object({text:z.string()}),output:z.string(),
      async execute(input,ctx){await ctx.env.writeText("report.txt",input.text);return "Saved";}});
    export default workflow({name:"Shared tools",flow:step("inspect",block({async run(ctx){
      const result=await ctx.call(readSource,{path:"input.txt"}); await ctx.call(writeReport,result);return result;
    }}))});`;
  const draft = await engine.createProgram(
    "Shared tools",
    "Inspect source",
    { source },
    library,
  );
  await writeFile(
    path.join(project, "helper.ts"),
    'export const prefix="changed:";',
  );
  await engine.approve(draft.id);
  await waitForRun(() => engine.get(draft.id), {
    signal: AbortSignal.timeout(20_000),
  });
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(
    await readFile(path.join(project, "report.txt"), "utf8"),
    "reviewed:source",
  );
  const events = await engine.events(run.id);
  const read = events.find(
    (e) =>
      e.operation?.name === "read_source" && e.operation.state === "completed",
  );
  assert.ok(read?.operation);
  assert.deepEqual(read.operation.output, { text: "reviewed:source" });
  assert.deepEqual(read.operation.presentation, { card: "file-read", path: "input.txt", title: "Captured source" });
  assert.ok(
    events.some(
      (e) =>
        e.operation?.parentId === read.operation!.id &&
        e.operation.kind === "read",
    ),
  );
  assert.equal(
    describeActivity({ ...read, message: "unstructured text is irrelevant" })
      .state,
    "completed",
  );
  assert.match(
    activityCard({ ...read, message: "unstructured text is irrelevant" })!.body,
    /reviewed:source/,
  );
  assert.throws(
    () =>
      checkProgram(project, {
        source: source.replace('{path:"input.txt"}', "{path:42}"),
      }),
    /number/,
  );
});

test("read-only tools retry transient failures; unsafe tools retain the explicit recovery boundary", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  let calls = 0;
  const engine = new WorkflowEngine(
    project,
    "live",
    passingRunner,
    {},
    async (options) => {
      const env = await localExecutionEnvironment(options);
      return {
        ...env,
        readText: async () => {
          if (++calls === 1) throw new Error("Temporary read failure");
          return "Recovered";
        },
      };
    },
  );
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source = `import {workflow,block,defineTool,step,z} from "workflow"; const prefix="";${reader}
    export default workflow({name:"Retry",flow:step("read",block({run:ctx=>ctx.call(readSource,{path:"file"})}))});`;
  const draft = await engine.createProgram(
    "Retry",
    "Read",
    { source },
    library,
  );
  await engine.approve(draft.id);
  await waitForRun(() => engine.get(draft.id), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(
    engine.get(draft.id).status,
    "completed",
    engine.get(draft.id).error,
  );
  assert.equal(calls, 2);
  calls = 0;
  await writeFile(path.join(project, "attempt.txt"), "original");
  const unsafe = await engine.createProgram(
    "Unsafe",
    "Read",
    {
      source: source
        .replace('replay:"safe"', 'replay:"unsafe"')
        .replace(
          'ctx.summary("Source inspected")',
          'await ctx.env.writeText("attempt.txt", "changed");ctx.summary("Source inspected")',
        ),
    },
    library,
  );
  await engine.approve(unsafe.id);
  for (
    let i = 0;
    i < 200 && engine.get(unsafe.id).status !== "interrupted";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(engine.get(unsafe.id).status, "interrupted");
  assert.equal(calls, 1);
  assert.equal(
    await readFile(path.join(project, "attempt.txt"), "utf8"),
    "original",
    "an interrupted attempt restores managed writes",
  );
  await engine.resume(unsafe.id);
  for (
    let i = 0;
    i < 200 && engine.get(unsafe.id).status === "interrupted";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  await waitForRun(() => engine.get(unsafe.id), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(
    engine.get(unsafe.id).status,
    "completed",
    engine.get(unsafe.id).error,
  );
  assert.equal(
    await readFile(path.join(project, "attempt.txt"), "utf8"),
    "changed",
  );
});

test("restarting a paused workflow retains completed shared-tool calls in history", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await writeFile(path.join(project, "input.txt"), "original");
  let reads = 0;
  const environment: import("../src/execution-environment.js").ExecutionEnvironmentFactory =
    async (options) => {
      const local = await localExecutionEnvironment(options);
      return {
        ...local,
        readText: async (filename) => {
          reads++;
          if (reads === 1)
            await new Promise((resolve) => setTimeout(resolve, 400));
          return local.readText(filename);
        },
      };
    };
  const engine = new WorkflowEngine(
    project,
    "live",
    passingRunner,
    {},
    environment,
  );
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source = `import {workflow,block,defineTool,step,sequence,z} from "workflow"; const prefix=""; ${reader}
    const inspect = block({run:ctx=>ctx.call(readSource,{path:"input.txt"})});
    export default workflow({name:"Restart tools",flow:sequence(step("first",inspect),step("second",inspect))});`;
  const draft = await engine.createProgram(
    "Restart tools",
    "Read twice",
    { source },
    library,
  );
  await engine.approve(draft.id);
  for (let i = 0; i < 200 && reads === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(reads, 1);
  await engine.pause(draft.id);
  const paused = await waitForRun(() => engine.get(draft.id), {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(paused.status, "paused");
  await engine.shutdown();
  await writeFile(path.join(project, "input.txt"), "changed after first call");
  const resumed = new WorkflowEngine(
    project,
    "live",
    passingRunner,
    {},
    environment,
  );
  cleanup(() => resumed.shutdown());
  await resumed.initialize();
  await resumed.resume(draft.id);
  for (let i = 0; i < 200 && resumed.get(draft.id).status === "paused"; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const run = await waitForRun(() => resumed.get(draft.id), {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(run.status, "completed", run.error);
  assert.equal(
    reads,
    2,
    "completed tool must not run again after reconnecting",
  );
  assert.deepEqual(
    run.attempts.map((attempt) => JSON.parse(attempt.result!.artifacts.data!)),
    [{ text: "original" }, { text: "changed after first call" }],
  );
});

test("tool host validates schemas, limits effects, and cancels a busy worker and its environment", async (t) => {
  const { project, library } = await fixture(t);
  const versions = new WorkflowVersions(
    path.join(project, ".workflow", "versions"),
  );
  const source = `import {workflow,block,defineTool,step,z} from "workflow";
    const tool=defineTool({name:"bounded",description:"Test limits",replay:"safe",timeoutMs:200,input:z.object({action:z.string()}),output:z.string(),
      async execute({action},ctx){
        if(action==="write") await ctx.env.writeText("forbidden.txt","bad");
        if(action==="loop") {await ctx.env.readText("file");while(true){}}
        if(action==="unawaited") {void ctx.env.readText("slow");return "bad";}
        if(action==="invalid") return 42 as any;
        if(action==="bad-card") {await ctx.env.readText("file");ctx.present({card:"unknown"} as any);}
        if(action==="large-card") {await ctx.env.readText("file");ctx.present({card:"command",output:"x".repeat(100000)});}
        return "ok";
      }});
    export default workflow({name:"Bounded",flow:step("test",block({run:ctx=>ctx.call(tool,{action:"ok"})}))});`;
  const built = await compileProgram(
    project,
    { source },
    versions,
    library.blocks,
  );
  const version = await versions.load(built.version.id);
  const reference = { name: "bounded", version: 1, replay: "safe" as const };
  const descriptors = await describeTools(
    version.toolsPath!,
    [reference],
    AbortSignal.timeout(5000),
  );
  assert.equal(descriptors[0]?.input.type, "object");
  let effects = 0,
    aborted = false;
  const invoke = (input: unknown) =>
    executeTool({
      codePath: version.toolsPath!,
      tool: reference,
      input,
      callId: "test-call",
      request: "Test",
      signal: AbortSignal.timeout(5000),
      record: async () => {},
      environment: async (signal) => ({
        id: "test",
        readText: async (name) => {
          effects++;
          if (name === "slow")
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              ),
            );
          return "data";
        },
        writeText: async () => {
          throw new Error("Must not reach write");
        },
        exec: async () => {
          throw new Error("Must not reach exec");
        },
      }),
    });
  await assert.rejects(invoke({ action: 42 }), /string/);
  assert.equal(effects, 0);
  for (const action of ["bad-card", "large-card"]) {
    const count: number = effects;
    const result = await invoke({ action });
    assert.equal(result.data, "ok");
    assert.equal(result.presentation, undefined);
    assert.equal(effects, count + 1, "invalid presentation must not repeat a completed effect");
  }
  await assert.rejects(invoke({ action: "invalid" }), /string/);
  await assert.rejects(invoke({ action: "write" }), /only read/);
  await assert.rejects(invoke({ action: "unawaited" }), /Await every/);
  assert.equal(aborted, true);
  const started = Date.now();
  await assert.rejects(invoke({ action: "loop" }), /timed out/);
  assert.ok(
    Date.now() - started < 4000,
    "a tool must not block the engine event loop",
  );
  await writeFile(version.toolsPath!, "corrupt");
  await assert.rejects(versions.load(built.version.id), /corrupt/);
});

test("AI adapter and deterministic calls share the frozen tool", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await writeFile(path.join(project, "input.txt"), "content");
  const calls: string[] = [];
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    assert.equal(execution.tools, "selected");
    const tools = await execution.customTools!();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["read_source"],
    );
    const result = await tools[0]!.execute(
      "model-call",
      { path: "input.txt" },
      execution.signal,
      undefined,
      {} as never,
    );
    calls.push(JSON.stringify(result));
    return { outcome: "pass", summary: "Reviewed", artifacts: {} };
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source = `import {workflow,block,defineTool,step,z} from "workflow"; const prefix="frozen:"; ${reader}
    export default workflow({name:"AI tools",flow:step("review",block({async run(ctx){
      const data=await ctx.call(readSource,{path:"input.txt"});
      return ctx.ai({role:"review",tools:[readSource],prompt:"Review "+data.text});
    }}))});`;
  const draft = await engine.createProgram(
    "AI tools",
    "Review",
    { source },
    library,
  );
  await engine.approve(draft.id);
  await waitForRun(() => engine.get(draft.id), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(
    engine.get(draft.id).status,
    "completed",
    engine.get(draft.id).error,
  );
  assert.match(calls[0]!, /frozen:content/);
});

test("real Pi session uses the selected shared tool and persists its operation tree", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const requests: Array<{
    tools: Array<{ function: { name: string } }>;
    messages: unknown[];
  }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const call =
        requests.length <= 2
          ? {
              name: "read_source",
              arguments: JSON.stringify(
                requests.length === 1 ? {} : { path: "input.txt" },
              ),
            }
          : {
              name: "submit_result",
              arguments: JSON.stringify({ value: { approved: true } }),
            };
      const chunk = {
        id: `response-${requests.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "local-test",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${requests.length}`,
                  type: "function",
                  function: call,
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const home = path.join(project, ".workflow", "isolated-user");
  await mkdir(home);
  await cp(
    path.join(userPaths().directory, "cache", "temporal"),
    path.join(home, "cache", "temporal"),
    { recursive: true },
  ).catch(() => {});
  await writeFile(
    path.join(home, "models.json"),
    JSON.stringify({
      providers: {
        loopback: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "fixture-only",
          models: [
            {
              id: "local-test",
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const previous = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = home;
  cleanup(async () => {
    if (previous === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = previous;
  });
  await writeFile(path.join(project, "input.txt"), "provider-visible content");
  const engine = new WorkflowEngine(project, "live", runPiBlock);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source = `import {workflow,block,defineTool,step,z} from "workflow"; const prefix=""; ${reader}
    export default workflow({name:"Pi tool session",flow:step("review",block({run:ctx=>ctx.ai({
      role:"review",tools:[readSource],model:{provider:"loopback",model:"local-test",thinking:"off"},
      prompt:"Inspect input.txt and report whether the review is approved",output:z.object({approved:z.boolean()})
    })}))});`;
  const draft = await engine.createProgram(
    "Pi tools",
    "Review",
    { source },
    library,
  );
  await engine.approve(draft.id);
  await waitForRun(() => engine.get(draft.id), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(
    engine.get(draft.id).status,
    "completed",
    engine.get(draft.id).error,
  );
  assert.equal(requests.length, 3);
  for (const request of requests)
    assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), [
      "read_source",
      "submit_result",
    ]);
  assert.match(JSON.stringify(requests[2]!.messages), /Source inspected/);
  const events = await engine.events(draft.id);
  const tool = events.find(
    (event) =>
      event.operation?.name === "read_source" &&
      event.operation.state === "completed",
  )?.operation;
  assert.ok(tool?.parentId);
  assert.ok(
    events.some(
      (event) =>
        event.operation?.id === tool.parentId && event.operation?.kind === "ai",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.operation?.parentId === tool.id &&
        event.operation.kind === "read" &&
        event.operation.state === "completed",
    ),
  );
  assert.match(JSON.stringify(tool.details), /provider-visible content/);
  const rejected = events.find(
    (event) =>
      event.operation?.name === "read_source" &&
      event.operation.state === "failed",
  )?.operation;
  assert.ok(
    rejected,
    "schema rejection remains visible even when Pi refuses to invoke the tool",
  );
  assert.ok(
    !events.some((event) => event.operation?.parentId === rejected.id),
    "rejected arguments must not cause an environment effect",
  );
});

test("cancelled shared commands retain transcript identity and environment evidence", async t => {
  const { project, library } = await fixture(t);
  const versions = new WorkflowVersions(path.join(project, ".workflow", "versions"));
  const built = await compileProgram(project, {source:`
    import {workflow,block,defineTool,step,z} from "workflow";
    const command=defineTool({name:"capture_command",description:"Capture a command",input:z.object({}),output:z.string(),
      async execute(_,ctx){await ctx.env.exec("printf 'retained before cancellation\\n'; sleep 10");return "finished";}});
    export default workflow({name:"Capture",flow:step("capture",block({run:ctx=>ctx.call(command,{})}))});
  `}, versions, library.blocks);
  const version = await versions.load(built.version.id);
  const controller = new AbortController();
  const records: import("../src/operation-schema.js").OperationRecord[] = [];
  await assert.rejects(executeTool({codePath:version.toolsPath!,tool:{name:"capture_command",version:1,replay:"unsafe"},input:{},callId:"shared-command",request:"Capture cancellation",signal:controller.signal,
    record:async event=>{records.push(event);},
    environment:signal=>localExecutionEnvironment({project,signal,outputDirectory:project,onOutput:()=>controller.abort(new Error("Stop retained command"))}),
  }),/Stop retained command/);
  const interrupted=records.find(record=>record.kind==="exec"&&record.state==="interrupted");
  assert.ok(interrupted?.outputRef,"cancelled command output remains addressable");
  assert.equal(interrupted.environmentId,`local:${project}`);
  assert.ok(interrupted.durationMs !== undefined && interrupted.durationMs >= 0);
  assert.equal(interrupted.parentId,"shared-command");
  const { readCommandOutput } = await import("../src/command-output.js");
  const captured=await readCommandOutput(project,interrupted.outputRef.id);
  assert.match(captured.text,/retained before cancellation/);
});
