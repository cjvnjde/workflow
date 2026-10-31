import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fixture } from "./helpers.js";
import { bundleSchema } from "../src/contracts/domain.js";
import { loadLibrary } from "../src/core/library/library.js";
import {
  loadOrchestration,
  saveOrchestration,
} from "../src/core/settings/orchestration-settings.js";
import { projectModelSettings, updateProjectModel } from "../src/core/settings/project-model.js";
import {
  publishSetup,
  readSetupPublication,
  readSetupSnapshot,
  withProjectSettingsSnapshot,
  type SetupPublicationInput,
} from "../src/core/settings/settings-publication.js";
import type { AvailableModel } from "../src/contracts/library-editor-schema.js";

const models: AvailableModel[] = ["small", "careful"].map((id) => ({
  provider: "test",
  id,
  name: id,
  reasoning: true,
  thinkingLevels: ["low"],
  contextWindow: 32000,
  maxTokens: 4000,
  cost: null,
}));
async function proposal(project: string): Promise<SetupPublicationInput> {
  const before = await readSetupSnapshot(project);
  return {
    jobId: randomUUID(),
    base: {
      libraryHash: before.libraryHash,
      configRevision: before.configRevision,
      orchestrationRevision: before.orchestration.revision,
    },
    modelOverride: { provider: "test", model: "careful", thinking: "low" },
    settings: {
      ...before.orchestration.settings,
      instructions: "New project instructions",
      coordinatorProfile: "",
      profiles: [
        {
          id: "review",
          name: "Review",
          description: "Independent review",
          enabled: true,
          agent: { provider: "test", model: "careful", thinking: "low" },
        },
      ],
    },
    libraryChanges: {
      summary: "Reusable deterministic block",
      blocks: [
        {
          rationale: "No model needed",
          bundle: bundleSchema.parse({
            definition: {
              id: "generated-note",
              name: "Generated note",
              description: "Return a reusable note",
              executor: {
                kind: "code",
                source:
                  'import {block} from "workflow";export default block({run(){return "generated";}});',
              },
            },
            skills: [],
          }),
        },
      ],
    },
  };
}
async function configure(project: string) {
  const file = path.join(project, ".workflow/config.json");
  const raw = JSON.parse(await readFile(file, "utf8"));
  await writeFile(
    file,
    JSON.stringify({
      ...raw,
      agent: { provider: "test", model: "small", thinking: "low" },
      coordinator: { provider: "test", model: "small", thinking: "low" },
    }),
  );
}

for (const point of [
  "prepared",
  "config",
  "library:inline",
  "library:source:generated-note",
  "library:manifest",
  "library",
  "orchestration",
  "committed",
]) {
  test(
    "interrupted setup at " +
      point +
      " exposes a complete generation and resumes its saved proposal",
    async (t) => {
      const { project } = await fixture(t);
      await configure(project);
      const before = await readSetupSnapshot(project),
        input = await proposal(project);
      await assert.rejects(
        publishSetup(project, input, models, undefined, {
          checkpoint: (stage) => {
            if (stage === point) throw new Error("Simulated process interruption");
          },
        }),
        /Simulated process interruption/,
      );
      const visible = await readSetupSnapshot(project);
      if (point === "committed") {
        assert.equal(visible.library.config.agent.model, "careful");
        assert.equal(visible.orchestration.settings.instructions, input.settings.instructions);
        assert.ok(await readSetupPublication(project, input.jobId));
      } else {
        assert.deepEqual(visible, before);
        await assert.rejects(
          saveOrchestration(
            project,
            {
              ...before.orchestration,
              settings: { ...before.orchestration.settings, instructions: "Competing edit" },
            },
            models,
          ),
          /unfinished settings publication/,
        );
      }
      const result = await publishSetup(project, input, models);
      assert.equal(result.counts.blocks, Object.keys(before.library.blocks).length + 1);
      assert.deepEqual(await publishSetup(project, input, models), result);
      assert.deepEqual(await readSetupPublication(project, input.jobId), result);
      assert.equal(
        (await readdir(path.join(project, ".workflow/library-proposals"))).filter((name) =>
          name.endsWith(".json"),
        ).length,
        1,
      );
      const after = await readSetupSnapshot(project);
      assert.equal(after.library.config.agent.model, "careful");
      assert.equal(after.library.config.coordinator, undefined);
      assert.equal(after.orchestration.settings.instructions, "New project instructions");
      const source = path.join(project, ".workflow/blocks/generated-note/block.ts");
      const edited = (await readFile(source, "utf8")).replace('"generated"', '"manual"');
      await writeFile(source, edited);
      const executor = (await loadLibrary(project)).blocks["generated-note"]!.definition.executor;
      assert.equal(
        executor?.kind === "code" ? executor.source : undefined,
        edited,
        "Committed publication must not mask ordinary source edits",
      );
    },
  );
}

test("interrupted materialization preserves manual source edits and keeps readers on the previous generation", async (t) => {
  const { project } = await fixture(t);
  await configure(project);
  const before = await readSetupSnapshot(project),
    input = await proposal(project);
  await assert.rejects(
    publishSetup(project, input, models, undefined, {
      checkpoint: (point) => {
        if (point === "library:source:generated-note")
          throw new Error("Stopped after source write");
      },
    }),
    /Stopped after source write/,
  );
  const source = path.join(project, ".workflow/blocks/generated-note/block.ts");
  const manual =
    'import {block} from "workflow";export default block({run(){return "keep my edit";}});';
  await writeFile(source, manual);
  await assert.rejects(publishSetup(project, input, models), /manually edited/);
  assert.equal(await readFile(source, "utf8"), manual);
  assert.deepEqual(await readSetupSnapshot(project), before);
});

test("a pinned compound read retains old blocks, profiles and model while another client publishes", async (t) => {
  const { project } = await fixture(t);
  await configure(project);
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const reading = withProjectSettingsSnapshot(project, async () => {
    const library = await loadLibrary(project);
    entered.resolve();
    await finish.promise;
    return {
      library,
      state: await loadOrchestration(project),
      model: await projectModelSettings(project),
    };
  });
  await entered.promise;
  try {
    await publishSetup(project, await proposal(project), models);
  } finally {
    finish.resolve();
  }
  const pinned = await reading;
  assert.equal(pinned.library.blocks["generated-note"], undefined);
  assert.equal(pinned.state.settings.instructions, "");
  assert.equal(pinned.model.projectAgent.model, "small");
  assert.equal((await loadLibrary(project)).config.agent.model, "careful");
});

test("a successor publication preserves an earlier receipt after a crash at its commit point", async (t) => {
  const { project } = await fixture(t);
  await configure(project);
  const first = await proposal(project);
  await assert.rejects(
    publishSetup(project, first, models, undefined, {
      checkpoint: (point) => {
        if (point === "committed") throw new Error("Crash after commit");
      },
    }),
    /Crash after commit/,
  );
  const receipt = await readSetupPublication(project, first.jobId);
  assert.ok(receipt);
  const second = await proposal(project);
  await publishSetup(project, second, models);
  assert.deepEqual(await readSetupPublication(project, first.jobId), receipt);
  assert.deepEqual(await publishSetup(project, first, models), receipt);
});

test("a stale base and cancellation before finalization leave editable settings untouched", async (t) => {
  const { project } = await fixture(t);
  await configure(project);
  const input = await proposal(project),
    before = await readSetupSnapshot(project);
  await assert.rejects(
    publishSetup(project, input, models, AbortSignal.abort(new Error("Cancelled"))),
    /Cancelled/,
  );
  assert.deepEqual(await readSetupSnapshot(project), before);
  await updateProjectModel(
    project,
    {
      configRevision: before.configRevision,
      agent: { provider: "test", model: "careful", thinking: "low" },
    },
    models,
  );
  await assert.rejects(publishSetup(project, input, models), /settings changed during setup/);
  assert.equal(await readSetupPublication(project, input.jobId), null);
  assert.equal((await projectModelSettings(project)).projectAgent.model, "careful");
});

test("readers stay available on the old generation while a live publisher holds the write lease", async (t) => {
  const { project } = await fixture(t);
  await configure(project);
  const before = await readSetupSnapshot(project),
    input = await proposal(project);
  const reached = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const publishing = publishSetup(project, input, models, undefined, {
    checkpoint: async (point) => {
      if (point === "config") {
        reached.resolve();
        await proceed.promise;
      }
    },
  });
  await reached.promise;
  try {
    const view = await Promise.race([
      readSetupSnapshot(project),
      Bun.sleep(2000).then(() => {
        throw new Error("Readers blocked behind publication");
      }),
    ]);
    assert.deepEqual(view, before);
  } finally {
    proceed.resolve();
  }
  await publishing;
});

test("a process exit during source publication resumes from the journal without a second proposal", async (t) => {
  const { project } = await fixture(t);
  // Parent and crash-recovery subprocess must observe the same isolated user defaults.
  const previousHome = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = path.join(project, "user-settings");
  t.onTestFinished(() => {
    if (previousHome === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = previousHome;
  });
  await configure(project);
  const before = await readSetupSnapshot(project),
    input = await proposal(project);
  const entry = new URL("../src/core/settings/settings-publication.ts", import.meta.url).href;
  const script =
    "const {publishSetup}=await import(" +
    JSON.stringify(entry) +
    ");await publishSetup(" +
    JSON.stringify(project) +
    "," +
    JSON.stringify(input) +
    "," +
    JSON.stringify(models) +
    ',undefined,{checkpoint(point){if(point==="library:inline")process.exit(73);}});';
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: project,
    env: { ...process.env },
    stdout: "ignore",
    stderr: "pipe",
  });
  const error = await new Response(child.stderr).text();
  assert.equal(await child.exited, 73, error);
  assert.deepEqual(await readSetupSnapshot(project), before);
  const receipt = await publishSetup(project, input, models);
  assert.equal(receipt.counts.blocks, Object.keys(before.library.blocks).length + 1);
  assert.equal(
    (await readdir(path.join(project, ".workflow/library-proposals"))).filter((name) =>
      name.endsWith(".json"),
    ).length,
    1,
  );
});
