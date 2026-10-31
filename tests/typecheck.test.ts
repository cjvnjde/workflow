import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Node typechecking rejects React source, JSX and component prop errors", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-react-types-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
        paths: {
          react: [path.join(root, "node_modules/@types/react")],
          "react/*": [path.join(root, "node_modules/@types/react/*")],
        },
      },
      include: ["*.tsx"],
    }),
  );
  await writeFile(
    path.join(directory, "Child.tsx"),
    "export default function Child({ count }: { count: number }) { return <p>{count}</p>; }",
  );
  const parent = path.join(directory, "Parent.tsx");
  const manifestPath = fileURLToPath(import.meta.resolve("typescript/package.json"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    bin: { tsc: string };
  };
  const compiler = path.resolve(path.dirname(manifestPath), manifest.bin.tsc);
  const check = async () => {
    const child = spawn("node", [compiler, "--project", config], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    const { promise, resolve, reject } = Promise.withResolvers<number | null>();
    child.once("error", reject);
    child.once("close", resolve);
    const code = await promise;
    return { code, output };
  };
  await writeFile(
    parent,
    `import Child from './Child';
const count: number = 'invalid';
export default function Parent() {
  return <><Child count="wrong prop" /><p>{count.toUpperCase()}</p><unknownFixtureElement /></>;
}`,
  );
  const invalid = await check();
  assert.notEqual(invalid.code, 0, invalid.output);
  assert.equal(invalid.output.match(/TS2322/g)?.length, 2, invalid.output);
  assert.match(invalid.output, /toUpperCase/);
  assert.match(invalid.output, /unknownFixtureElement/);
  await writeFile(
    parent,
    `import Child from './Child';
const count: number = 1;
export default function Parent() {
  return <><Child count={count} /><p>{count.toFixed(0)}</p></>;
}`,
  );
  const valid = await check();
  assert.equal(valid.code, 0, valid.output);
});
