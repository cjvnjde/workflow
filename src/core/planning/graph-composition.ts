import type { Library } from "../../contracts/domain.js";

/** The reviewed graph is the source of truth; this loop is its internal executable form. */
export function graphProgram(library: Library) {
  const codeBlocks = Object.values(library.blocks)
    .filter((bundle) => bundle.definition.executor?.kind === "code")
    .map((bundle) => bundle.definition.id);
  return `import {workflow,type Model} from "workflow";
type Graph = {title:string;task:string;entry:string;nodes:{id:string;block:string;goal:string;label:string;maxVisits:number;agent?:Model;context?:Record<string,string>;inputs:{node:string;artifact:string;as?:string;required:boolean}[];on:Record<"pass"|"retry"|"fail",string>}[]};
const codeBlocks = new Set(${JSON.stringify(codeBlocks)});
export default workflow({name:"Composed workflow",async run(ctx){
  const plan=ctx.input.plan as Graph;
  const artifacts:Record<string,Record<string,string>>={}; let cursor=plan.entry, summary="";
  while(cursor!=="$complete" && cursor!=="$failed"){
    const node=plan.nodes.find(node=>node.id===cursor)!;
    const inputs:Record<string,unknown>={...node.context};
    for(const input of node.inputs){
      const value=artifacts[input.node]?.[input.artifact];
      if(value===undefined && input.required)throw new Error("Missing required input: "+input.node+"."+input.artifact);
      if(value!==undefined)inputs[input.as||input.artifact]=input.artifact==="data" && codeBlocks.has(node.block) ? JSON.parse(value) : value;
    }
    const result=await ctx.stepResult(node.id,node.block,{prompt:node.goal,label:node.label,inputs,maxVisits:node.maxVisits,model:node.agent});
    artifacts[node.id]={...result.artifacts,summary:result.summary};
    summary=result.summary;cursor=node.on[result.outcome];
  }
  if(cursor==="$failed")throw new Error(summary || "Workflow stopped on its configured failure route.");
  return summary;
}});`;
}

export const graphInstructions = `
Compose a graph from the supplied block catalog and task instructions. Submit it with submit_plan.
Graph: {title,task,entry,nodes:[{id,block,label,goal,context?:{name:"literal text"},inputs:[{node,artifact,as?,required?}],maxVisits,agent?:{provider,model,thinking},on:{pass,retry,fail}}]}.
Use existing block IDs. Node IDs and input aliases must use lowercase kebab-case (letters, digits and hyphens, starting with a letter; at most 64 characters). Each node supplies the instructions for that step in goal; the block receives them as ctx.prompt and the original request as ctx.request. Every route targets a node ID, $complete, or $failed. All nodes must be reachable. Bound retries with maxVisits and route diagnostics back to the step that can address them. Include only work needed for the user's request.
Pass selected output artifacts between blocks. summary is always available. TypeScript return values are published as data; a data handoff to a code block becomes parsed JSON in ctx.input[as ?? "data"]. Other handoffs are text. A later block's feedback must be optional on the first iteration. Declare literal inputs in context when a block requires them. Inspect the supplied block source/contracts to match its inputs and outputs; do not inspect project files.
Code blocks own behavior and routing outcomes through ctx.outcome("pass"|"retry"|"fail"). A returned data field alone does not change routing. The engine compiles the graph into TypeScript and handles durability; do not generate a separate orchestration program, invent hidden nodes or perform the task during planning.
Set agent on a node to choose its default model/thinking from the supplied profiles/catalog. Code uses that default through ctx.model or ctx.ai without a model override. An explicit ctx.ai({model:...}) in a saved block takes precedence. Commands that do not call AI need no model assignment.
Use ONLY the request, supplied attachments/answers, available blocks, configured commands, model profiles, project instructions and selected task-case instructions. You have no file, Git, shell or MCP inspection tools during graph composition. Put all investigation and configuration checks into execution blocks. Do not assert anything about the current codebase, commits, Git identity, remotes or test results unless it was provided in context. A branch review should inspect its baseline during execution and adapt to working files if no usable base exists.
`.trim();
