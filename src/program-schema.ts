import { z } from "zod";

/** Source is editable; compiled orchestration and imports live in the version archive. */
export const programSourceSchema = z.object({
  source: z.string().trim().min(1).max(256_000),
  filename: z.string().min(1).max(240).default("workflow.ts").refine(
    name => !name.startsWith("/") && !name.split(/[\\/]/).includes("..") && /\.ts$/.test(name),
    "Use a project-relative .ts filename",
  ),
  input: z.record(z.string(), z.json()).default({}),
}).strict();
export type ProgramSource = z.infer<typeof programSourceSchema>;

export const programInstructions = `
Create a real TypeScript workflow with submit_workflow. Import { workflow, agent, script, z } from "workflow".
Export default workflow({name:"descriptive name",input:z.object({request:z.string()}),async run(ctx){...}}).
Use ordinary await, if, for/while loops, functions and variables. Call await ctx.step(id, block, options) for each durable action.
block is an existing Settings block ID string, or agent({instructions,model?:{provider,model,thinking},output?:z.object({...}),outputs?:["artifact"]}), or script({language:"bash"|"javascript"|"typescript",runtime:"bash"|"bun"|"node",code,timeoutMs?,expect?}).
Step options: {prompt,label?,inputs?:{name: any JSON data},model?:{provider,model,thinking},maxVisits?:1..30}. Steps return {outcome:"pass"|"retry"|"fail",summary,artifacts,data?}. Summary is always available as result.summary and artifacts.summary; outputs declares additional lowercase kebab-case artifact names. An agent with output schema publishes JSON in artifacts.data; use result.data for typed decisions. ctx.input is validated against the input schema; ctx.request is the original request; ctx.models contains the snapshotted enabled model profiles by ID.
Reuse stable step IDs inside loops. Pass feedback explicitly through prompt or inputs. Await every step sequentially; the project has one active executor. Bound retry loops and throw an informative Error when exhausted or a failure cannot be handled. Returning from run completes the workflow; throw on an unsuccessful terminal result. Prefer a concise Markdown string for the user-visible final result. Structured JSON return values are also supported.
Orchestration runs durably in Temporal: do not access files, network, processes, timers or host environment in orchestration code. Put all such work in agent/script steps, which have full local access. Pure helper imports are bundled and frozen. Use no JSX or React. Constructing blocks does not run them. Prefer existing blocks; define scripts or agents inline when a new role is needed.
Model choices must use supplied provider/model IDs and supported thinking levels. Set or override a model in agent() or ctx.step(); passing ctx.models[profileId] is supported. A script never needs a model.
Example:
const review = agent({instructions:"Review independently; report evidence. Do not edit files.",output:z.object({approved:z.boolean(),feedback:z.string()})});
export default workflow({name:"Implement and review",input:z.object({request:z.string()}),async run(ctx){
  let feedback = "";
  for(let attempt=0; attempt<3; attempt++){
    const work = await ctx.step("implement","implement",{prompt:ctx.input.request,inputs:{feedback},maxVisits:3});
    if(work.outcome !== "pass"){feedback=work.summary; continue;}
    const checked = await ctx.step("review",review,{prompt:ctx.input.request,maxVisits:3});
    if(checked.outcome === "pass" && checked.data?.approved) return checked.data;
    feedback = checked.data?.feedback ?? checked.summary;
  }
  throw new Error("Review did not pass after three attempts: "+feedback);
}});
The example illustrates the API, not a predefined workflow: choose the necessary steps for this request. Submit source, title, input JSON, rationale, and attachment observations. Missing commits change the review scope, not the requirement to submit a workflow.
`.trim();
