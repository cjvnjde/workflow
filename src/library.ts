import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  agentOverrideSchema,
  resolveAgentSettings,
  blockSchema,
  configSchema,
  type BlockBundle,
  type Library,
} from "./domain.js";
import { loadUserSettings } from "./user-settings.js";
import { approvedLibrarySchema } from "./library-editor-schema.js";
import { pushScript } from "./script-examples.js";
import { codeBundle } from "./code-migration.js";
import { formatBlock } from "./source-format.js";
import { scriptLibrary } from "./script-migration.js";

export async function loadLibrary(project: string): Promise<Library> {
  const directory = path.join(project, ".workflow");
  const raw = configSchema.extend({ agent: agentOverrideSchema.optional() }).parse(
    JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")),
  );
  const defaults = (await loadUserSettings()).agent;
  const config = configSchema.parse({ ...raw, agent: resolveAgentSettings(defaults, raw.agent) });
  try {
    const saved = approvedLibrarySchema.parse(JSON.parse(await readFile(path.join(directory, "library.json"), "utf8")));
    validateLibraryResources(saved.blocks, config.commands);
    return scriptLibrary({ config, blocks: saved.blocks });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { throw error; }
  }
  const blocks: Record<string, BlockBundle> = {};
  for (const entry of await readdir(path.join(directory, "blocks"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const blockDirectory = path.join(directory, "blocks", entry.name);
    const root = await realpath(blockDirectory);
    const readResource = async (resource: string) => {
      const filename = await realpath(path.resolve(root, resource));
      const info = await lstat(filename);
      if (
        !filename.startsWith(root + path.sep) ||
        !info.isFile() || info.size > 128_000
      ) {
        throw new Error(
          `Block resource must stay inside its directory, be a regular file, and remain below 128 KB: ${resource}`,
        );
      }

      return await readFile(filename, "utf8");
    };
    const rawDefinition = JSON.parse(await readFile(path.join(blockDirectory, "block.json"), "utf8"));
    if (rawDefinition.executor?.kind === "code" && typeof rawDefinition.executor.file === "string") {
      const { file, ...executor } = rawDefinition.executor;
      rawDefinition.executor = { ...executor, source: await readResource(file) };
    }
    const definition = blockSchema.parse(rawDefinition);
    if (definition.id !== entry.name || blocks[definition.id]) {
      throw new Error(
        `Block ID must match its unique directory: ${entry.name}`,
      );
    }
    for (const check of definition.checks) {
      if (!config.commands[check.command]) {
        throw new Error(
          `Block ${definition.id} uses undefined command ${check.command}`,
        );
      }
    }
    const skills = await Promise.all(
      definition.skills.map(async (resource) => ({
        path: resource,
        content: await readResource(resource),
      })),
    );
    blocks[definition.id] = {
      definition,
      prompt: await readResource("prompt.md").catch(error => {
        if (definition.executor?.kind === "code" && error instanceof Error && "code" in error && error.code === "ENOENT") return "Behavior is defined in TypeScript.";
        throw error;
      }),
      skills,
    };
  }
  validateLibraryResources(blocks, config.commands);

  return scriptLibrary({ config, blocks });
}

export function validateLibraryResources(blocks: Library["blocks"], commands: Library["config"]["commands"]) {
  if (!Object.keys(blocks).length || Object.keys(blocks).length > 50) { throw new Error("A library requires 1–50 blocks"); }
  for (const [id, bundle] of Object.entries(blocks)) {
    if (id !== bundle.definition.id) { throw new Error(`Block ID must match its key: ${id}`); }
    if (bundle.definition.executor?.kind === "command" && !commands[bundle.definition.executor.command]) { throw new Error(`Block ${id} uses undefined command ${bundle.definition.executor.command}`); }
    for (const check of bundle.definition.checks) {
      if (!commands[check.command]) { throw new Error(`Block ${id} uses undefined command ${check.command}`); }
    }
    const resources = new Set<string>();
    for (const skill of bundle.skills) {
      if (!skill.path || skill.path.includes("\\") || path.posix.isAbsolute(skill.path) ||
          skill.path.split("/").some((part) => !part || part === "." || part === "..") ||
          ["prompt.md", "block.json"].includes(skill.path) || resources.has(skill.path)) {
        throw new Error(`Invalid or duplicate block resource: ${skill.path}`);
      }
      resources.add(skill.path);
      if (Buffer.byteLength(skill.content) > 128_000) { throw new Error(`Block resource exceeds 128 KB: ${skill.path}`); }
    }
    if (Buffer.byteLength(bundle.prompt) > 128_000 || bundle.definition.skills.length !== resources.size ||
        new Set(bundle.definition.skills).size !== resources.size || bundle.definition.skills.some((resource) => !resources.has(resource))) {
      throw new Error(`Block ${id} has invalid prompt/skill resources`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(blocks)) > 700_000) { throw new Error("Block library is too large; reduce prompts/resources below 700 KB"); }
}

export async function initializeProject(project: string, instructions = "", format: "code" | "legacy" = "code") {
  const directory = path.join(project, ".workflow");
  await mkdir(directory, { recursive: true });
  let scripts: Record<string, string> = {};
  try {
    const manifest = z
      .object({ scripts: z.record(z.string(), z.string()).default({}) })
      .parse(
        JSON.parse(await readFile(path.join(project, "package.json"), "utf8")),
      );
    scripts = manifest.scripts;
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  const hasTests =
    !!scripts.test && !scripts.test.includes("no test specified");
  const config = configSchema.parse({
    version: 1,
    instructions,
    commands: hasTests ? { test: { argv: ["bun", "run", "test"] } } : {},
  });
  // Exclusive creation prevents init from silently replacing a reviewed policy.
  await writeFile(
    path.join(directory, "config.json"),
    JSON.stringify({ ...config, agent: {} }, null, 2) + "\n",
    { flag: "wx" },
  );
  const successChecks: BlockBundle["definition"]["checks"] = hasTests
    ? [{ command: "test", expect: "success" }]
    : [];
  const specifications: (Omit<BlockBundle["definition"], "skills"> & { prompt: string })[] = [
    {
      id: "push",
      name: "Push current branch",
      description: "Publish existing commits to the current branch's remote, creating the remote branch and upstream when needed. Use only when publication is requested, after implementation, checks and commit creation. No AI call.",
      executor: pushScript(),
      outputs: ["publication"],
      checks: [],
      prompt: "Push the current branch using the configured Git remote. This editable script publishes existing commits. Route failure diagnostics to a repair step or stop. Modify the script source to change its behavior.",
    },
    {
      id: "requirements",
      name: "Define requirements",
      description:
        "For a new feature or unclear task, produce observable acceptance criteria before implementation.",
      outputs: ["requirements"],
      checks: [],
      prompt:
        "Read the project and task. Produce concise, testable acceptance criteria and relevant constraints. Do not modify files. Publish a requirements artifact. If the task cannot be specified safely, return fail with the questions that must be answered.",
    },
    {
      id: "reproduce",
      name: "Reproduce bug",
      description:
        "For a bug, add a focused regression test that fails for the reported behavior. Tests only, never production code.",
      outputs: ["reproduction"],
      checks: hasTests ? [{ command: "test", expect: "failure" }] : [],
      prompt:
        "Write a focused regression test that reproduces the reported bug. Do not edit production code. Run the configured check and confirm the failure is the reported behavior, not a syntax, setup, or unrelated failure. Publish reproduction with the test path and failure evidence. Return retry if you have not reproduced it. A nonzero exit alone is not proof of reproduction.",
    },
    {
      id: "implement",
      name: "Implement feature",
      description:
        "Implement agreed production changes. Test-only failures belong to the test author; require a separate acceptance gate.",
      outputs: ["implementation"],
      checks: [],
      prompt:
        "Implement the agreed requirements using production code only. Read verification/review feedback and correct production defects. Do not create or edit tests, including test-code type errors; describe any required test correction in the implementation artifact for the independent test-authoring step. Preserve independent test expectations. Update source, dependencies and configuration when the task requires it, without weakening checks. Use the smallest coherent change and run relevant checks. Publish implementation with what changed, the check results, and any test-only repair still needed. Return retry if production work is unfinished. If only an identified test-code repair remains, return pass to hand off to test authoring, explicitly noting that acceptance checks have not passed; the workflow must still require verification and passing checks before publication.",
    },
    {
      id: "fix",
      name: "Fix bug without changing tests",
      description:
        "Fix a reproduced bug until regression tests pass, preserving the regression test's expectations.",
      outputs: ["implementation"],
      checks: [],
      prompt:
        "Fix the bug described by the reproduction and any review feedback. Never change tests to obtain a pass. Read tests and modify production code only. Run the allowed check. Publish implementation describing the root cause, fix, and evidence. Return retry if production repair is incomplete. If only invalid test code or test compilation needs correction, report the exact diagnostics and return pass to hand off to the independent test author; this is not acceptance. Require the separate acceptance gate afterward.",
    },
    {
      id: "verify",
      name: "Write independent tests",
      description:
        "Author independent tests and validate their correctness. Pass preserves authored tests; it is not acceptance. Follow with acceptance checks.",
      outputs: ["feedback"],
      checks: [],
      prompt:
        "Write focused tests proving the acceptance criteria. Do not change production code. Run the project's applicable test-code typechecking or compilation as well as the tests; fix errors in newly authored test code before reporting success. If valid tests expose an implementation defect, publish feedback with the violated criterion and failure evidence, but return pass for completed test authoring so recovery preserves the tests. Do not weaken tests to pass. Return retry only when test authoring itself is incomplete or invalid. A completed authoring step is not passing acceptance; a separate acceptance check must run next and block publication on failure.",
    },
    {
      id: "checks",
      name: "Run acceptance checks",
      description: "Run existing acceptance checks without edits. Passing test authoring is not passing acceptance; classify failures for the correct repair owner.",
      outputs: ["feedback"],
      checks: successChecks,
      prompt: "Run the applicable existing tests, test-code typechecking or compilation and other required acceptance checks. Do not edit any files. Report exact commands and outcomes. Return pass only when required checks pass. Return retry for production defects or invalid test code, distinguishing their evidence and repair owner; return fail for unavailable infrastructure or missing evidence. Never accept a test-authoring pass as acceptance evidence.",
    },
    {
      id: "review",
      name: "Independent review",
      description:
        "Read-only review of the implementation and acceptance evidence; route defects back to implementation.",
      outputs: ["feedback"],
      checks: successChecks,
      prompt:
        "Independently inspect the relevant code, tests, and supplied artifacts. Do not modify files. For a branch review, inspect the comparison base first. If no commits or usable baseline exists, review accessible working files and state that findings are not branch-relative; do not treat the absent baseline alone as a blocker. Report concrete correctness defects with file locations and evidence in feedback. Return retry for actionable defects, fail for a blocker that prevents useful inspection, and pass only when the review scope is satisfied and checks pass. Do not invent issues to satisfy a quota.",
    },
  ];
  for (const specification of specifications) {
    const blockDirectory = path.join(directory, "blocks", specification.id);
    await mkdir(blockDirectory, { recursive: true });
    let definition = blockSchema.parse({
      id: specification.id,
      name: specification.name,
      description: specification.description,
      outputs: specification.outputs,
      checks: specification.checks,
      executor: specification.executor,
    });
    if (format === "code") definition = (await formatBlock(codeBundle({ definition, prompt: specification.prompt, skills: [] }, config.commands))).definition;
    if (definition.executor?.kind === "code" && ["implement", "fix"].includes(specification.id)) {
      definition.executor.source = definition.executor.source.replace("await ctx.ai({", 'await ctx.ai({ protectedPaths: ["**/*.{test,spec}.*", "**/*_test.go", "**/test_*.py", "**/{test,tests,__tests__,e2e}/**"],');
    }
    let savedDefinition: unknown = definition;
    if (definition.executor?.kind === "code") {
      const { source, ...executor } = definition.executor;
      await writeFile(path.join(blockDirectory, "block.ts"), source, { flag: "wx" });
      savedDefinition = { ...definition, executor: { ...executor, file: "block.ts" } };
    }
    await writeFile(
      path.join(blockDirectory, "block.json"),
      JSON.stringify(savedDefinition, null, 2) + "\n",
      { flag: "wx" },
    );
    await writeFile(
      path.join(blockDirectory, "prompt.md"),
      specification.prompt + "\n",
      { flag: "wx" },
    );
  }
  await writeFile(path.join(directory, ".gitignore"), "runs/\ntasks/\nattachments/\ndesign-chats/\ntemporal/\nversions/\nlibrary-proposals/\nlibraries/\nserver-lease/\nlock\n", {
    flag: "wx",
  });

  return await loadLibrary(project);
}
