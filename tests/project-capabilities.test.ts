import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers.js";
import {
  discoverProjectCapabilities,
  mergeCapabilities,
} from "../src/core/tools/project-capabilities.js";
import { loadLibrary } from "../src/core/library/library.js";
import {
  loadOrchestration,
  saveOrchestration,
} from "../src/core/settings/orchestration-settings.js";
import { planningAgent } from "../src/core/planning/planning-model.js";
import { resolveAgentSettings } from "../src/contracts/domain.js";
import type { AvailableModel } from "../src/contracts/library-editor-schema.js";

test("project skills and MCP files are discovered, refreshed and not copied into saved overrides", async (t) => {
  const { project } = await fixture(t);
  await mkdir(path.join(project, ".agents/skills/keyboard"), { recursive: true });
  const skill = path.join(project, ".agents/skills/keyboard/SKILL.md");
  await writeFile(
    skill,
    "---\nname: keyboard\ndescription: Keyboard accessibility checks\n---\nCheck actual keyboard navigation.",
  );
  await writeFile(
    path.join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: { reference: { command: "node", args: ["${workspaceFolder}/reference.mjs"] } },
    }),
  );
  const first = await discoverProjectCapabilities(project);
  assert.equal(first.capabilities.skills[0]?.id, "keyboard");
  assert.match(first.capabilities.skills[0]!.content, /Resolve referenced resources relative/);
  assert.equal(first.capabilities.mcpServers[0]?.args[0], path.join(project, "reference.mjs"));
  assert.equal(first.capabilities.mcpServers[0]?.enabled, true);
  assert.equal((await loadLibrary(project)).config.capabilities?.skills[0]?.id, "keyboard");
  const state = await loadOrchestration(project);
  assert.equal(state.settings.capabilities.skills.length, 0);
  assert.equal(state.projectCapabilities.sources.length, 2);
  await saveOrchestration(project, state, []);
  await writeFile(
    skill,
    "---\nname: keyboard\ndescription: Updated keyboard checks\n---\nUpdated instructions.",
  );
  const next = await discoverProjectCapabilities(project);
  assert.match(next.capabilities.skills[0]!.content, /Updated instructions/);
  assert.doesNotMatch(first.capabilities.skills[0]!.content, /Updated instructions/);
  const disabled = { ...next.capabilities.skills[0]!, enabled: false };
  assert.equal(
    mergeCapabilities(next.capabilities, { skills: [disabled], mcpServers: [] }).skills[0]?.enabled,
    false,
  );
  await rm(skill);
  assert.equal((await discoverProjectCapabilities(project)).capabilities.skills.length, 0);
});

test("Codex MCP supports enabled flags and environment token references without exposing literal secrets", async (t) => {
  const { project } = await fixture(t);
  await mkdir(path.join(project, ".codex"));
  await writeFile(
    path.join(project, ".codex/config.toml"),
    '[mcp_servers.docs]\nurl="https://example.com/mcp"\nbearer_token_env_var="DOCS_TOKEN"\nenabled=false\n[mcp_servers.private]\ncommand="node"\n[mcp_servers.private.env]\nTOKEN="sensitive-test-value"\n',
  );
  const result = await discoverProjectCapabilities(project);
  assert.equal(result.capabilities.mcpServers.length, 1);
  assert.equal(result.capabilities.mcpServers[0]?.tokenEnv, "DOCS_TOKEN");
  assert.equal(result.capabilities.mcpServers[0]?.enabled, false);
  assert.equal(result.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-test-value/);
});

test("planning follows the configured default and only explicit coordinators override it", () => {
  const model = (id: string): AvailableModel => ({
    provider: "openai",
    id,
    name: id,
    reasoning: true,
    imageInput: true,
    thinkingLevels: ["low", "high"],
    contextWindow: 32000,
    maxTokens: 4000,
    cost: null,
  });
  const models = [model("gpt-6-luna"), model("gpt-5.6-terra"), model("gpt-6.1-sol")];
  const base = resolveAgentSettings({ provider: "openai", model: "gpt-6-luna", thinking: "low" });
  assert.equal(planningAgent(base, undefined, models).model, "gpt-6-luna");
  assert.equal(planningAgent(base, undefined, models).thinking, "low");
  assert.equal(
    planningAgent(base, { model: "gpt-5.6-terra", provider: "openai", thinking: "low" }, models)
      .model,
    "gpt-5.6-terra",
  );
  assert.equal(planningAgent(base, undefined, models.slice(0, 2)).model, "gpt-6-luna");
  assert.equal(planningAgent(base, undefined, []).model, "gpt-6-luna");
  assert.equal(planningAgent(resolveAgentSettings({}), undefined, models).model, "gpt-6.1-sol");
});

test("discovered project MCP is callable by execution without being copied to Workflow settings", async (t) => {
  const { project } = await fixture(t);
  const script = path.join(project, "reference.mjs");
  await writeFile(
    script,
    `import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
 const input=JSON.parse(line); if(input.id===undefined)continue;
 const result=input.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:input.method==='tools/list'?{tools:[{name:'lookup',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'Project reference reached'}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:input.id,result})+'\\n');
}`,
  );
  await writeFile(
    path.join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { reference: { command: process.execPath, args: [script] } } }),
  );
  const { mcpTools } = await import("../src/core/tools/mcp-tools.js");
  const library = await loadLibrary(project);
  const connection = await mcpTools(
    library.config.capabilities,
    project,
    AbortSignal.timeout(10000),
  );
  try {
    const result = await connection.tools[0]!.execute(
      "test",
      {},
      undefined,
      undefined,
      {} as never,
    );
    assert.match(JSON.stringify(result), /Project reference reached/);
  } finally {
    await connection.close();
  }
  assert.equal((await loadOrchestration(project)).settings.capabilities.mcpServers.length, 0);
});

test("discovered skills retain usable reference and script paths for execution tools", async (t) => {
  const { project } = await fixture(t);
  const base = path.join(project, ".agents/skills/format-note");
  await mkdir(path.join(base, "references"), { recursive: true });
  await mkdir(path.join(base, "scripts"));
  await writeFile(
    path.join(base, "SKILL.md"),
    "---\nname: format-note\ndescription: Format a short note\n---\nRead references/style.txt and run scripts/format.mjs.",
  );
  await writeFile(path.join(base, "references/style.txt"), "Use the prefix NOTE.");
  await writeFile(
    path.join(base, "scripts/format.mjs"),
    'import {readFileSync} from "node:fs"; const style=readFileSync(new URL("../references/style.txt",import.meta.url),"utf8");console.log(style+" Script executed.");',
  );
  const discovered = await discoverProjectCapabilities(project);
  assert.match(
    discovered.capabilities.skills[0]!.content,
    new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  const { Workspace } = await import("../src/core/storage/workspace.js");
  const { workspaceTools } = await import("../src/core/execution/block-runner.js");
  const tools = workspaceTools(
    await Workspace.create(project, { signal: AbortSignal.timeout(10000) }),
  );
  const reference = await tools
    .find((tool) => tool.name === "read_file")!
    .execute(
      "read",
      { path: path.join(base, "references/style.txt") },
      undefined,
      undefined,
      {} as never,
    );
  assert.match(JSON.stringify(reference), /Use the prefix NOTE/);
  const script = await tools
    .find((tool) => tool.name === "bash")!
    .execute(
      "run",
      { command: `node ${JSON.stringify(path.join(base, "scripts/format.mjs"))}` },
      undefined,
      undefined,
      {} as never,
    );
  assert.match(JSON.stringify(script), /Script executed/);
});
