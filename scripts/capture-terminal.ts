import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { TextAttributes, TreeSitterClient, type RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { WorkflowClient } from "../src/client.js";
import { TerminalController } from "../src/tui/controller.js";
import { TerminalWorkspace } from "../src/tui/view.js";
import { colors } from "../src/tui/presentation.js";

// Capture the actual OpenTUI view against a running host. HTML only rasterizes
// its rendered character cells; it does not recreate or substitute UI content.
const { values } = parseArgs({ options: {
  server: { type: "string", default: "http://127.0.0.1:4310" },
  session: { type: "string" },
  output: { type: "string", default: "docs/screenshots/terminal-workspace.png" },
  screen: { type: "string", default: "chat" },
  step: { type: "string" },
  visit: { type: "string" },
  cols: { type: "string", default: "132" },
  rows: { type: "string", default: "44" },
} });
const cols = Number(values.cols), rows = Number(values.rows);
if (!Number.isInteger(cols) || cols < 40 || cols > 240 || !Number.isInteger(rows) || rows < 20 || rows > 100) throw new Error("Use 40–240 columns and 20–100 rows.");
if (!["chat", "graph", "session", "setup", "data"].includes(values.screen)) throw new Error("Use --screen chat, graph, session, setup, or data.");
const temporary = await mkdtemp(path.join(os.tmpdir(), "workflow-capture-"));
const ui = await createTestRenderer({ width: cols, height: rows, kittyKeyboard: true, backgroundColor: colors.base });
const controller = new TerminalController(new WorkflowClient({ baseUrl: values.server }));
const parser = new TreeSitterClient({ dataPath: temporary });
const view = new TerminalWorkspace(ui.renderer, controller, parser);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const color = (value: RGBA) => { const [r, g, b, a] = value.toInts(); return `rgba(${r},${g},${b},${a / 255})`; };
try {
  await parser.initialize();
  await Promise.all([parser.preloadParser("markdown"), parser.preloadParser("markdown_inline")]);
  await controller.initialize();
  if (values.session) await controller.openSessionById(values.session);
  if (values.screen !== "chat") await controller.submit(values.screen === "graph" ? "/graph" : values.screen === "setup" ? "/setup" : values.screen === "data" ? ["/data", values.step, values.visit].filter(Boolean).join(" ") : "/web");
  // Let the subscribed client and native Markdown renderer finish their frame.
  for (let i = 0; i < 4; i++) { await Bun.sleep(100); view.render(); await ui.renderOnce(); }
  const frame = ui.captureSpans();
  const lines = frame.lines.map(line => `<div class="line">${line.spans.map(span => {
    const styles = [`width:${span.width}ch`, `color:${color(span.fg)}`, `background:${color(span.bg)}`];
    if (span.attributes & TextAttributes.BOLD) styles.push("font-weight:700");
    if (span.attributes & TextAttributes.ITALIC) styles.push("font-style:italic");
    if (span.attributes & TextAttributes.UNDERLINE) styles.push("text-decoration:underline");
    return `<span style="${styles.join(";")}">${escape(span.text)}</span>`;
  }).join("")}</div>`).join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Workflow terminal capture</title><style>
    *{box-sizing:border-box}html,body{margin:0;background:${colors.base};color:${colors.text}}
    body{font:14px/20px "DejaVu Sans Mono",monospace;padding:16px;width:max-content}
    .line{height:20px;white-space:pre;width:${cols}ch}.line span{display:inline-block;height:20px;vertical-align:top}
  </style></head><body>${lines}</body></html>`;
  browser = await chromium.launch({ headless: true, ...(process.env.WORKFLOW_CHROMIUM_PATH ? { executablePath: process.env.WORKFLOW_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const bounds = await page.locator("body").boundingBox();
  if (!bounds) throw new Error("Terminal capture has no bounds");
  await page.setViewportSize({ width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) });
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  console.log(`Captured ${cols}×${rows} terminal cells from ${values.server}${values.session ? ` / ${values.session}` : ""} to ${output}`);
} finally {
  await browser?.close();
  view.destroy();
  await controller.close();
  await parser.destroy();
  await ui.dispose();
  await rm(temporary, { recursive: true, force: true });
}
