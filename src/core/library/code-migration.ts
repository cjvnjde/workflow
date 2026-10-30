import type { BlockBundle, Library } from "../../contracts/domain.js";
import { scriptBundle } from "./script-migration.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function convertedTimeout(bundle: BlockBundle, commands: Library["config"]["commands"]) {
  const definition = bundle.definition;
  return Math.min(
    3_600_000,
    (definition.executor?.kind === "script"
      ? definition.executor.timeoutMs + 2000
      : (definition.agent?.timeoutMs ?? 600_000)) +
      definition.checks.reduce(
        (sum, check) => sum + (commands[check.command]?.timeoutMs ?? 0) + 2000,
        0,
      ),
  );
}

/** Editable TypeScript for older libraries. Reading never rewrites user settings. */
export function blockSource(
  original: BlockBundle,
  commands: Library["config"]["commands"],
): string {
  if (original.definition.executor?.kind === "code") return original.definition.executor.source;
  const bundle = scriptBundle(original, commands);
  const def = bundle.definition,
    executor = def.executor;
  const lines = [
    'import { block, z } from "workflow";',
    "",
    "export default block({",
    `  name: ${JSON.stringify(def.name)},`,
    `  timeoutMs: ${convertedTimeout(bundle, commands)},`,
    "  async run(ctx) {",
  ];
  if (executor?.kind === "script") {
    const code =
      executor.language === "typescript"
        ? new Bun.Transpiler({
            loader: "ts",
            target: executor.runtime === "node" ? "node" : "bun",
          }).transformSync(executor.code)
        : executor.code;
    const command =
      executor.runtime === "bash"
        ? code
        : `${executor.runtime === "bun" ? "bun" : "node --input-type=module"} --eval ${quote(code)}`;
    lines.push(
      `    const process = await ctx.exec(${JSON.stringify(command)}, { timeoutMs: ${executor.timeoutMs} });`,
      `    const matched = !process.timedOut && process.exitCode !== null && ${executor.expect === "success" ? "process.exitCode === 0" : "process.exitCode !== 0"};`,
      `    const result = process.result ?? { outcome: matched ? "pass" as const : "retry" as const, summary: process.output || "Command completed.", artifacts: Object.fromEntries(${JSON.stringify(def.outputs)}.map(name => [name, process.output])) };`,
      '    if (!matched && result.outcome === "pass") { result.outcome = "retry"; result.summary += "\\nCommand did not meet its exit condition.\\n" + process.output; }',
    );
  } else {
    lines.push(
      "    const result = await ctx.ai({",
      `      instructions: ${JSON.stringify(bundle.prompt + `\nReturn outcome, summary and artifacts. Required artifacts on pass: ${def.outputs.join(", ") || "none"}.`)},`,
      '      prompt: ctx.prompt + "\\n\\nInputs:\\n" + JSON.stringify(ctx.input),',
      ...(def.agent ? [`      model: ${JSON.stringify(def.agent)},`] : []),
      `      output: z.object({ outcome: z.enum(["pass", "retry", "fail"]), summary: z.string(), artifacts: z.object({${def.outputs.map((name) => `${JSON.stringify(name)}: z.string()`).join(", ")}}).catchall(z.string()) }),`,
      "    });",
    );
  }
  for (const check of def.checks) {
    const command = commands[check.command];
    if (!command) throw new Error(`Block ${def.id} uses undefined command ${check.command}`);
    lines.push(
      '    if (result.outcome !== "fail") {',
      `      const check = await ctx.exec(${JSON.stringify(command.argv.map(quote).join(" "))}, { timeoutMs: ${command.timeoutMs} });`,
      `      const matched = !check.timedOut && check.exitCode !== null && ${check.expect === "success" ? "check.exitCode === 0" : "check.exitCode !== 0"};`,
      `      result.artifacts[${JSON.stringify(`check-${check.command}`)}] = check.output;`,
      '      if (!matched) { result.outcome = "retry"; result.summary += "\\nVerification failed.\\n" + check.output; }',
      "    }",
    );
  }
  lines.push(
    "    ctx.outcome(result.outcome);",
    "    ctx.summary(result.summary.slice(0, 16000));",
    "    for (const [name, content] of Object.entries(result.artifacts)) {",
    '      if (name !== "data" && name !== "summary") ctx.artifact(name, content.slice(0, 64000));',
    "    }",
    "    return result;",
    "  },",
    "});",
    "",
  );
  return lines.join("\n");
}

export function codeBundle(
  bundle: BlockBundle,
  commands: Library["config"]["commands"],
): BlockBundle {
  if (bundle.definition.executor?.kind === "code") return bundle;
  bundle = scriptBundle(bundle, commands);
  const {
    agent: _agent,
    checks: _checks,
    outputSchema: _schema,
    permissions: _permissions,
    ...definition
  } = bundle.definition;
  return {
    ...bundle,
    definition: {
      ...definition,
      checks: [],
      executor: {
        kind: "code",
        source: blockSource(bundle, commands),
        timeoutMs: convertedTimeout(bundle, commands),
        maxOperations: 100,
      },
    },
  };
}
