import { z } from "zod";

export const codeExecutorSchema = z
  .object({
    kind: z.literal("code"),
    source: z.string().min(1).max(128_000),
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000),
    maxOperations: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

export const codeOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ai"),
      protectedPaths: z.array(z.string().min(1).max(500)).max(100).optional(),
      prompt: z.string().min(1).max(64_000),
      instructions: z.string().max(64_000).optional(),
      model: z.record(z.string(), z.unknown()).optional(),
      outputSchema: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("exec"),
      command: z.string().min(1).max(128_000),
      timeoutMs: z.number().int().min(100).max(3_600_000).default(120_000),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("read"), path: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("write"),
      path: z.string().min(1),
      content: z.string().max(256_000),
    })
    .strict(),
]);
export type CodeOperation = z.infer<typeof codeOperationSchema>;

export const blockInstructions = `
There is one block type: a TypeScript function. For a reusable library proposal, supply {definition:{id,name,description,executor:{kind:"code",source:"complete .ts module"},skills:[],outputs:[],checks:[]},skills:[]}. Output fields and model choices live in source, not a separate AI/script selector.
Source imports {block,z} from "workflow" and exports default block({input?:z.object({...}),output?:z.object({...}),timeoutMs?:600000,maxOperations?:100,async run(ctx){...}}).
ctx.input contains only explicitly supplied step.inputs; it does not inherit workflow.input. Use ctx.request for the original request, ctx.prompt for the step goal, and declare an input schema for reusable handoffs. ctx.visit is the visit number. ctx.model is the inherited model; ctx.models[profileId] selects a frozen profile. Set or accept any model in code; use only supplied provider/model IDs and supported thinking levels for generated AI calls.
await ctx.ai({prompt,instructions?,protectedPaths?:string[],model?:{provider,model,thinking,timeoutMs?,maxToolCalls?},output?:z.object({...})}) runs a model/tool session. With output it returns validated typed data directly; without output it returns Markdown. AI has full project tools and enabled skills/MCP. protectedPaths supplies project-relative globs owned by another step (for production repair, include all regression test paths). Managed file edits are rejected and changed/added/deleted matching files fail the AI call, including shell changes. This is an integrity check, not an OS sandbox: transient edits, external files and excluded .git/.workflow/node_modules/dist/test-results/playwright-report trees are not audited; shell/MCP side effects are not restored. Do not run a protected call concurrently with a step authorized to change those same paths.
await ctx.exec(command,{timeoutMs?:120000,env?:{NAME:"value"}}) runs Bash in the project and returns {exitCode,stdout,stderr,output,timedOut}. Nonzero exits are returned, not thrown: route feedback explicitly. Use ctx.exec("bun scripts/check.ts") or node for host code/packages; pure block code itself cannot import host modules.
await ctx.readFile(path), await ctx.writeFile(path,text), await ctx.log(message) are durable operations. ctx.summary(markdown) sets the prominent result; ctx.artifact(name,text) publishes an artifact. Names use lowercase letters, digits, hyphens, underscores or dots (e.g. review.md), start with a letter, and contain no paths. data and summary are reserved. Return JSON-serializable typed data (or a string) to the caller. Optionally ctx.outcome("pass"|"retry"|"fail") records the routing state while returning data. Errors thrown by code fail the step and propagate to the workflow. Await every effect sequentially. Bound retry loops. Set timeoutMs and maxOperations on the block when needed.
Use ctx.exec for deterministic tests/Git/build tasks, and ctx.ai when reasoning is needed. Assign test authoring explicitly when new tests are needed; verification runs those tests and returns diagnostics to implementation. Publication only when requested, after verification. No built-in function catalog, language selector or separate AI block kind. Existing old agent/script definitions are compatibility data; create and edit new definitions as code.
For updates, preserve existing artifact contracts with ctx.artifact and preserve required checks/limits in source. Existing command names and argv are supplied as context; commands can also run directly without registration. A model-only request must preserve all other behavior. Use static imports; dynamic import() and top-level await are not supported by the durable bundle. Do not import React or use JSX.
`.trim();
