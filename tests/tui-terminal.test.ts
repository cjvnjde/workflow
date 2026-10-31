import assert from "node:assert/strict";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixture } from "./helpers.js";
import { userPaths } from "../src/infrastructure/user-paths.js";
import { projectHostStatus, stopProjectHost } from "../src/host/host-lifecycle.js";
import { WorkflowClient, waitForRun } from "../src/client/client.js";

const root = fileURLToPath(new URL("../", import.meta.url));

for (const args of [[], ["start"], ["tui"]]) {
  test(`packaged ${args[0] ?? "default"} opens the TUI, detaches while work continues, and restores the terminal`, async (t) => {
    const { project, cleanup } = await fixture(t);
    cleanup(() => stopProjectHost(project, 0));
    const home = path.join(project, "private-user-settings");
    await mkdir(home);
    await cp(
      path.join(userPaths().directory, "cache", "temporal"),
      path.join(home, "cache", "temporal"),
      { recursive: true },
    ).catch(() => {});
    let output = "";
    const listeners = new Set<() => void>();
    const child = Bun.spawn(
      [process.execPath, path.join(root, "dist/cli.js"), ...args, "--demo", "--port", "0"],
      {
        cwd: project,
        env: {
          ...process.env,
          WORKFLOW_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          WORKFLOW_DEMO_DELAY_MS: "400",
        },
        terminal: {
          cols: 120,
          rows: 36,
          data: (_terminal, data) => {
            output += new TextDecoder().decode(data);
            for (const listener of listeners) listener();
          },
        },
      },
    );
    assert.ok(child.terminal);
    const terminal = child.terminal;
    const waitFor = async (pattern: RegExp) => {
      // eslint-disable-next-line no-control-regex -- Control bytes must be matched explicitly for validation or terminal escape removal.
      const matches = () => pattern.test(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
      if (matches()) return;
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (matches()) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Terminal did not show ${pattern}: ${output.slice(-12000)}`));
        }, 20_000);
        listeners.add(check);
        void child.exited.then((code) => {
          if (listeners.delete(check)) {
            clearTimeout(timer);
            reject(new Error(`Terminal exited ${code}: ${output.slice(-5000)}`));
          }
        });
      });
    };
    try {
      await waitFor(/Background host started/);
      const started = await projectHostStatus(project, 0);
      assert.equal(started.status, "running");
      if (started.status !== "running") throw new Error("TUI did not start its host");
      const client = new WorkflowClient({ baseUrl: started.url });
      terminal.write("Create a greeting feature\r");
      await waitFor(/Approve & start/);
      terminal.write("/approve\r");
      const summary = (await client.runs())[0]!;
      assert.ok(summary);
      let run = await client.run(summary.id);
      for (let i = 0; i < 100 && run.status === "draft"; i++) {
        await Bun.sleep(50);
        run = await client.run(run.id);
      }
      assert.equal(run.status, "running", "The real run must be active when the terminal quits");
      terminal.resize(72, 24);
      terminal.write("\x03");
      const code = await Promise.race([
        child.exited,
        Bun.sleep(8000).then(() => {
          throw new Error(`TUI did not exit: ${output.slice(-3000)}`);
        }),
      ]);
      assert.equal(code, 0);
      assert.ok(output.includes("\x1b[?1049l"), "alternate screen must be restored");
      const host = await projectHostStatus(project, 0);
      assert.equal(host.status, "running");
      if (host.status !== "running") throw new Error("TUI stopped its background host");
      assert.equal(host.hostId, started.hostId);
      assert.equal(
        (await waitForRun(() => client.run(run.id), { signal: AbortSignal.timeout(15_000) }))
          .status,
        "completed",
      );
      const cli = await readFile(path.join(root, "dist/cli.js"), "utf8");
      assert.ok(
        !cli.includes('from "@opentui/core"'),
        "non-TUI commands must not eagerly load the native renderer",
      );
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      terminal.close();
    }
  });
}

test("packaged TUI rejects noninteractive execution without starting a renderer", async () => {
  const child = Bun.spawn([process.execPath, path.join(root, "dist/cli.js"), "tui"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const error = await new Response(child.stderr).text();
  assert.equal(await child.exited, 1);
  assert.match(error, /requires an interactive terminal/);
});
