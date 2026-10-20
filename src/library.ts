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
    return { config, blocks: saved.blocks };
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
    const definition = blockSchema.parse(
      JSON.parse(
        await readFile(path.join(blockDirectory, "block.json"), "utf8"),
      ),
    );
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
    const skills = await Promise.all(
      definition.skills.map(async (resource) => ({
        path: resource,
        content: await readResource(resource),
      })),
    );
    blocks[definition.id] = {
      definition,
      prompt: await readResource("prompt.md"),
      skills,
    };
  }
  validateLibraryResources(blocks, config.commands);

  return { config, blocks };
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

export async function initializeProject(project: string, instructions = "") {
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
      executor: { kind: "function", function: "git-push" },
      outputs: ["publication"],
      checks: [],
      prompt: "Push the current branch using the configured Git remote. This function never stages files, creates commits, force pushes or fixes failures. Route failure diagnostics to a repair step or stop.",
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
        "Implement a feature against agreed requirements. Production code only; send verification issues back here.",
      outputs: ["implementation"],
      checks: successChecks,
      prompt:
        "Implement the agreed requirements. Read verification/review feedback and correct it. Preserve independent test expectations; put new verification into the test step. Update source, dependencies and configuration when the task requires it. Use the smallest coherent change and run relevant checks. Publish implementation with what changed and how each acceptance criterion is met. Return retry if unfinished.",
    },
    {
      id: "fix",
      name: "Fix bug without changing tests",
      description:
        "Fix a reproduced bug until regression tests pass, preserving the regression test's expectations.",
      outputs: ["implementation"],
      checks: successChecks,
      prompt:
        "Fix the bug described by the reproduction and any review feedback. Never change tests to obtain a pass. Read tests and modify production code only. Run the allowed check. Publish implementation describing the root cause, fix, and evidence. Return retry if the checks still fail.",
    },
    {
      id: "verify",
      name: "Write independent tests",
      description:
        "Independently verify a feature by adding tests. Tests only; return retry with feedback if implementation is wrong.",
      outputs: ["feedback"],
      checks: successChecks,
      prompt:
        "Write focused tests proving the acceptance criteria. Do not change production code. If valid tests expose an implementation defect, publish feedback with the violated criterion and failure evidence and return retry to implementation. Do not weaken tests to pass. Return pass only when the criteria and checks pass.",
    },
    {
      id: "review",
      name: "Independent review",
      description:
        "Read-only review of the implementation and acceptance evidence; route defects back to implementation.",
      outputs: ["feedback"],
      checks: successChecks,
      prompt:
        "Independently inspect the relevant code, tests, and supplied artifacts. Do not modify files. Report concrete correctness defects with file locations and evidence in feedback. Return retry for actionable defects, fail for a blocker, and pass only when requirements are met and checks pass. Do not invent issues to satisfy a quota.",
    },
  ];
  for (const specification of specifications) {
    const blockDirectory = path.join(directory, "blocks", specification.id);
    await mkdir(blockDirectory, { recursive: true });
    const definition = blockSchema.parse({
      id: specification.id,
      name: specification.name,
      description: specification.description,
      outputs: specification.outputs,
      checks: specification.checks,
      executor: specification.executor,
    });
    await writeFile(
      path.join(blockDirectory, "block.json"),
      JSON.stringify(definition, null, 2) + "\n",
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
