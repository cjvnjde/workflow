import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { userPaths } from "../src/infrastructure/user-paths.js";

const binary = fileURLToPath(new URL("../dist/workflow", import.meta.url));
const execute = promisify(execFile);

test(
  "a relocated single executable initializes, serves the UI, and executes compiled workflows and workers without Bun on PATH",
  {
    skip: !existsSync(binary) && "Run bun run test:standalone to build the executable first",
  },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-standalone-"));
    const bin = path.join(directory, "bin");
    const project = path.join(directory, "consumer project");
    const home = path.join(directory, "user");
    await mkdir(bin);
    await mkdir(project);
    await cp(binary, path.join(bin, "workflow"));
    const bash = Bun.which("bash");
    assert.ok(bash);
    await symlink(bash, path.join(bin, "bash"));
    assert.equal(Bun.which("bun", { PATH: bin }), null);
    assert.equal(Bun.which("node", { PATH: bin }), null);
    await cp(
      path.join(userPaths().directory, "cache/temporal"),
      path.join(home, "cache/temporal"),
      {
        recursive: true,
      },
    ).catch(() => {});
    const env = {
      ...process.env,
      WORKFLOW_HOME: home,
      PATH: bin,
      PI_OFFLINE: "1",
      WORKFLOW_TEST_EXECUTABLE: path.join(bin, "workflow"),
    };
    const command = async (args: string[]) => {
      try {
        return await execute(path.join(bin, "workflow"), args, {
          cwd: project,
          env,
          timeout: 60_000,
        });
      } catch (error) {
        const log = await readFile(path.join(project, ".workflow/host.log"), "utf8").catch(
          () => "",
        );
        throw new Error(`${String(error)}\n${log}`, { cause: error });
      }
    };
    t.after(async () => {
      try {
        await command(["stop"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    // Concurrent cold starts must publish only a complete runtime.
    const help = await Promise.all([command(["--help"]), command(["--help"])]);
    for (const result of help) assert.match(result.stdout, /--no-wait/);
    await command(["init"]);
    const config = JSON.parse(await readFile(path.join(project, ".workflow/config.json"), "utf8"));
    assert.equal(config.instructions, "");
    const host = JSON.parse((await command(["--background", "--port", "0", "--json"])).stdout);
    assert.equal(host.background, true);
    const html = await (await fetch(host.url)).text();
    assert.match(html, /<title>Workflow/);
    const script = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(script);
    assert.equal((await fetch(new URL(script, host.url))).status, 200);

    await writeFile(path.join(project, "input.txt"), "portable worker");
    await writeFile(
      path.join(project, "verify.ts"),
      `import {workflow,block,step,defineTool,z} from "workflow";
const read = defineTool({name:"read",description:"Read a file",replay:"safe",input:z.string(),output:z.string(),execute:(file,ctx)=>ctx.env.readText(file)});
export default workflow({name:"Portable",flow:step("verify",block({async run(ctx){
const text=await ctx.call(read,"input.txt");
const script=await ctx.exec(${JSON.stringify('printf \'console.log("embedded interpreter")\' | "$WORKFLOW_TEST_EXECUTABLE" run -')});
if(script.exitCode!==0 || !script.output.includes("embedded interpreter"))throw new Error(script.output);
ctx.summary(text);return text;}}))});`,
    );
    const run = JSON.parse(
      (await command(["run", "verify.ts", "--approve", "--wait", "--json"])).stdout,
    );
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.attempts[0].result.summary, "portable worker");
    assert.equal(existsSync(path.join(project, "node_modules")), false);
    assert.equal(existsSync(path.join(project, "dist")), false);
  },
);
