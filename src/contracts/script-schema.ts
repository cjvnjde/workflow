import { z } from "zod";

export const scriptExecutorSchema = z
  .object({
    kind: z.literal("script"),
    language: z.enum(["bash", "javascript", "typescript"]),
    runtime: z.enum(["bash", "bun", "node"]),
    code: z
      .string()
      .min(1)
      .max(128_000)
      .refine((value) => !!value.trim(), "Script code must not be empty"),
    timeoutMs: z.number().int().min(100).max(3_600_000).default(120_000),
    expect: z.enum(["success", "failure"]).default("success"),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.language === "bash") !== (value.runtime === "bash")) {
      context.addIssue({
        code: "custom",
        path: ["runtime"],
        message: "Bash scripts use Bash; JavaScript and TypeScript use Bun or Node.",
      });
    }
  });
export type ScriptExecutor = z.infer<typeof scriptExecutorSchema>;

/** Included in planning and settings design so generated scripts share one contract. */
export const scriptInstructions = [
  "For deterministic work, use editable script blocks, with no model call: executor:{kind:'script',language:'bash'|'javascript'|'typescript',runtime:'bash'|'bun'|'node',code:'full source',timeoutMs:120000,expect:'success'|'failure'}. Bash uses runtime bash; JavaScript/TypeScript use bun or node. Prefer scripts for repeatable checks, Git publication, build and file processing; any task can supply its own script. There is no built-in function catalog. Do not use function or command executors for new blocks.",
  "Scripts run from the project root with the inherited environment. Source is supplied on stdin; JS/TS uses ES modules and may import Node APIs or installed project packages. TypeScript is transpiled before execution. Bash receives -e and -o pipefail. Script code is frozen in the workflow snapshot.",
  "WORKFLOW_INPUT is the path to a JSON file containing {version:1,project,task,node:{id,label,goal},visit,inputs,outputs,attachments}. inputs contains only the selected artifact handoffs; outputs lists declared artifact names. WORKFLOW_RESULT is a writable JSON-file path. Optionally write {outcome:'pass'|'retry'|'fail',summary:'...',artifacts:{name:'text'}} there. With no result file, the host uses exit status and captures stdout/stderr as the summary and declared artifacts. A timeout or unexpected exit cannot report pass. The default expects exit 0; use expect:'failure' only for deliberate reproduction checks. Nonzero/unexpected exit returns retry with diagnostics. Use result artifacts to pass context to later steps; tests return feedback to implementation rather than fixing code themselves.",
  "To run an existing project script, use Bash code such as `bun run scripts/check.ts` or `node scripts/check.mjs`. The inline block source is snapshotted; imported/called project files are read at execution time. Put requested publication after successful verification. The starter push block is just an editable JavaScript example.",
].join("\n\n");
