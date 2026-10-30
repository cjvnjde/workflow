import { z } from "zod";
import { blockInstructions } from "./code-schema.js";

/** Source is editable; compiled orchestration and imports live in the version archive. */
export const programSourceSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .max(256_000)
      .refine((value) => !!value.trim(), "Enter TypeScript source"),
    filename: z
      .string()
      .min(1)
      .max(240)
      .default("workflow.ts")
      .refine(
        (name) =>
          !name.startsWith("/") && !name.split(/[\\/]/).includes("..") && /\.ts$/.test(name),
        "Use a project-relative .ts filename",
      ),
    input: z.record(z.string(), z.json()).default({}),
  })
  .strict();
export type ProgramSource = z.infer<typeof programSourceSchema>;

export const compositionInstructions = `
Compose a TypeScript workflow with submit_workflow. Import {workflow,step,sequence,parallel,when,repeatUntil} from "workflow".
Export default workflow({name:"Task title",flow:sequence(...)}). The flow is a declaration: NEVER call models, inspect files, Git, shell or MCP while composing it. Put all investigation and configuration checks into execution blocks.
Connect every intended step and group to the exported flow. Declaring a variable does not schedule it: for example, a publication group after a review loop requires flow:sequence(reviewLoop,publish). Before submitting, trace the exported flow against the full request, including requested final actions and feedback paths.
Use only the request, supplied attachments/answers, task instructions, blocks and profiles. Do not assert repository facts that were not supplied. For branch reviews, explicitly instruct the execution step to inspect its baseline and, if there are no commits or no usable comparison base, review the accessible working files instead, clearly stating that findings are not branch-relative. Missing baseline alone is a scope limitation, not a reason to skip useful inspection or declare the workflow blocked.
Reuse the supplied saved blocks: const review=step<ReviewOutput>("review","review-block-id",{prompt:"Review...",model:{provider,model,thinking},maxVisits:3}). Give each step a concise, distinct user-facing label describing its work, even when reusing the same block. Step IDs and group IDs are unique lowercase kebab-case. Imported reusable TypeScript blocks also work and infer their return type.
step options: {label?,prompt?:string|((ctx)=>string),inputs?:object|((ctx)=>object),model?:{provider,model,thinking},maxVisits?:1..30,on?:{pass?,retry?,fail?}}. Each outcome action is "continue", "stop", or "repeat". Defaults: pass continues, retry/fail stop. repeat immediately returns to the enclosing loop, skipping the remaining sequence. Keep hard failures as stop unless there is a real recovery path.
sequence(a,b,c) runs in order. parallel([a,b,c],{concurrency:2,label:"Independent checks"}) runs independent branches and joins all started branches; concurrency is 1..8. These share the workspace: parallelize independent read-only inspections or isolated checks. Concurrent writers require separate Git worktrees, even for disjoint files: writablePaths protects all other paths, including sibling edits. Do not overlap Git mutations or checks that rebuild the same files. Parallel siblings cannot consume one another's partial outputs; their results become available after the join.
when("publish-if-approved",ctx=>ctx.output(review)?.approved===true,thenNode,optionalElseNode) selects a branch. Conditions are synchronous booleans, with no effects.
repeatUntil("revision",{body:sequence(implement,tests,review),until:ctx=>ctx.output(review)?.approved===true,maxIterations:3}) executes the body at least once. An unmet condition at the limit fails clearly; maxVisits still bounds each step. Loops may nest. ctx.iteration("revision") is one-based.
Deferred inputs/prompts and conditions receive ctx.request (original task), ctx.input (workflow inputs), ctx.models (profiles), ctx.output<T>(stepOrId) (latest typed returned data, initially undefined), ctx.result<T>(stepOrId) ({outcome,summary,artifacts,data}, initially undefined). Reference a step variable for inferred output types, or supply the return type when using string IDs. Use optional access for first-iteration feedback.
Plan dependencies before choosing order. Separate independent acceptance concerns into distinct steps when they have useful separate evidence. Use parallel for independent inspections, isolated checks, or independent implementation in separate Git worktrees via ctx.ai({workspace}). Shared-workspace writers must remain serial; isolated writers need a common recorded baseline, preservation of relevant uncommitted changes, explicit integration after the join, conflict handling and combined acceptance checks. Reuse valid harness artifacts and prior results only after checking that their inputs and workspace revision still match. Join before synthesis or any dependent edits. Do not invent dependencies merely to reuse a serial recipe. If parallel work is unsafe, explain the concrete shared resource or dependency in the rationale; do not invent repository facts.
Use when for work whose necessity depends on execution evidence: for example an assessment that returns needsChanges can select a repair branch or a report-only branch. Do not run repairs unconditionally, or add a decorative condition whose two paths do the same work. Unknown facts belong in typed assessment outputs, not planner guesses. Assessment outputs must distinguish selected in-scope defects from related or deferred observations. Pass only the selected scope to test authoring and repair; discovering extra work in a linked issue does not expand the user request.
Every read-only ctx.ai call must declare protectedPaths:["**/*"] to guard project files (subject to the documented generated/runtime exclusions). Put that call's specific role at the start of its prompt, followed by evidence; never pass bare evidence JSON as the goal of a narrower preparatory call inside an implementation block. Keep test authoring, production repair, and acceptance checks distinct. A completed test-authoring step must preserve valid tests even when they expose a product defect; follow authoring with a separate acceptance gate and never equate authoring pass with acceptance. A test compilation/setup error goes to the test author; a valid failing assertion goes to production repair; unavailable infrastructure blocks with evidence. An ambiguous failure needs diagnosis before choosing an owner. Use typed diagnosis and when to select the owner, then rerun the gate. Never route every failed check to production implementation. Use ctx.ai protectedPaths for regression files owned by other steps when defining production repair blocks; include project-specific test paths beyond the default patterns. Preserve valid regression tests across production repair; an incorrect test requires an explicit test correction step with a reason, followed by verification. Pass complete results/diagnostics in inputs rather than dropping evidence to a summary.
Use actual block contracts. A generic type annotation does not convert a saved block's return shape: use approved only if the supplied source really returns that field. A verification block that reports outcomes instead of approved data can use ctx.result(verify)?.outcome==="pass". Preserve selected feedback in inputs, and use output schemas from the supplied source. Model defaults belong on each AI step; explicit ctx.ai model overrides in block source still win. Code without AI needs no model. Submit complete source, title, input JSON object, rationale and attachment observations. No fixed recipes are required.
`.trim();

export const programInstructions = `
${compositionInstructions}
For existing imperative workflows, preserve their style when refining them unless asked to change composition. The legacy imperative API remains supported:
Create a real TypeScript workflow with submit_workflow. Import { workflow, block, z } from "workflow".
Export default workflow({name:"descriptive name",input:z.object({request:z.string()}),async run(ctx){...}}).
Use ordinary await, if, bounded for/while loops, functions and variables. Call await ctx.step(id, block, options) for each durable block. Inline code blocks return their typed value directly; there is no .data or .outcome wrapper unless the block's own return value defines it.
Step options: {prompt?,label?,inputs?:{name:any JSON data},model?:{provider,model,thinking},maxVisits?:1..30}. ctx.input is the workflow's validated input; ctx.request is the original request; ctx.models contains frozen enabled model profiles. Define blocks outside or inside run; models/prompts/data can be accepted through inputs or captured by a function. Reuse IDs in loops. Explicitly pass feedback between blocks.
Existing Settings IDs also work: await ctx.step<YourOutputType>(id,"saved-id",{inputs,...}). Inspect the saved source's return shape. Older agent/script definitions return {outcome,summary,artifacts,data?}; keep that old contract only when reusing those older definitions. New blocks use block({async run(ctx){...}}), never agent() or script().
Returning from workflow.run completes it; throw when a terminal condition failed. Prefer a concise Markdown final result. Await steps sequentially. Functions execute durably; file/process/network effects go through block ctx methods. Pure helper imports and reusable block source are frozen with the workflow. Constructing a block never executes it.
${blockInstructions}
Example:
const review = block({async run(ctx){return ctx.ai({prompt:"Review the task independently without modifying files: "+ctx.prompt,output:z.object({approved:z.boolean(),feedback:z.string()})});}});
export default workflow({name:"Implement and review",input:z.object({request:z.string()}),async run(ctx){
  let feedback="";
  for(let attempt=0;attempt<3;attempt++){
    const implement=block({async run(step){return step.ai({prompt:ctx.input.request+"\\nReview feedback: "+feedback});}});
    await ctx.step("implement",implement,{maxVisits:3});
    const checked=await ctx.step("review",review,{prompt:ctx.input.request,maxVisits:3});
    if(checked.approved)return checked.feedback;
    feedback=checked.feedback;
  }
  throw new Error("Review did not pass: "+feedback);
}});
Choose necessary blocks for the request; this example is not a predefined workflow. Missing commits change the review scope, not the requirement to submit a workflow. Submit source, title, input JSON, rationale and attachment observations.
`.trim();
