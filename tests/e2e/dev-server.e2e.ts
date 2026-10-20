import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import config from "../../vite.config.js";

test("Vite serves client modules as JavaScript and proxies only API routes", async ({ page, baseURL }) => {
  if (!baseURL) { throw new Error("The test backend URL is required"); }
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "workflow-vite-test-"));
  const server = await createServer({
    ...config,
    configFile: false,
    root: fileURLToPath(new URL("../../web/", import.meta.url)),
    cacheDir,
    logLevel: "error",
    server: {
      ...config.server,
      host: "127.0.0.1",
      port: 0,
      open: false,
      // Use the application's matching rules against the isolated test backend.
      proxy: Object.fromEntries(Object.keys(config.server?.proxy ?? {}).map((prefix) => [prefix, baseURL])),
    },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") { throw new Error("Vite did not start an HTTP server"); }
    const origin = `http://127.0.0.1:${address.port}`;
    for (const pathname of ["/api.ts", "/api.ts?t=1"]) {
      const module = await page.request.get(`${origin}${pathname}`);
      expect(module.status()).toBe(200);
      expect(module.headers()["content-type"]).toMatch(/javascript/);
      expect(await module.text()).toContain("export");
    }
    const project = await page.request.get(`${origin}/api/project`);
    expect(project.ok()).toBe(true);
    expect((await project.json()).blocks.review).toBeTruthy();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await expect(page.getByRole("heading", { name: "What should we work on?", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Providers & models", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Providers & models", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    const favicon = page.locator('link[rel="icon"]');
    await expect(favicon).toHaveAttribute("href", "/favicon.svg");
    const icon = await page.request.get(`${origin}/favicon.svg`);
    expect(icon.ok()).toBe(true);
    expect(icon.headers()["content-type"]).toMatch(/image\/svg\+xml/);
  } finally {
    await page.goto("about:blank");
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
