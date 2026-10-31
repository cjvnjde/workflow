import { mkdir } from "node:fs/promises";
import { test as baseTest } from "vitest";
import {
  chromium,
  request as playwrightRequest,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

export const baseURL = "http://127.0.0.1:4311";

type BrowserFixtures = {
  baseURL: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  request: APIRequestContext;
};

export const test = baseTest.extend<BrowserFixtures>({
  baseURL,
  browser: [
    // Vitest requires a destructured fixture context even when there are no dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const browser = await chromium.launch({
        headless: true,
        ...(process.env.WORKFLOW_CHROMIUM_PATH
          ? { executablePath: process.env.WORKFLOW_CHROMIUM_PATH }
          : {}),
      });
      try {
        await use(browser);
      } finally {
        await browser.close();
      }
    },
    { scope: "file" },
  ],
  context: async ({ browser, baseURL, task }, use) => {
    const context = await browser.newContext({ baseURL });
    context.setDefaultTimeout(30_000);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    try {
      await use(context);
    } finally {
      if (task.result?.state === "fail") {
        await mkdir("test-results", { recursive: true });
        await context.tracing.stop({ path: `test-results/${task.id}.zip` });
      } else {
        await context.tracing.stop();
      }
      await context.close();
    }
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
  },
  request: async ({ baseURL }, use) => {
    const request = await playwrightRequest.newContext({ baseURL });
    try {
      await use(request);
    } finally {
      await request.dispose();
    }
  },
});
