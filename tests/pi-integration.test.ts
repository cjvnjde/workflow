import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, vi } from "vitest";
import { z } from "zod";
import { runPiBlock } from "../src/core/execution/block-runner.js";
import { agentSchema, type UsageTotals } from "../src/contracts/domain.js";
import { createTemplate } from "../src/core/library/templates.js";
import { createAiPlan } from "../src/core/planning/planner.js";
import { generateLibraryChanges } from "../src/core/library/library-generator.js";
import { availableModels } from "../src/core/models/available-models.js";
import { initializeProfiles } from "../src/core/settings/initialize-profiles.js";
import { loadOrchestration } from "../src/core/settings/orchestration-settings.js";
import { fixture } from "./helpers.js";
import { Attachments } from "../src/core/tasks/attachments.js";

const requestSchema = z
  .object({
    messages: z.array(
      z.object({ role: z.string(), content: z.unknown().optional() }).passthrough(),
    ),
    tools: z.array(
      z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough(),
    ),
  })
  .passthrough();

test("real Pi sessions expose file and bash tools without inheriting history or ambient resources", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "workflow-pi-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(home, ".pi/agent"));
  t.onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });
  const { project, library } = await fixture(t);
  const requests: z.infer<typeof requestSchema>[] = [];
  let requestCount = 0;
  let structuredContinuation = -1;
  let valueSubmission: unknown;
  let loadSkill = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const received = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
        requests.push(received);
        requestCount += 1;
        const isCoordinator = received.tools.some((tool) => tool.function.name === "submit_plan");
        const isLibrary = received.tools.some((tool) => tool.function.name === "submit_library");
        const isDesigner = received.tools.some((tool) => tool.function.name === "propose_settings");
        let call = isDesigner
          ? {
              name: "propose_settings",
              arguments: JSON.stringify({
                message: "Created a project inspection profile.",
                json: JSON.stringify({
                  scope: "profiles",
                  summary: "Inspect with the available model",
                  coordinatorProfile: "inspector",
                  profiles: [
                    {
                      id: "inspector",
                      name: "Inspector",
                      description: "Use for read-only analysis and planning.",
                      enabled: true,
                      agent: { provider: "loopback", model: "local-test", thinking: "off" },
                    },
                  ],
                }),
              }),
            }
          : isLibrary
            ? {
                name: "submit_library",
                arguments: JSON.stringify({
                  json: JSON.stringify({
                    summary: "Use the available loopback model",
                    assignments: [
                      {
                        block: "custom-audit",
                        agent: { provider: "loopback", model: "local-test", thinking: "off" },
                        rationale: "Only available model; read-only audit uses no extra reasoning",
                      },
                    ],
                  }),
                }),
              }
            : isCoordinator
              ? {
                  name: "submit_plan",
                  arguments: JSON.stringify({
                    json: JSON.stringify({
                      title: "Read-only audit",
                      task: "Inspect only",
                      entry: "audit",
                      nodes: [
                        {
                          id: "audit",
                          block: "custom-audit",
                          label: "Audit",
                          goal: "Inspect the project without edits",
                          agent: { provider: "loopback", model: "local-test", thinking: "off" },
                          on: {
                            pass: "$complete",
                            retry: "audit",
                            fail: "$failed",
                          },
                        },
                      ],
                    }),
                  }),
                }
              : requestCount === 1
                ? {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "tests/locked.test.ts",
                      content: "// updated regression",
                    }),
                  }
                : {
                    name: "submit_result",
                    arguments: JSON.stringify({
                      outcome: "pass",
                      summary: "Updated the requested regression",
                      artifacts: { implementation: "Regression updated" },
                    }),
                  };
        const continuation = structuredContinuation < 0 ? -1 : structuredContinuation++;
        const prose = continuation === 0 || continuation === 2;
        if (continuation >= 0) {
          call = {
            name: "submit_result",
            arguments: JSON.stringify({
              outcome: "pass",
              summary: "Review completed",
              artifacts: { data: JSON.stringify({ approved: continuation === 1 ? "yes" : true }) },
            }),
          };
        }
        if (valueSubmission !== undefined) {
          call = { name: "submit_result", arguments: JSON.stringify({ value: valueSubmission }) };
          if (loadSkill) {
            loadSkill = false;
            call = { name: "load_skill", arguments: JSON.stringify({ id: "reference" }) };
          }
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = {
          id: `completion-${requestCount}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                ...(prose
                  ? { content: "The review is complete." }
                  : {
                      tool_calls: [
                        {
                          index: 0,
                          id: `call-${requestCount}`,
                          type: "function",
                          function: call,
                        },
                      ],
                    }),
              },
              finish_reason: null,
            },
          ],
        };
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: prose ? "stop" : "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agentDirectory = path.join(project, "isolated-pi-config");
  await mkdir(agentDirectory);
  await writeFile(
    path.join(agentDirectory, "models.json"),
    JSON.stringify({
      providers: {
        loopback: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "not-a-secret",
          models: [
            {
              id: "local-test",
              contextWindow: 32_000,
              maxTokens: 1000,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  await mkdir(path.join(project, "tests"));
  await writeFile(path.join(project, "tests/locked.test.ts"), "// immutable regression");
  await writeFile(path.join(project, "AGENTS.md"), "INHERITED_RESOURCE_MUST_NOT_APPEAR");
  await mkdir(path.join(project, ".pi/extensions"), { recursive: true });
  await writeFile(
    path.join(project, ".pi/extensions/unsafe.ts"),
    "throw new Error('Project extensions must not load')",
  );
  const previousDirectory = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = agentDirectory;
  t.onTestFinished(() => {
    if (previousDirectory === undefined) {
      delete process.env.WORKFLOW_HOME;
    } else {
      process.env.WORKFLOW_HOME = previousDirectory;
    }
  });
  const node = createTemplate("Fix", "bug", library).nodes.find(
    (candidate) => candidate.id === "work",
  );
  const bundle = library.blocks.fix;
  assert.ok(node && bundle);
  // Old block metadata must not reintroduce runtime file restrictions.
  bundle.definition.permissions = { read: [], write: [], deny: ["**/*"], writeDeny: ["**/*"] };
  const settings = agentSchema.parse({
    provider: "loopback",
    model: "local-test",
    thinking: "off",
  });
  const reportedUsage: UsageTotals[] = [];
  const first = await runPiBlock({
    project,
    config: library.config,
    bundle,
    node,
    workflow: {
      ...createTemplate("Implement, then publish after review", "bug", library),
      nodes: [
        node,
        { ...node, id: "publish", label: "Commit and push", goal: "Publish after verification" },
      ],
    },
    onUsage: async (usage) => {
      reportedUsage.push(usage);
    },
    task: "FIRST_SESSION_ONLY",
    inputs: { reproduction: "Regression evidence" },
    visit: 1,
    settings,
    signal: AbortSignal.timeout(10_000),
    emit: () => {},
  });
  assert.equal(first.outcome, "pass");
  assert.equal(reportedUsage.at(-1)?.inputTokens, 200);
  assert.equal(reportedUsage.at(-1)?.outputTokens, 100);
  assert.equal(reportedUsage.at(-1)?.requests, 2);
  assert.ok(Math.abs(reportedUsage.at(-1)!.costUsd - 0.0004) < 1e-10);
  assert.equal(
    await readFile(path.join(project, "tests/locked.test.ts"), "utf8"),
    "// updated regression",
  );
  assert.ok(
    requests[1]?.messages.some(
      (message) =>
        message.role === "tool" &&
        JSON.stringify(message.content).includes("Wrote tests/locked.test.ts"),
    ),
  );
  assert.ok(!JSON.stringify(requests[0]).includes("INHERITED_RESOURCE_MUST_NOT_APPEAR"));
  const userContent = requests[0]!.messages.find((message) => message.role === "user")!.content;
  const userText =
    typeof userContent === "string"
      ? userContent
      : z
          .array(z.object({ type: z.literal("text"), text: z.string() }))
          .parse(userContent)
          .map((part) => part.text)
          .join("\n");
  const currentPrompt = JSON.parse(userText);
  assert.equal(currentPrompt.overallTask, "FIRST_SESSION_ONLY");
  assert.equal(currentPrompt.currentStep.id, node.id);
  assert.equal(
    currentPrompt.workflow.find((step: { id: string }) => step.id === "publish").label,
    "Commit and push",
  );
  await runPiBlock({
    project,
    config: library.config,
    bundle,
    node,
    task: "SECOND_SESSION_ONLY",
    composition: {
      kind: "loop",
      id: "revise",
      label: "Revise",
      maxIterations: 3,
      condition: "review.approved",
      children: [
        {
          kind: "step",
          id: node.id,
          label: node.label,
          children: [],
          step: { reference: node.block, options: { on: { retry: "repeat" } } },
        },
      ],
    },
    inputs: {},
    visit: 2,
    settings,
    signal: AbortSignal.timeout(10_000),
    emit: () => {},
  });
  assert.equal(requests.length, 3);
  assert.ok(JSON.stringify(requests[2]).includes("SECOND_SESSION_ONLY"));
  const secondContent = requests[2]!.messages.find((message) => message.role === "user")!.content;
  const secondText =
    typeof secondContent === "string"
      ? secondContent
      : z
          .array(z.object({ type: z.literal("text"), text: z.string() }))
          .parse(secondContent)
          .map((part) => part.text)
          .join("\n");
  const composedPrompt = JSON.parse(secondText);
  assert.equal(
    composedPrompt.currentStep.routes,
    undefined,
    "Structured steps must not advertise placeholder legacy routes",
  );
  assert.equal(composedPrompt.composition.kind, "loop");
  assert.deepEqual(composedPrompt.composition.children[0].outcomes, {
    pass: "continue",
    retry: "repeat",
    fail: "stop",
  });
  assert.ok(!JSON.stringify(requests[2]).includes("FIRST_SESSION_ONLY"));
  library.config.coordinator = settings;
  const customAudit = {
    ...bundle,
    definition: {
      ...bundle.definition,
      id: "custom-audit",
      name: "Project-specific audit",
      description: "Use for read-only inspection without changing files.",
      permissions: { read: ["**/*"], write: [], deny: [], writeDeny: [] },
      outputs: [],
    },
    prompt: "Inspect only. Never modify project files.",
  };
  const proposal = await createAiPlan({
    project,
    library: {
      config: library.config,
      blocks: { "custom-audit": customAudit },
    },
    task: "Inspect only",
    instructions: "Read-only audit",
    signal: AbortSignal.timeout(10_000),
    emit: () => {},
  });
  assert.equal(proposal.nodes[0]?.block, "custom-audit");
  assert.deepEqual(requests[3]?.tools.map((tool) => tool.function.name).sort(), [
    "list_blocks",
    "load_block",
    "submit_plan",
  ]);
  assert.ok(JSON.stringify(requests[3]).includes("Available models"));
  const generated = await generateLibraryChanges({
    project,
    library: { config: library.config, blocks: { "custom-audit": customAudit } },
    kind: "models",
    models: (await availableModels(AbortSignal.timeout(10_000))).models,
    instructions: "Choose an available model for the audit",
    signal: AbortSignal.timeout(10_000),
    emit: () => {},
  });
  assert.equal(generated.blocks[0]?.bundle.definition.agent?.model, "local-test");
  assert.equal(generated.blocks[0]?.bundle.prompt, customAudit.prompt);
  assert.deepEqual(requests[4]?.tools.map((tool) => tool.function.name).sort(), [
    "bash",
    "edit_file",
    "git_changes",
    "list_blocks",
    "list_files",
    "load_block",
    "read_file",
    "submit_library",
    "write_file",
  ]);
  const failedUsage: UsageTotals[] = [];
  await assert.rejects(
    runPiBlock({
      project,
      config: library.config,
      bundle,
      node,
      task: "Stop at spending limit",
      inputs: {},
      visit: 3,
      settings,
      signal: AbortSignal.timeout(10_000),
      emit: () => {},
      maxCostUsd: 0.0001,
      onUsage: async (usage) => {
        failedUsage.push(usage);
      },
    }),
    /spending limit/,
  );
  assert.equal(requests.length, 6);
  assert.equal(failedUsage.at(-1)?.requests, 1);
  assert.ok(Math.abs(failedUsage.at(-1)!.costUsd - 0.0002) < 1e-10);

  const initialized = await initializeProfiles(
    project,
    { instructions: "Set up a read-only inspection role", signal: AbortSignal.timeout(10_000) },
    {
      catalog: async (signal) => ({
        models: (await availableModels(signal)).models.filter(
          (model) => model.provider === "loopback",
        ),
        warnings: [],
      }),
    },
  );
  assert.equal(initialized.status, "generated");
  assert.equal((await loadOrchestration(project)).settings.coordinatorProfile, "inspector");
  assert.deepEqual(requests[6]?.tools.map((tool) => tool.function.name).sort(), [
    "git_changes",
    "list_files",
    "propose_settings",
    "read_file",
    "reply_to_user",
    "workflow_inspect",
  ]);
  assert.ok(JSON.stringify(requests[6]).includes("read-only inspection role"));
  assert.ok(!JSON.stringify(requests[6]).includes("FIRST_SESSION_ONLY"));

  structuredContinuation = 0;
  const events: { kind: string; message: string }[] = [];
  const corrected = await runPiBlock({
    project,
    config: library.config,
    bundle: {
      ...customAudit,
      definition: {
        ...customAudit.definition,
        outputs: ["data"],
        outputSchema: z.toJSONSchema(z.object({ approved: z.boolean() })),
      },
    },
    node,
    task: "Review without editing",
    inputs: {},
    visit: 1,
    settings,
    signal: AbortSignal.timeout(10_000),
    emit: (kind, message) => {
      events.push({ kind, message });
    },
  });
  assert.deepEqual(JSON.parse(corrected.artifacts.data!), { approved: true });
  assert.equal(structuredContinuation, 4);
  assert.equal(events.filter((event) => event.kind === "agent_continuation").length, 2);
  assert.equal(events.filter((event) => event.kind === "tool_start").length, 2);
  assert.ok(
    events.some((event) => event.kind === "result_validation" && /boolean/.test(event.message)),
  );
  assert.match(JSON.stringify(requests.at(-1)), /Correct the rejected result/);
  assert.match(JSON.stringify(requests.at(-1)), /Do not repeat completed edits/);

  structuredContinuation = -1;
  valueSubmission = { outcome: "retry", feedback: "Add the missing boundary tests." };
  const valueResult = await runPiBlock({
    project,
    config: library.config,
    bundle: {
      ...customAudit,
      definition: {
        ...customAudit.definition,
        outputs: ["data"],
        outputSchema: z.toJSONSchema(
          z.object({ outcome: z.enum(["pass", "retry", "fail"]), feedback: z.string() }),
        ),
      },
    },
    node,
    task: "Inspect tests and return feedback to TypeScript",
    inputs: {},
    visit: 1,
    settings,
    signal: AbortSignal.timeout(10_000),
    emit: () => {},
    resultMode: "value",
  });
  assert.equal(
    valueResult.outcome,
    "pass",
    "The call succeeded; nested retry belongs to workflow code",
  );
  assert.deepEqual(JSON.parse(valueResult.artifacts.data!), valueSubmission);
  const valueTool = requests.at(-1)!.tools.find((tool) => tool.function.name === "submit_result")!;
  assert.deepEqual((valueTool.function.parameters as { required: string[] }).required, ["value"]);

  valueSubmission = "# Finished\n\nFocused tests added and passing.";
  const markdown = await runPiBlock({
    project,
    config: library.config,
    bundle: customAudit,
    node,
    task: "Return Markdown",
    inputs: {},
    visit: 1,
    settings,
    signal: AbortSignal.timeout(10_000),
    emit: () => {},
    resultMode: "value",
  });
  assert.equal(markdown.summary, valueSubmission);
  assert.deepEqual(markdown.artifacts, {});
  const attachment = await new Attachments(project).add({
    name: "brief.txt",
    mimeType: "text/plain",
    data: Buffer.from("Retained original-project attachment").toString("base64"),
  });
  const isolated = path.join(project, "isolated-checkout");
  await mkdir(isolated);
  await runPiBlock({
    project: isolated,
    attachmentProject: project,
    config: { ...library.config, attachments: [attachment] },
    bundle: customAudit,
    node,
    task: "Read the supplied brief",
    inputs: {},
    visit: 1,
    settings,
    signal: AbortSignal.timeout(10_000),
    emit: () => {},
    resultMode: "value",
  });
  assert.match(JSON.stringify(requests.at(-1)), /Retained original-project attachment/);
  valueSubmission = "docs: clarify setup";
  const textOnly = await runPiBlock({
    project,
    config: {
      ...library.config,
      capabilities: {
        skills: [],
        mcpServers: [
          {
            id: "unavailable",
            name: "Must not connect",
            enabled: true,
            transport: "stdio",
            command: "workflow-mcp-must-not-launch",
            args: [],
            url: "",
            tools: [],
            planningTools: [],
          },
        ],
      },
    },
    bundle: customAudit,
    node,
    task: "Draft a commit message",
    tools: "none",
    inputs: { "call-prompt": "Describe the supplied documentation diff" },
    visit: 1,
    settings,
    signal: AbortSignal.timeout(10000),
    emit: () => {},
    resultMode: "value",
  });
  assert.equal(textOnly.summary, valueSubmission);
  assert.deepEqual(
    requests.at(-1)!.tools.map((tool) => tool.function.name),
    ["submit_result"],
  );
  const sessionEvents: { kind: string; message: string }[] = [];
  const skillRequestIndex = requests.length;
  loadSkill = true;
  await runPiBlock({
    project,
    config: {
      ...library.config,
      capabilities: {
        skills: [
          {
            id: "reference",
            name: "Reference",
            description: "Use for API details",
            content: "SKILL_BODY_SENTINEL",
            enabled: true,
          },
        ],
        mcpServers: [],
      },
    },
    bundle: customAudit,
    node,
    task: "Inspect reference",
    inputs: {},
    visit: 1,
    settings,
    signal: AbortSignal.timeout(10000),
    resultMode: "value",
    capabilities: { skills: ["reference"], mcp: {} },
    emit: (kind, message) => sessionEvents.push({ kind, message }),
  });
  assert.ok(requests.at(-1)!.tools.some((tool) => tool.function.name === "load_skill"));
  assert.match(JSON.stringify(requests.at(-1)), /Use for API details/);
  assert.doesNotMatch(JSON.stringify(requests[skillRequestIndex]), /SKILL_BODY_SENTINEL/);
  assert.match(JSON.stringify(requests.at(-1)), /SKILL_BODY_SENTINEL/);
  assert.ok(sessionEvents.some((event) => event.kind === "skill_loaded"));
  assert.match(sessionEvents.find((e) => e.kind === "model_session")!.message, /local-test/);
  const end = JSON.parse(sessionEvents.find((e) => e.kind === "model_session_end")!.message);
  assert.ok(end.durationMs >= 0);
  assert.ok(end.usage.requests > 0);

  valueSubmission = "A focused answer";
  const isolatedCall = requests.length;
  await runPiBlock({
    project,
    config: {
      ...library.config,
      instructions: "INHERITED_PROJECT_SENTINEL",
      attachments: [attachment],
      commands: { private: { argv: ["INHERITED_COMMAND_SENTINEL"], timeoutMs: 1000 } },
      capabilities: {
        skills: [
          {
            id: "ambient",
            name: "Ambient",
            description: "INHERITED_SKILL_SENTINEL",
            content: "Inherited skill",
            enabled: true,
          },
        ],
        mcpServers: [],
      },
    },
    bundle: {
      ...customAudit,
      prompt: "EXPLICIT_CALL_INSTRUCTIONS",
      skills: [{ path: "ambient.md", content: "INHERITED_BLOCK_SKILL_SENTINEL" }],
    },
    node,
    task: "INHERITED_TASK_SENTINEL",
    workflow: createTemplate("INHERITED_GRAPH_SENTINEL", "bug", library),
    inputs: { unrelated: "INHERITED_INPUT_SENTINEL", "call-prompt": "EXPLICIT_FOCUSED_PROMPT" },
    context: "none",
    visit: 1,
    settings,
    signal: AbortSignal.timeout(10000),
    emit: () => {},
    resultMode: "value",
  });
  const focused = requests[isolatedCall]!;
  assert.match(JSON.stringify(focused), /EXPLICIT_CALL_INSTRUCTIONS/);
  const focusedContent = focused.messages.find((message) => message.role === "user")!.content;
  assert.equal(
    typeof focusedContent === "string"
      ? focusedContent
      : z
          .array(z.object({ text: z.string() }))
          .parse(focusedContent)
          .map((part) => part.text)
          .join(""),
    "EXPLICIT_FOCUSED_PROMPT",
  );
  assert.doesNotMatch(
    JSON.stringify(focused),
    /INHERITED_.*_SENTINEL|Retained original-project attachment/,
  );
  assert.ok(
    focused.tools.some((tool) => tool.function.name === "read_file"),
    "Context isolation does not remove project tools",
  );
  assert.ok(
    !focused.tools.some((tool) => tool.function.name === "load_skill"),
    "Ambient skills are excluded unless selected explicitly",
  );
});
