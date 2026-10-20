import { $ } from "bun";
import { chmod, rm, writeFile } from "node:fs/promises";
import { bundleWorkflowCode, DefaultLogger } from "@temporalio/worker";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");

await $`bun run typecheck`.cwd(root);
await rm(dist, { recursive: true, force: true });
await $`bun --bun run vite build`.cwd(root);
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
