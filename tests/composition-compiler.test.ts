import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
import {
  checkProgram,
  validateComposition,
  validateProgram,
} from "../src/program-compiler.js";
import { planTask } from "../src/task-planner.js";
import { taskSchema } from "../src/task-schema.js";
import { orchestrationSchema } from "../src/orchestration-schema.js";
import { Attachments } from "../src/attachments.js";
import type { AvailableModel } from "../src/library-editor-schema.js";
import type { runAgentSession } from "../src/agent-session.js";

const header =
  'import {workflow,block,step,sequence,parallel,when,repeatUntil,z} from "workflow";';
const declaration = `${header}
const flow=sequence(step("one",block({run(){return "Done";}})));
const definition=workflow({name:"Declared flow",flow});`;

test("composition discovery supports shorthand properties, default aliases and imported definitions", async (t) => {
  const { project } = await fixture(t);
  await writeFile(
    path.join(project, "declared.ts"),
    `${declaration}\nexport default definition;`,
  );
  for (const source of [
    `${declaration}\nexport default definition;`,
    `${declaration}\nexport {definition as default};`,
    'export {default} from "./declared.ts";',
  ]) {
    const prepared = await validateComposition(project, { source }, {});
    assert.equal(prepared.structure.kind, "sequence");
    assert.equal(prepared.structure.children[0]?.id, "one");
  }
});

test("unused steps and groups must be attached to the exported flow, including aliases and compound bindings", async (t) => {
  const { project } = await fixture(t);
  const setup = `${header}
import type {FlowNode} from "workflow";
const action=block({run(){return "Done";}});
const implement=step("implement",action);
const commit=step("commit",action),push=step("push",action);`;
  for (const disconnected of [
    'const publish=when("publish-after-review",()=>true,sequence(commit,push));',
    "type Publication=FlowNode; const publish:Publication=sequence(commit,push);",
    "const ordinaryUnused=123,publish=sequence(commit,push);",
    "const {publish,ordinaryUnused}={publish:sequence(commit,push),ordinaryUnused:123};",
    "const [publish,ordinaryUnused]=[sequence(commit,push),123] as const;",
  ]) {
    const source = `${setup}\n${disconnected}\nexport default workflow({name:"Missing publication",flow:implement});`;
    assert.throws(
      () => checkProgram(project, { source }),
      /Workflow primitive "publish" is declared but unused\. Attach it to the exported workflow's flow/,
    );
    const repaired = source.replace(
      "flow:implement",
      "flow:sequence(implement,publish)",
    );
    const preview = await validateComposition(
      project,
      { source: repaired },
      {},
    );
    assert.equal(preview.structure.children[0]?.id, "implement");
  }
  assert.throws(
    () =>
      checkProgram(project, {
        source: `${header}
const action=block({run(){return "Done";}});
const unused=step("unused",action);
export default workflow({name:"Missing step",flow:step("used",action)});`,
      }),
    /Workflow primitive "unused"/,
  );
});

test("unused primitive validation follows re-exported definitions while allowing reusable exports and ordinary helpers", async (t) => {
  const { project } = await fixture(t);
  const reusable = path.join(project, "reusable.ts");
  await writeFile(
    reusable,
    `${header}
const ordinaryUnused=123;
const untypedUnused:any={};
const unknownUnused:unknown={};
const impossibleUnused=undefined as never;
type UnusedHelperType={message:string};
const action=block({run(){const localUnused=1;return "Done";}});
export const used=step("used",action);
export const optional=step("optional",action);
export function helper(){return 1;}`,
  );
  const declarationFile = path.join(project, "definition.ts");
  const source = `${header}
import {used,optional,helper} from "./reusable.ts";
const ordinaryUnused=123;
const publish=sequence(step("commit",block({run(){return "Committed";}})));
export default workflow({name:"Imported composition",flow:used});`;
  await writeFile(declarationFile, source);
  await assert.rejects(
    validateComposition(
      project,
      { source: 'export {default} from "./definition.ts";' },
      {},
    ),
    /definition\.ts.*Workflow primitive "publish"/,
  );
  await writeFile(
    declarationFile,
    source.replace("flow:used", "flow:sequence(used,publish)"),
  );
  const preview = await validateComposition(
    project,
    { source: 'export {default} from "./definition.ts";' },
    {},
  );
  assert.equal(preview.structure.children[0]?.id, "used");
});

test("unrelated flow properties do not execute imperative module initializers during validation", async (t) => {
  const { project } = await fixture(t);
  const source = `${header}
throw new Error("Imperative initializer must wait for execution");
const unusedPrimitive=step("unused",block({run(){return "Optional";}}));
export default workflow({name:"Existing imperative workflow",async run(){
  const metadata={flow:"unrelated field"};
  return metadata.flow;
}});`;
  const prepared = await validateProgram(project, { source });
  assert.match(
    prepared.source,
    /Imperative initializer must wait for execution/,
  );
  await assert.rejects(
    validateComposition(project, { source }, {}),
    /declared flow tree|graph before execution/,
  );
});

test("preview describes branches and loops without executing blocks, conditions or deferred inputs", async (t) => {
  const { project } = await fixture(t);
  const source = `${header}
const action=block({run(){throw new Error("Block was executed during preview");}});
const first=step("first",action,{
  prompt:()=>{throw new Error("Prompt was evaluated during preview");},
  inputs:()=>{throw new Error("Inputs were evaluated during preview");}
});
export default workflow({name:"Pure preview",flow:sequence(
  first,
  when("choose",()=>{throw new Error("Branch was evaluated during preview");},step("yes",action),step("no",action)),
  repeatUntil("review-loop",{body:step("review",action),until:()=>{throw new Error("Loop was evaluated during preview");},maxIterations:2})
)});`;
  const { structure } = await validateComposition(project, { source }, {});
  assert.deepEqual(
    structure.children.map((item) => item.kind),
    ["step", "when", "loop"],
  );
  assert.deepEqual(
    structure.children[1]?.children.map((item) => item.id),
    ["yes", "no"],
  );
  assert.equal(structure.children[2]?.maxIterations, 2);
});

test("preview bounds Promise microtasks without hanging the server process", async (t) => {
  const { project } = await fixture(t);
  const childFile = path.join(project, "preview-timeout.ts");
  const source = `${header}
Promise.resolve().then(()=>{while(true){}});
export default workflow({name:"Bounded preview",flow:step("one",block({run(){return "Done";}}))});`;
  await writeFile(
    childFile,
    `
import {validateComposition} from ${JSON.stringify(fileURLToPath(new URL("../src/program-compiler.ts", import.meta.url)))};
try {
  await validateComposition(${JSON.stringify(project)},{source:${JSON.stringify(source)}},{});
  console.error("Preview unexpectedly accepted an infinite microtask");
  process.exitCode=1;
} catch(error) {
  if(error instanceof Error && /timed out/.test(error.message)) console.log("PREVIEW_BOUNDED");
  else {console.error(error);process.exitCode=1;}
}
`,
  );
  const child = Bun.spawn([process.execPath, childFile], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let exceededOuterDeadline = false;
  const deadline = setTimeout(() => {
    exceededOuterDeadline = true;
    child.kill("SIGKILL");
  }, 12_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(
      exceededOuterDeadline,
      false,
      "Preview escaped its VM timeout and required the parent to kill it",
    );
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.match(stdout, /PREVIEW_BOUNDED/);
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
});

test("composition preserves inferred output types and validates literal and deferred step inputs", async (t) => {
  const { project } = await fixture(t);
  const source = `${header}
const producer=step("produce",block({run(){return {count:3};}}));
const consumer=block({input:z.object({count:z.number()}),run(ctx){return {approved:ctx.input.count>0};}});
const checked=step("check",consumer,{inputs:ctx=>({count:ctx.output(producer)?.count??0})});
const literal=step("literal",consumer,{inputs:{count:1}});
export default workflow({name:"Typed composition",flow:sequence(producer,checked,
  when("approved",ctx=>ctx.output(checked)?.approved===true,literal))});`;
  checkProgram(project, { source });
  assert.throws(
    () =>
      checkProgram(project, {
        source: source.replace("inputs:{count:1}", 'inputs:{count:"wrong"}'),
      }),
    /not assignable|No overload/,
  );
  assert.throws(
    () =>
      checkProgram(project, {
        source: source.replace(
          "count:ctx.output(producer)?.count??0",
          'count:"wrong"',
        ),
      }),
    /not assignable|No overload/,
  );
  assert.throws(
    () =>
      checkProgram(project, {
        source: source.replace(
          "ctx.output(checked)?.approved",
          "ctx.output(checked)?.missing",
        ),
      }),
    /missing/,
  );
  assert.throws(
    () =>
      checkProgram(project, {
        source: `${header}
const scalar=block({input:z.number(),run(ctx){return ctx.input+1;}});
export default workflow({name:"Invalid scalar inputs",flow:step("scalar",scalar,{inputs:3})});`,
      }),
    /not assignable|No overload/,
  );
});

const models: AvailableModel[] = [
  {
    provider: "test",
    id: "careful",
    name: "Careful",
    reasoning: true,
    thinkingLevels: ["off", "high"],
    imageInput: true,
    contextWindow: 100_000,
    maxTokens: 8000,
    cost: null,
  },
];
async function call(
  session: Parameters<typeof runAgentSession>[0],
  name: string,
  args: Record<string, unknown>,
) {
  const tool = session.tools.find((item) => item.name === name);
  assert.ok(tool, `Missing tool ${name}`);
  return tool.execute(
    "test-call",
    args,
    session.signal,
    undefined,
    {} as never,
  );
}

test("coordinator repairs rejected TypeScript compositions and preserves task and screenshot context", async (t) => {
  const { project, library } = await fixture(t);
  library.config.agent = {
    ...library.config.agent,
    provider: "test",
    model: "careful",
    thinking: "off",
  };
  const task = taskSchema.parse({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 0,
    status: "planning",
    prompt: "Review this screenshot and the working files",
    attachments: [],
    answers: [],
    approval: "review",
  });
  task.attachments.push(
    await new Attachments(project).add({
      name: "screen.png",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    }),
  );
  const source = `${header}
const review=step("review","review",{model:{model:"careful",provider:"test",thinking:"off"},maxVisits:1});
export default workflow({name:"Review",flow:sequence(review)});`;
  const events: { kind: string; message: string }[] = [];
  const result = await planTask(
    {
      project,
      library,
      task,
      settings: orchestrationSchema.parse({}),
      models,
      signal: new AbortController().signal,
      emit: (kind, message) => {
        events.push({ kind, message });
      },
    },
    async (session) => {
      assert.deepEqual(session.tools.map((tool) => tool.name).sort(), [
        "ask_user",
        "choose_task_case",
        "submit_plan",
        "submit_workflow",
        "suggest_block",
      ]);
      assert.ok(
        (
          session.tools.find((tool) => tool.name === "submit_workflow")!
            .parameters as { required?: string[] }
        ).required?.includes("attachmentSummary"),
      );
      const proposal = {
        title: "Review screenshot",
        source,
        rationale: "Review provided context during execution",
        attachmentSummary: "The screenshot shows a missing result.",
      };
      await assert.rejects(call(session, "submit_workflow", proposal), /case/);
      await call(session, "choose_task_case", {
        id: "investigation",
        reason: "Read-only review",
      });
      await assert.rejects(
        call(session, "submit_workflow", { ...proposal, input: "[]" }),
        /must be an object/,
      );
      await assert.rejects(
        call(session, "submit_workflow", {
          ...proposal,
          source: source.replace(
            "export default workflow",
            'const publish=sequence(step("publish","review")); export default workflow',
          ),
        }),
        /Workflow primitive "publish" is declared but unused/,
      );
      assert.equal(session.completion?.isComplete(), false);
      assert.match(
        session.completion!.prompt(),
        /Attach it to the exported workflow/,
      );
      await assert.rejects(
        call(session, "submit_workflow", {
          ...proposal,
          source: source.replace(
            '"review","review"',
            '"review","missing-block"',
          ),
        }),
        /Unknown Settings block/,
      );
      await assert.rejects(
        call(session, "submit_workflow", {
          ...proposal,
          source: source.replace('model:"careful"', 'model:"unavailable"'),
        }),
        /not available/,
      );
      assert.equal(session.completion?.isComplete(), false);
      assert.match(session.completion!.prompt(), /not available/);
      await assert.rejects(
        call(session, "submit_workflow", {
          ...proposal,
          attachmentSummary: "",
        }),
        /visual observations/,
      );
      await call(session, "submit_workflow", {
        ...proposal,
        input: JSON.stringify({
          request: "Do something else",
          scope: "working-files",
        }),
      });
      assert.equal(session.completion?.isComplete(), true);
      await assert.rejects(
        call(session, "submit_workflow", proposal),
        /already finished/,
      );
    },
  );
  assert.equal(result.kind, "program");
  if (result.kind !== "program") return;
  assert.equal(result.program.input.request, task.prompt);
  assert.equal(result.program.input.scope, "working-files");
  assert.equal(result.caseId, "investigation");
  assert.match(result.library.config.instructions, /missing result/);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "plan_validation" && /not available/.test(event.message),
    ),
  );
  assert.ok(events.some((event) => event.kind === "plan_ready"));
});
