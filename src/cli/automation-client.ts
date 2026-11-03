import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { WorkflowClient } from "../client/client.js";
import {
  automationActionSchema,
  automationJobActionSchema,
  automationConfigSchema,
  ingestSignalsSchema,
  schedulerSettingsSchema,
} from "../contracts/automation-schema.js";

export const automationHelp = `workflow automation <command> [--json]
  list | show <id> | config <id>
  save <config.json> [id revision]
  enable|pause|disable|resume|run-now|test <id> [revision]
  tick | jobs [automation-id] | job <job-id> [approve|pause|resume|cancel|retry|reconcile|resolve|cleanup]
  signals <automation-id> <signals.json>   Requires WORKFLOW_SIGNAL_TOKEN
  settings [settings.json] | version <version-id>
JSON files contain configuration, {signals,checkpoint?}, or scheduler settings respectively.
Updates require the current revision; show returns it. Test creates reviewable work.`;

export async function runAutomationCommand(
  client: WorkflowClient,
  args: string[],
  options: { project: string; json: boolean },
) {
  const [command = "list", ...values] = args;
  const arity = (min: number, max = min) => {
    if (values.length < min || values.length > max) throw new Error(automationHelp);
  };
  const id = (index = 0) => z.string().uuid().parse(values[index]);
  const file = async (index = 0): Promise<unknown> =>
    JSON.parse(await readFile(path.resolve(options.project, values[index]!), "utf8"));
  let result: unknown;
  if (command === "help") {
    console.log(automationHelp);
    return;
  }
  if (command === "list") {
    arity(0);
    result = (await client.automations()).automations;
  } else if (command === "show" || command === "config") {
    arity(1);
    const automation = (await client.automations()).automations.find((entry) => entry.id === id());
    if (!automation) throw new Error("Automation not found");
    result = command === "config" ? automation.config : automation;
  } else if (command === "save") {
    if (values.length !== 1 && values.length !== 3) throw new Error(automationHelp);
    result = await client.saveAutomation(
      automationConfigSchema.parse(await file()),
      values[1] ? id(1) : undefined,
      values[2] === undefined ? undefined : z.coerce.number().int().nonnegative().parse(values[2]),
    );
  } else if (automationActionSchema.safeParse(command).success) {
    arity(1, 2);
    result = await client.automationAction(
      id(),
      automationActionSchema.parse(command),
      values[1] === undefined ? undefined : z.coerce.number().int().nonnegative().parse(values[1]),
    );
  } else if (command === "tick") {
    arity(0);
    result = await client.tickAutomations();
  } else if (command === "jobs") {
    arity(0, 1);
    const automationId = values.length ? id() : undefined;
    result = (await client.automations()).jobs.filter(
      (job) => !automationId || job.automationId === automationId,
    );
  } else if (command === "job") {
    arity(1, 2);
    if (values[1])
      result = await client.automationJobAction(id(), automationJobActionSchema.parse(values[1]));
    else {
      result = (await client.automations()).jobs.find((job) => job.id === id());
      if (!result) throw new Error("Automation job not found");
    }
  } else if (command === "signals") {
    arity(2);
    result = await client.emitSignals(id(), ingestSignalsSchema.parse(await file(1)));
  } else if (command === "settings") {
    arity(0, 1);
    result = values.length
      ? await client.updateSchedulerSettings(schedulerSettingsSchema.parse(await file()))
      : (await client.automations()).settings;
  } else if (command === "version") {
    arity(1);
    result = await client.automationVersion(id());
  } else throw new Error(automationHelp);
  console.log(JSON.stringify(result, null, options.json ? undefined : 2));
}
