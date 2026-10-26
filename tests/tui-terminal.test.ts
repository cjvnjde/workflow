import assert from "node:assert/strict";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixture } from "./helpers.js";
import { userPaths } from "../src/user-settings.js";

const root = fileURLToPath(new URL("../", import.meta.url));

test("packaged OpenTUI workspace runs a task in a real terminal and restores the terminal on quit", async t => {
  const { project } = await fixture(t);
  const home = path.join(project, "private-user-settings");
  await mkdir(home);
  await cp(path.join(userPaths().directory, "cache", "temporal"), path.join(home, "cache", "temporal"), { recursive: true }).catch(() => {});
  let output = "";
  const listeners = new Set<() => void>();
  const child = Bun.spawn([process.execPath, path.join(root, "dist/cli.js"), "tui", "--demo", "--port", "0"], {
    cwd: project,
    env: { ...process.env, WORKFLOW_HOME: home, PI_OFFLINE: "1", TERM: "xterm-256color", WORKFLOW_DEMO_DELAY_MS: "80" },
    terminal: { cols: 120, rows: 36, data: (_terminal, data) => {
      output += new TextDecoder().decode(data);
      for (const listener of listeners) listener();
    } },
  });
  assert.ok(child.terminal);
  const terminal = child.terminal;
  const waitFor = async (pattern: RegExp) => {
    const matches = () => pattern.test(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
    if (matches()) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => { if (matches()) { clearTimeout(timer); listeners.delete(check); resolve(); } };
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Terminal did not show ${pattern}: ${output.slice(-12000)}`)); }, 20_000);
      listeners.add(check);
      void child.exited.then(code => { if (listeners.delete(check)) { clearTimeout(timer); reject(new Error(`Terminal exited ${code}: ${output.slice(-5000)}`)); } });
    });
  };
  try {
    await waitFor(/Local engine/);
    terminal.write("Create a greeting feature\r");
    await waitFor(/Approve & start/);
    terminal.write("/approve\r");
    await waitFor(/Workflow finished|completed/);
    terminal.write("/sessions\r");
    await waitFor(/Choose a task to reopen/);
    terminal.resize(72, 24);
    terminal.write("\x1b");
    terminal.write("\x03");
    const code = await Promise.race([child.exited, Bun.sleep(8000).then(() => { throw new Error(`TUI did not exit: ${output.slice(-3000)}`); })]);
    assert.equal(code, 0);
    assert.ok(output.includes("\x1b[?1049l"), "alternate screen must be restored");
    const cli = await readFile(path.join(root, "dist/cli.js"), "utf8");
    assert.ok(!cli.includes('from "@opentui/core"'), "non-TUI commands must not eagerly load the native renderer");
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; terminal.close(); }
});

test("packaged TUI rejects noninteractive execution without starting a renderer", async () => {
  const child = Bun.spawn([process.execPath, path.join(root, "dist/cli.js"), "tui"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const error = await new Response(child.stderr).text();
  assert.equal(await child.exited, 1);
  assert.match(error, /requires an interactive terminal/);
});
