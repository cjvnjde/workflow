import { useForm, useStore } from "@tanstack/react-form";
import type { z } from "zod";
import {
  identifierSchema,
  type executionSettingsSchema,
  type OrchestrationSettings,
} from "../../src/contracts/index.js";
import Field from "../shared/Field.js";
import Icon from "../shared/Icon.js";
import { useAutosize } from "../shared/autosize.js";

type Execution = z.infer<typeof executionSettingsSchema>;
type Command = Execution["commands"][string];
export interface ExecutionSettingsProps {
  value: Execution;
  approval: OrchestrationSettings["approval"];
  onChange: (value: Execution) => void;
  onUpdateApproval: (value: OrchestrationSettings["approval"]) => void;
}

function CommandCard({
  name,
  command,
  onUpdate,
  onRemove,
}: {
  name: string;
  command: Command;
  onUpdate: (value: Command) => void;
  onRemove: () => void;
}) {
  const argumentsValue = command.argv.join("\n");
  const argumentsRef = useAutosize(argumentsValue);
  return (
    <div className="settings-card">
      <div className="card-title">
        <Icon name="terminal" />
        <strong>{name}</strong>
        <button className="icon-button" aria-label={`Remove command ${name}`} onClick={onRemove}>
          <Icon name="close" />
        </button>
      </div>
      <Field
        label={`${name} arguments`}
        help="One argument per line. First line is the executable; no shell parsing."
      >
        {({ id }) => (
          <textarea
            id={id}
            ref={argumentsRef}
            rows={4}
            value={argumentsValue}
            onChange={(event) => onUpdate({ ...command, argv: event.target.value.split("\n") })}
          />
        )}
      </Field>
      <Field label={`${name} timeout (seconds)`}>
        {({ id }) => (
          <input
            id={id}
            type="number"
            min="1"
            max="600"
            value={command.timeoutMs / 1000}
            onChange={(event) =>
              onUpdate({ ...command, timeoutMs: Number(event.target.value) * 1000 })
            }
          />
        )}
      </Field>
    </div>
  );
}

export default function ExecutionSettings({
  value: execution,
  approval,
  onChange,
  onUpdateApproval,
}: ExecutionSettingsProps) {
  const commandForm = useForm({
    defaultValues: { name: "" },
    validators: {
      onSubmit: ({ value }) => {
        const result = identifierSchema.safeParse(value.name);
        if (!result.success) return result.error.issues[0]?.message;
        if (execution.commands[value.name]) return "A command with this name already exists.";
        return undefined;
      },
    },
    onSubmit: ({ value }) => {
      onChange({
        ...execution,
        commands: { ...execution.commands, [value.name]: { argv: [""], timeoutMs: 120_000 } },
      });
      commandForm.reset();
    },
  });
  const newCommand = useStore(commandForm.store, (state) => state.values.name);
  const instructionsRef = useAutosize(execution.instructions);
  function setBudget(key: "maxCostUsd" | "maxTaskCostUsd" | "maxSetupCostUsd", value: string) {
    onChange({
      ...execution,
      budget: {
        inputTokensPerCall: 4000,
        outputTokensPerCall: 1000,
        callsPerVisit: 4,
        prices: {},
        ...execution.budget,
        [key]: value ? Number(value) : undefined,
      },
    });
  }
  return (
    <section>
      <h2>Autonomy &amp; execution</h2>
      <p>Keep planning flexible and execution bounded.</p>
      <div className="settings-card">
        <Field
          label="Workflow approval"
          help="Automatic mode starts generated workflows, including suggested blocks, without a review click."
        >
          {({ id }) => (
            <select
              id={id}
              value={approval}
              onChange={(event) =>
                onUpdateApproval(event.target.value === "automatic" ? "automatic" : "review")
              }
            >
              <option value="review">Review each workflow before execution</option>
              <option value="automatic">Start automatically after planning</option>
            </select>
          )}
        </Field>
      </div>
      <div className="settings-card">
        <Field label="Project instructions">
          {({ id }) => (
            <textarea
              id={id}
              value={execution.instructions}
              ref={instructionsRef}
              rows={3}
              onChange={(event) => onChange({ ...execution, instructions: event.target.value })}
            />
          )}
        </Field>
        <div className="field-grid">
          <Field label="Maximum steps per workflow">
            {({ id }) => (
              <input
                id={id}
                type="number"
                min="1"
                max="500"
                value={execution.maxSteps}
                onChange={(event) =>
                  onChange({ ...execution, maxSteps: Number(event.target.value) })
                }
              />
            )}
          </Field>
        </div>
      </div>
      <div className="settings-card">
        <h2>AI spending limits</h2>
        <p>
          Defaults for new tasks and setup operations. Leave a limit blank to omit it. Reported
          usage stops further work at the limit; an in-flight response can exceed it.
        </p>
        <div className="field-grid">
          <Field
            label="Total task spending limit (USD)"
            help="Includes planning, workflow refinement, execution, retries and recovery. Requires known model prices."
          >
            {({ id }) => (
              <input
                id={id}
                type="number"
                min="0.001"
                step="any"
                value={execution.budget?.maxTaskCostUsd ?? ""}
                onChange={(event) => setBudget("maxTaskCostUsd", event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Project setup spending limit (USD)"
            help="Covers one complete setup operation and its retries, including model roles, task instructions and blocks."
          >
            {({ id }) => (
              <input
                id={id}
                type="number"
                min="0.001"
                step="any"
                value={execution.budget?.maxSetupCostUsd ?? ""}
                onChange={(event) => setBudget("maxSetupCostUsd", event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Execution spending limit (USD)"
            help="An additional limit for execution only. Planning and refinement count toward the total task limit above."
          >
            {({ id }) => (
              <input
                id={id}
                type="number"
                min="0.001"
                step="any"
                value={execution.budget?.maxCostUsd ?? ""}
                onChange={(event) => setBudget("maxCostUsd", event.target.value)}
              />
            )}
          </Field>
        </div>
      </div>
      <div className="settings-section-title">
        <div>
          <h2>Named commands</h2>
          <p>
            Functions such as tests or commits use these exact commands. They run with your process
            permissions.
          </p>
        </div>
      </div>
      {Object.entries(execution.commands).map(([name, command]) => (
        <CommandCard
          key={name}
          name={name}
          command={command}
          onUpdate={(updated) =>
            onChange({
              ...execution,
              commands: { ...execution.commands, [name]: updated },
            })
          }
          onRemove={() => {
            const commands = { ...execution.commands };
            delete commands[name];
            onChange({ ...execution, commands });
          }}
        />
      ))}
      <div className="inline-add">
        <input
          value={newCommand}
          onChange={(event) => commandForm.setFieldValue("name", event.target.value)}
          aria-label="New command name"
          placeholder="test, lint, commit…"
        />
        <button
          disabled={
            !identifierSchema.safeParse(newCommand).success || !!execution.commands[newCommand]
          }
          onClick={() => void commandForm.handleSubmit()}
        >
          Add command
        </button>
      </div>
    </section>
  );
}
