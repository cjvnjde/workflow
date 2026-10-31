import { spawn } from "node:child_process";
import { chmod, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { bundleWorkflowCode, DefaultLogger } from "@temporalio/worker";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { entrypoints } from "./entrypoints.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");

async function resolveTool(packageName: string, binary: string): Promise<string> {
  const manifestPath = fileURLToPath(import.meta.resolve(`${packageName}/package.json`));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    bin: string | Record<string, string>;
  };
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin[binary];
  if (!entry) throw new Error(`Package ${packageName} does not provide ${binary}`);
  return path.resolve(path.dirname(manifestPath), entry);
}

async function runTool(entry: string, args: string[]): Promise<void> {
  const child = spawn(process.execPath, [entry, ...args], { cwd: root, stdio: "inherit" });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${path.basename(entry)} failed (${signal ?? code})`));
  });
  await promise;
}

const nativeTsc = await resolveTool("typescript", "tsc");
await runTool(nativeTsc, ["--project", path.join(root, "tsconfig.json")]);
if (process.argv.includes("--engine-only")) {
  for (const name of await readdir(dist).catch(() => [] as string[])) {
    if (name !== "web") await rm(path.join(dist, name), { recursive: true, force: true });
  }
} else {
  await rm(dist, { recursive: true, force: true });
  await runTool(await resolveTool("vite", "vite"), ["build"]);
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
const declarationArgs = [
  "--ignoreConfig",
  "--declaration",
  "--emitDeclarationOnly",
  "--outDir",
  dist,
  "--rootDir",
  path.join(root, "src"),
  "--skipLibCheck",
  "--target",
  "ES2023",
  "--module",
  "ESNext",
  "--moduleResolution",
  "Bundler",
  "--strict",
  "--types",
  "bun,node",
  ...publicNames.map((name) => path.join(root, "src", entrypoints[name])),
];
await runTool(nativeTsc, declarationArgs);
for (const name of publicNames) {
  const module = entrypoints[name].replace(/\.ts$/, ".js");
  await writeFile(path.join(dist, `${name}.d.ts`), `export * from "./${module}";\n`);
}

const browserNames: Record<string, true> = {
  "workflow-sdk": true,
  "program-runtime": true,
  client: true,
  contracts: true,
};
async function bundle(name: string, source: string): Promise<void> {
  const browser = browserNames[name] === true;
  const result = await rolldown({
    input: path.join(root, "src", source),
    platform: browser ? "browser" : "node",
    external: browser
      ? ["@temporalio/workflow", ...(name === "client" || name === "contracts" ? ["zod"] : [])]
      : (id) => !id.startsWith(".") && !path.isAbsolute(id),
  });
  try {
    await result.write({
      file: path.join(dist, `${name}.js`),
      format: "esm",
      // Runtime asset and worker paths are relative to these flat, named bundles.
      codeSplitting: false,
    });
  } finally {
    await result.close();
  }
}
for (const [name, source] of Object.entries(entrypoints)) {
  await bundle(name, source);
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
await bundle("cli", "cli/index.ts");
await chmod(path.join(dist, "cli.js"), 0o755);
