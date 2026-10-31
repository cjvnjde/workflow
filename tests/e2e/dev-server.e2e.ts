import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("source workflow serves the dev web app and API on the host port", async ({ page }) => {
  test.setTimeout(60_000);
  const projectDirectory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "workflow-source-web-")),
  );
  const cli = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
  await writeFile(
    path.join(projectDirectory, "package.json"),
    JSON.stringify({ scripts: { workflow: `bun ${JSON.stringify(cli)}` } }),
  );
  const execute = promisify(execFile);
  const command = (args: string[]) =>
    execute("bun", ["run", "workflow", ...args], {
      cwd: projectDirectory,
      env: { ...process.env, PI_OFFLINE: "1" },
      timeout: 30_000,
    });
  try {
    await command(["init"]);
    const { stdout } = await command(["--background", "--demo", "--port", "0", "--json"]);
    const { url: origin } = JSON.parse(stdout) as { url: string };
    for (const pathname of ["/shared/api.ts", "/shared/api.ts?t=1"]) {
      const module = await page.request.get(`${origin}${pathname}`);
      expect(module.status()).toBe(200);
      expect(module.headers()["content-type"]).toMatch(/javascript/);
    }
    const project = await page.request.get(`${origin}/api/project`);
    expect(project.ok()).toBe(true);
    expect((await project.json()).project).toBe(projectDirectory);
    const missingApi = await page.request.get(`${origin}/api/does-not-exist`);
    expect(missingApi.status()).toBe(404);
    expect(missingApi.headers()["content-type"]).toMatch(/application\/json/);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await expect(
      page.getByRole("heading", { name: "What should we work on?", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Providers & models", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Providers & models", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    const favicon = page.locator('link[rel="icon"]');
    await expect(favicon).toHaveAttribute("href", "/favicon.svg");
    const icon = await page.request.get(`${origin}/favicon.svg`);
    expect(icon.ok()).toBe(true);
    expect(icon.headers()["content-type"]).toMatch(/image\/svg\+xml/);
  } finally {
    await page.goto("about:blank");
    await command(["stop"]);
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
