import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initializeProject } from "../../src/library.js";
import { WorkflowEngine } from "../../src/engine.js";
import { runDemoBlock } from "../../src/block-runner.js";
import { createServer } from "../../src/server.js";
import { BrowserAuth } from "../../src/browser-auth.js";
import { authRuntime } from "../auth-fixture.js";
import { userPaths } from "../../src/user-settings.js";
import { Workspace } from "../../src/workspace.js";

const project = await mkdtemp(path.join(os.tmpdir(), "workflow-e2e-"));
const temporalCache = path.join(userPaths().directory, "cache", "temporal");
process.env.WORKFLOW_HOME = path.join(project, ".workflow-user");
// Keep credentials isolated, while avoiding a fresh executable download for
// every browser test fixture. Only the public Temporal binary cache is copied.
await cp(temporalCache, path.join(process.env.WORKFLOW_HOME, "cache", "temporal"), { recursive: true }).catch(error => {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
});
await initializeProject(project, "", "legacy");
process.env.WORKFLOW_DEMO_DELAY_MS = "400";
const engine = new WorkflowEngine(project, "demo", async execution => {
  if (execution.task.includes("[recovery-conflict]") && execution.node.id === "work") {
    const workspace = await Workspace.create(project, {journal:execution.journal});
    await workspace.write("recovery-fixture.txt", "managed change");
    await writeFile(path.join(project,"recovery-fixture.txt"),"external change");
    throw new Error("Interrupted recovery fixture");
  }
  if (execution.task.includes("[parallel-stream-fixture]")) {
    const frontend = execution.node.id === "stream-frontend";
    execution.emit("agent_start", "Deterministic parallel streaming fixture");
    execution.emit("text_delta", frontend ? "Inspecting frontend. " : "Inspecting backend. ");
    await delay(200, undefined, { signal: execution.signal });
    execution.emit("text_delta", frontend ? "Frontend notes stay here." : "Backend notes stay here.");
    await delay(frontend ? 6000 : 2500, undefined, { signal: execution.signal });
    return { outcome: "pass", summary: frontend ? "Frontend finished." : "Backend finished.", artifacts: {} };
  }
  if (execution.task.includes("[activity-fixture]") && execution.node.id === "work" && execution.visit === 1) {
    execution.emit("tool_start", 'read_file {"path":"src/example.ts"}');
    execution.emit("tool_end", "read_file: finished");
    execution.emit("tool_start", 'bash {"command":"bun test --filter regression","timeout":60}');
    execution.emit("tool_end", "bash: error\nRegression assertion failed: expected 5, received 4");
    execution.emit("check", "test: condition NOT met\nDetailed diagnostic for regression");
    execution.emit("usage", JSON.stringify({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0, requests: 2, costUsd: 0.0123 }));
  }
  if (execution.task.includes("[result-fixture]") && execution.node.id === "review") {
    return {
      outcome: "fail",
      summary: "Branch review blocked: this fixture has no comparison base. Passing checks do not complete the review.",
      artifacts: Object.fromEntries(execution.bundle.definition.outputs.map(name => [name, [
        "## Review status: blocked", "", "**Comparison base unavailable.**", "", "- No source files were changed.", "- Supply the intended base.", "",
        "| Check | Result |", "| --- | --- |", "| Unit tests | Passed |", "",
        "```ts", "const reviewed = false;", "```", "",
        '<img src=\"https://example.invalid/track\" onerror=\"window.markdownInjected = true\">',
        '<script>window.markdownInjected = true</script>', "[Unsafe link](javascript:alert(1))",
      ].join("\n")])),
    };
  }
  return await runDemoBlock(execution);
});
await engine.initialize();
const connections = new Map<string, "oauth" | "api_key">();
const runtime = authRuntime(async (provider, method, interaction) => {
  if (method === "oauth") {
    interaction.notify({ type: "auth_url", url: "https://auth.openai.com/test-sign-in", instructions: "Complete sign-in, then return here." });
    await interaction.prompt({ type: "manual_code", message: "Paste test callback" });
  } else {
    await interaction.prompt({ type: "secret", message: "Enter test API key" });
  }
  connections.set(provider, method);
  return { type: "api_key", key: "test-only" };
});
runtime.logout = async (provider?: string) => { if (provider) { connections.delete(provider); } };
const server = await createServer(engine, 4311, {
  design: async (options) => {
    options.emit("tool_start", "Inspecting project settings…");
    await new Promise((resolve) => setTimeout(resolve, 400));
    options.signal.throwIfAborted();
    const message = options.messages.at(-1)!.content;
    if (/explain/i.test(message)) { return { message: "The proposal uses your connected catalog and preserves the other settings sections." }; }
    if (options.scope === "profiles") {
      const one = /one profile/i.test(message);
      if (one && !options.previous) { throw new Error("Expected the earlier proposal during refinement"); }
      const profiles = (one ? ["Project lead"] : ["Deliberate review", "Routine helper"]).map((name, index) => ({ id: name.toLowerCase().replaceAll(" ", "-"), name, description: `Use for ${index ? "routine summaries and straightforward changes" : "planning, difficult implementation and independent review"}.`, enabled: true, agent: { provider: "openai", model: "test-model", thinking: index ? "off" as const : "high" as const } }));
      return { message: one ? "Refined the earlier proposal into one project lead profile." : "I drafted roles from the available catalog. You can refine them before applying.", proposal: { scope: "profiles", summary: one ? "One profile for project leadership" : "A focused pair of model roles", profiles, coordinatorProfile: profiles[0]!.id } };
    }
    if (options.scope === "blocks") {
      const bundle = structuredClone(options.library.blocks.review!);
      bundle.prompt = message;
      bundle.definition.agent = { provider: "openai", model: "test-model", thinking: "high" };
      return { message: "Updated the review instructions while preserving outputs and permissions.", proposal: { scope: "blocks", summary: "Focused independent review", changes: { summary: "Focused independent review", blocks: [{ bundle, rationale: "Review should cite independent acceptance evidence" }] } } };
    }
    if (options.scope === "cases") { return { message: "Added release readiness instructions.", proposal: { scope: "cases", summary: "Release readiness case", cases: [...options.settings.cases.filter((item) => item.id !== "release-ai"), { id: "release-ai", name: "Release readiness", description: "Prepare a release", instructions: message, enabled: true }], instructions: options.settings.instructions, suggestBlocks: options.settings.suggestBlocks } }; }
    if (options.scope === "capabilities") { return { message: "Added a project skill.", proposal: { scope: "capabilities", summary: "Coding conventions", capabilities: { ...options.settings.capabilities, skills: [...options.settings.capabilities.skills.filter((item) => item.id !== "conventions-ai"), { id: "conventions-ai", name: "AI coding conventions", description: "Project coding style", content: message, enabled: true }] } } }; }
    const { instructions, commands, budget } = options.library.config;
    return { message: "Reduced the workflow limit.", proposal: { scope: "execution", summary: "Maximum 15 steps", settings: { instructions, commands, budget, maxSteps: 15 } } };
  },
  auth: new BrowserAuth(async () => runtime),
  providers: async () => [...connections].map(([id, method]) => ({ id, name: id === "openai" ? "OpenAI" : "Test provider", method, source: "stored" as const })),
  catalog: async () => ({ warnings: [], models: [...connections.keys()].map((provider) => ({ provider, id: "test-model", name: "Test model", reasoning: true, thinkingLevels: ["off", "medium", "high"], contextWindow: 128000, maxTokens: 8000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })) }),
});
await server.listen({ port: 4311, host: "127.0.0.1" });

const shutdown = async () => {
  await server.close();
  await rm(project, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}
