import { z } from "zod";
import { blockInstructions } from "./code-schema.js";

/** Source is editable; compiled orchestration and imports live in the version archive. */
export const programSourceSchema = z.object({
  source: z.string().min(1).max(256_000).refine(value => !!value.trim(), "Enter TypeScript source"),
  filename: z.string().min(1).max(240).default("workflow.ts").refine(
    name => !name.startsWith("/") && !name.split(/[\\/]/).includes("..") && /\.ts$/.test(name),
    "Use a project-relative .ts filename",
  ),
  input: z.record(z.string(), z.json()).default({}),
}).strict();
export type ProgramSource = z.infer<typeof programSourceSchema>;

export const programInstructions = `
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
