import { $ } from "bun";
import { chmod, readdir, rm, writeFile } from "node:fs/promises";
import { bundleWorkflowCode, DefaultLogger } from "@temporalio/worker";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");

await $`bun run typecheck`.cwd(root);
const engineOnly = process.argv.includes("--engine-only");
if (engineOnly) {
  // Independent backend builds preserve any separately built GUI.
  for (const name of await readdir(dist).catch(() => [] as string[])) {
    if (name !== "web") await rm(path.join(dist, name), { recursive: true, force: true });
  }
} else {
  await rm(dist, { recursive: true, force: true });
  await $`bun --bun run vite build`.cwd(root);
}
const sdkDeclarations = ts.createProgram(["workflow-sdk", "application", "http-server", "client", "contracts"].map(name => path.join(root, `src/${name}.ts`)), {
  declaration: true, emitDeclarationOnly: true, outDir: dist, skipLibCheck: true,
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true, types: ["bun", "node"], esModuleInterop: true,
});
if (sdkDeclarations.emit().emitSkipped) throw new Error("Could not generate workflow SDK declarations");
for (const name of ["workflow-sdk", "program-runtime", "client", "contracts"]) {
  const result = await Bun.build({
    entrypoints: [path.join(root, `src/${name}.ts`)], outdir: dist,
    target: "browser", format: "esm", external: ["@temporalio/workflow", ...(name === "client" || name === "contracts" ? ["zod"] : [])],
  });
  if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
}
const workflow = await bundleWorkflowCode({
  workflowsPath: path.join(root, "src/temporal-workflow.ts"),
  logger: new DefaultLogger("WARN"),
});
await writeFile(path.join(dist, "workflow-bundle.js"), workflow.code);
const legacy = await bundleWorkflowCode({
  workflowsPath: path.join(root, "src/legacy/temporal-workflow-v1.ts"),
  logger: new DefaultLogger("WARN"),
});
await writeFile(path.join(dist, "workflow-v1-bundle.js"), legacy.code);
await $`bun build --target=bun --packages=external src/cli.ts --outfile=dist/cli.js`.cwd(
  root,
);
await chmod(path.join(dist, "cli.js"), 0o755);

for (const name of ["application", "http-server", "tui", "tool-worker"]) {
  const result = await Bun.build({ entrypoints: [path.join(root, `src/${name}.ts`)], outdir: dist,
    target: "bun", format: "esm", packages: "external" });
  if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
}
