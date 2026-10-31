import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "vitest";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SecretInput } from "../src/terminal/secret-input.js";

const root = fileURLToPath(new URL("../", import.meta.url));

async function terminalFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-terminal-"));
  const bin = path.join(directory, "bin");
  const home = path.join(directory, "home");
  await mkdir(bin);
  await mkdir(home);
  await symlink(path.join(root, "dist/cli.js"), path.join(bin, "workflow"));
  const bun = Bun.which("bun");
  assert.ok(bun);
  await symlink(bun, path.join(bin, "bun"));
  t.onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return {
    directory,
    home,
    env: {
      PATH: bin,
      HOME: directory,
      WORKFLOW_HOME: home,
      TERM: "xterm-256color",
      PI_OFFLINE: "1",
    },
  };
}

function interactive(args: string[], context: Awaited<ReturnType<typeof terminalFixture>>) {
  let output = "";
  const listeners = new Set<() => void>();
  const child = Bun.spawn(["workflow", ...args], {
    cwd: context.directory,
    env: context.env,
    terminal: {
      cols: 80,
      rows: 24,
      data: (_terminal, data) => {
        output += new TextDecoder().decode(data);
        for (const listener of listeners) {
          listener();
        }
      },
    },
  });
  assert.ok(child.terminal);
  const terminal = child.terminal;
  const waitFor = async (pattern: RegExp) => {
    if (pattern.test(output)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const listener = () => {
        if (pattern.test(output)) {
          clearTimeout(timeout);
          listeners.delete(listener);
          resolve();
        }
      };
      const timeout = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`Terminal did not render ${pattern}: ${output}`));
      }, 10_000);
      listeners.add(listener);
      void child.exited.then((code) => {
        if (listeners.delete(listener)) {
          clearTimeout(timeout);
          reject(new Error(`Terminal exited ${code} before ${pattern}: ${output}`));
        }
      });
    });
  };

  return { child, terminal, waitFor, output: () => output };
}

test("secret input preserves Pi editing while masking every rendered value at narrow widths", () => {
  const input = new SecretInput();
  input.focused = true;
  input.handleInput("sk-test-private-value");
  input.handleInput("\x1b[D");
  input.render(12);
  input.handleInput("X");
  assert.equal(input.getValue(), "sk-test-private-valuXe");
  for (const width of [6, 12, 80]) {
    const rendered = input.render(width);
    assert.ok(rendered.every((line) => visibleWidth(line) <= width));
    assert.ok(!rendered.join("\n").includes("private"));
    assert.ok(rendered.join("\n").includes("*"));
  }
});

test("workflow login uses a real Pi TUI with no Pi/Node on PATH and stores keys privately", async (t) => {
  const context = await terminalFixture(t);
  const session = interactive(["login", "openai"], context);
  const key = "sk-workflow-test-NOT-A-REAL-SECRET";
  try {
    await session.waitFor(/Sign in with an API key/);
    session.terminal.write("\x1b[B\r");
    await session.waitFor(/Input is hidden/);
    session.terminal.write(key + "\r");
    await session.waitFor(/to select/);
    session.terminal.write("\r");
    assert.equal(await session.child.exited, 0);
    const credentials = z
      .object({ openai: z.object({ type: z.literal("api_key"), key: z.string() }) })
      .parse(JSON.parse(await readFile(path.join(context.home, "auth.json"), "utf8")));
    assert.equal(credentials.openai.key, key);
    assert.equal((await stat(path.join(context.home, "auth.json"))).mode & 0o777, 0o600);
    const settings = z
      .object({ agent: z.object({ provider: z.literal("openai"), model: z.string() }) })
      .parse(JSON.parse(await readFile(path.join(context.home, "settings.json"), "utf8")));
    assert.ok(settings.agent.model);
    assert.ok(!session.output().includes(key), "raw keys must never appear in terminal output");
    const status = Bun.spawn(["workflow", "auth"], {
      cwd: context.directory,
      env: context.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const metadata = await new Response(status.stdout).text();
    assert.equal(await status.exited, 0);
    assert.match(metadata, /openai · api_key/);
    assert.ok(!metadata.includes(key));
  } finally {
    if (session.child.exitCode === null) {
      session.child.kill();
      await session.child.exited;
    }
    session.terminal.close();
  }
});

test("cancelling a hidden API-key prompt does not save the typed secret", async (t) => {
  const context = await terminalFixture(t);
  const session = interactive(["login", "openai"], context);
  const key = "sk-cancelled-NOT-A-REAL-SECRET";
  try {
    await session.waitFor(/Sign in with an API key/);
    session.terminal.write("\x1b[B\r");
    await session.waitFor(/Input is hidden/);
    session.terminal.write(key);
    session.terminal.write("\x1b");
    assert.equal(await session.child.exited, 0);
    assert.match(session.output(), /Setup cancelled/);
    const credentials: unknown = JSON.parse(
      await readFile(path.join(context.home, "auth.json"), "utf8"),
    );
    assert.deepEqual(credentials, {});
    assert.ok(!session.output().includes(key));
  } finally {
    if (session.child.exitCode === null) {
      session.child.kill();
      await session.child.exited;
    }
    session.terminal.close();
  }
});

test("cancelling terminal setup creates no credential and restores the terminal", async (t) => {
  const context = await terminalFixture(t);
  const session = interactive(["login"], context);
  try {
    await session.waitFor(/Sign in with an account/);
    session.terminal.write("\x1b");
    assert.equal(await session.child.exited, 0);
    assert.match(session.output(), /Login cancelled/);
    const credentials: unknown = JSON.parse(
      await readFile(path.join(context.home, "auth.json"), "utf8"),
    );
    assert.deepEqual(credentials, {});
    assert.ok(session.output().includes("\x1b[?1049l"), "alternate screen must be restored");
  } finally {
    if (session.child.exitCode === null) {
      session.child.kill();
      await session.child.exited;
    }
    session.terminal.close();
  }
});
