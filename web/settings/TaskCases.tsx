import type { OrchestrationSettings } from "../../src/contracts/index.js";
import Field from "../shared/Field.js";
import Icon from "../shared/Icon.js";
import { useAutosize } from "../shared/autosize.js";

type TaskCase = OrchestrationSettings["cases"][number];
export interface TaskCasesProps {
  value: OrchestrationSettings;
  onChange: (value: OrchestrationSettings) => void;
}

function CaseCard({
  item,
  onUpdate,
  onRemove,
}: {
  item: TaskCase;
  onUpdate: (item: TaskCase) => void;
  onRemove: () => void;
}) {
  const descriptionRef = useAutosize(item.description);
  const instructionsRef = useAutosize(item.instructions);
  return (
    <article className="settings-card">
      <div className="card-title">
        <Icon name="file" />
        <strong>{item.name}</strong>
        <label className="checkbox">
          <input
            checked={item.enabled}
            type="checkbox"
            onChange={(event) => onUpdate({ ...item, enabled: event.target.checked })}
          />
          Enabled
        </label>
        <button className="icon-button" aria-label={`Remove ${item.name}`} onClick={onRemove}>
          <Icon name="close" />
        </button>
      </div>
      <Field label="Case name">
        {({ id }) => (
          <input
            id={id}
            value={item.name}
            onChange={(event) => onUpdate({ ...item, name: event.target.value })}
          />
        )}
      </Field>
      <Field label="When does this case apply?">
        {({ id }) => (
          <textarea
            id={id}
            value={item.description}
            ref={descriptionRef}
            rows={2}
            onChange={(event) => onUpdate({ ...item, description: event.target.value })}
          />
        )}
      </Field>
      <Field label="Instructions for this case">
        {({ id }) => (
          <textarea
            id={id}
            value={item.instructions}
            ref={instructionsRef}
            rows={5}
            onChange={(event) => onUpdate({ ...item, instructions: event.target.value })}
          />
        )}
      </Field>
    </article>
  );
}

export default function TaskCases({ value: settings, onChange }: TaskCasesProps) {
  const instructionsRef = useAutosize(settings.instructions);
  function add() {
    onChange({
      ...settings,
      cases: [
        ...settings.cases,
        {
          id: `case-${crypto.randomUUID().slice(0, 8)}`,
          name: "New task case",
          description: "Describe which requests belong here.",
          instructions: "Describe how work of this type should be approached and verified.",
          enabled: true,
        },
      ],
    });
  }
  return (
    <section>
      <div className="settings-section-title">
        <div>
          <h2>Task cases &amp; instructions</h2>
          <p>
            The orchestrator matches your request to a description, reads its instructions, and
            composes a fresh workflow.
          </p>
        </div>
        <button onClick={add}>
          <Icon name="plus" />
          Add task case
        </button>
      </div>
      <div className="settings-card">
        <Field label="Instructions for every task">
          {({ id }) => (
            <textarea
              id={id}
              value={settings.instructions}
              ref={instructionsRef}
              rows={3}
              placeholder="Project priorities, planning preferences, and constraints…"
              onChange={(event) => onChange({ ...settings, instructions: event.target.value })}
            />
          )}
        </Field>
        <label className="checkbox">
          <input
            checked={settings.suggestBlocks}
            type="checkbox"
            onChange={(event) => onChange({ ...settings, suggestBlocks: event.target.checked })}
          />
          Let the orchestrator suggest useful new blocks
        </label>
      </div>
      {settings.cases.map((item) => (
        <CaseCard
          key={item.id}
          item={item}
          onUpdate={(updated) =>
            onChange({
              ...settings,
              cases: settings.cases.map((entry) => (entry.id === updated.id ? updated : entry)),
            })
          }
          onRemove={() =>
            onChange({
              ...settings,
              cases: settings.cases.filter((entry) => entry.id !== item.id),
            })
          }
        />
      ))}
    </section>
  );
}
