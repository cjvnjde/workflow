import { $ } from "bun";
import { chmod, readdir, rm, writeFile } from "node:fs/promises";
import { bundleWorkflowCode, DefaultLogger } from "@temporalio/worker";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { entrypoints } from "./entrypoints.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");

await $`bun run typecheck`.cwd(root);
if (process.argv.includes("--engine-only")) {
  for (const name of await readdir(dist).catch(() => [] as string[])) {
    if (name !== "web") await rm(path.join(dist, name), { recursive: true, force: true });
  }
} else {
  await rm(dist, { recursive: true, force: true });
  await $`bun --bun run vite build`.cwd(root);
}

const publicNames = [
  "workflow-sdk",
  "application",
  "http-server",
  "client",
  "contracts",
  "core",
  "web",
  "terminal",
] as const;
const declarations = ts.createProgram(
  publicNames.map((name) => path.join(root, "src", entrypoints[name])),
  {
    declaration: true,
    emitDeclarationOnly: true,
    outDir: dist,
    rootDir: path.join(root, "src"),
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    types: ["bun", "node"],
    esModuleInterop: true,
  },
);
if (declarations.emit().emitSkipped)
  throw new Error("Could not generate workflow SDK declarations");
for (const name of publicNames) {
  const module = entrypoints[name].replace(/\.ts$/, ".js");
  await writeFile(path.join(dist, `${name}.d.ts`), `export * from "./${module}";\n`);
}

const browserNames = new Set(["workflow-sdk", "program-runtime", "client", "contracts"]);
for (const [name, source] of Object.entries(entrypoints)) {
  const browser = browserNames.has(name);
  const result = await Bun.build({
    entrypoints: [path.join(root, "src", source)],
    outdir: dist,
    naming: `${name}.js`,
    format: "esm",
    target: browser ? "browser" : "bun",
    ...(browser
      ? {
          external: [
            "@temporalio/workflow",
            ...(name === "client" || name === "contracts" ? ["zod"] : []),
          ],
        }
      : { packages: "external" as const }),
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
}
for (const [source, output] of [
  ["core/execution/temporal-workflow.ts", "workflow-bundle.js"],
  ["legacy/temporal-workflow-v1.ts", "workflow-v1-bundle.js"],
] as const) {
  const workflow = await bundleWorkflowCode({
    workflowsPath: path.join(root, "src", source),
    logger: new DefaultLogger("WARN"),
  });
  await writeFile(path.join(dist, output), workflow.code);
}
await $`bun build --target=bun --packages=external src/cli/index.ts --outfile=dist/cli.js`.cwd(
  root,
);
await chmod(path.join(dist, "cli.js"), 0o755);
