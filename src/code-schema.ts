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
      tools: z.literal("none").optional(),
      protectedPaths: z.array(z.string().min(1).max(500)).max(100).optional(),
      workspace: z.string().min(1).max(2000).optional(),
      writablePaths: z.array(z.string().min(1).max(500)).max(100).optional(),
      prompt: z.string().min(1).max(256_000),
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
await ctx.ai({prompt,instructions?,protectedPaths?:string[],writablePaths?:string[],workspace?:string,tools?:"none",model?:{provider,model,thinking,timeoutMs?,maxToolCalls?},output?:z.object({...})}) runs a model/tool session. With output it returns validated typed data directly; without output it returns Markdown. Use ctx.disposition("work-completed") for completed authoring, "accepted" only for verified acceptance, "changes-requested" for actionable defects, and "blocked" for unavailable prerequisites. These also set pass/pass/retry/fail respectively. Preserve exact selected scope, deferred observations, acceptance criteria and failure diagnostics in typed handoff data; unrelated observations do not authorize repairs. By default AI has project tools and enabled skills/MCP. Set tools:"none" for a pure text transformation: only submit_result is exposed, no MCP servers start, and only the explicit call prompt is passed as handoff. Keep these prompts within 32000 characters because there are no file tools to read context references. Prompts up to 256000 characters are supported; prompts above 32000 characters are retained losslessly as ordered context files for the agent to read before acting. Keep handoffs focused: do not duplicate the same typed output inside a full result, artifact JSON and another output field. Reference retained diagnostics instead of recursively embedding prior handoffs. workspace optionally selects an existing Git worktree of this project for this AI call; commands, file tools, MCP roots and ownership checks use that worktree. Create a distinct worktree per independent writer, preserve the starting revision and any relevant uncommitted work, join before explicitly integrating changes (patches or local checkpoint commits), and verify the combined result. Integration must check the recorded baseline and stop on conflicts; do not overwrite unrelated working changes. Never point two concurrent calls at the same alternate worktree. Worktrees are retained for inspection; integration and cleanup must be explicit steps. This is isolation by working directory, not an OS sandbox. protectedPaths supplies project-relative globs owned by another step (for production repair, include all regression test paths). Managed file edits are rejected and changed/added/deleted matching files fail the AI call, including shell changes. This is an integrity check, not an OS sandbox: transient edits, external files and excluded .git/.workflow/node_modules/dist/test-results/playwright-report trees are not audited; shell/MCP side effects are not restored. Do not run a protected call concurrently with a step authorized to change those same paths. writablePaths is an optional allowlist: all other project files are protected. An empty list is read-only. Test authors should allow only test/harness paths; production repair must preserve regressions. The same integrity-check limits apply. Read-only AI calls must use protectedPaths:["**/*"] and state their own narrow role in prompt before any handoff evidence; a surrounding repair block does not authorize a preparatory call to edit.
await ctx.exec(command,{timeoutMs?:120000,env?:{NAME:"value"}}) runs Bash in the project and returns {exitCode,stdout,stderr,output,timedOut}. Nonzero exits are returned, not thrown: route feedback explicitly. Use ctx.exec("bun scripts/check.ts") or node for host code/packages; pure block code itself cannot import host modules.
await ctx.readFile(path), await ctx.writeFile(path,text), await ctx.log(message) are durable operations. ctx.summary(markdown) sets the prominent result (over 16000 characters is visibly abbreviated, retaining the beginning and end; preserve complete diagnostics in an artifact or returned data); ctx.artifact(name,text) publishes an artifact. Names use lowercase letters, digits, hyphens, underscores or dots (e.g. review.md), start with a letter, and contain no paths. data and summary are reserved. Return JSON-serializable typed data (or a string) to the caller. Optionally ctx.outcome("pass"|"retry"|"fail") records the routing state while returning data. Errors thrown by code fail the step and propagate to the workflow. Await every effect sequentially. Bound retry loops. Set timeoutMs and maxOperations on the block when needed.
Use ctx.exec for deterministic tests/Git/build tasks, and ctx.ai when reasoning is needed. Assign test authoring explicitly when new tests are needed; verification runs those tests and returns diagnostics to implementation. Publication only when requested, after verification. No built-in function catalog, language selector or separate AI block kind. Existing old agent/script definitions are compatibility data; create and edit new definitions as code.
For updates, preserve existing artifact contracts with ctx.artifact and preserve required checks/limits in source. Existing command names and argv are supplied as context; commands can also run directly without registration. A model-only request must preserve all other behavior. Use static imports; dynamic import() and top-level await are not supported by the durable bundle. Do not import React or use JSX.
`.trim();
