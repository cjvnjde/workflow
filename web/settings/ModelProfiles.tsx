import {
  agentSchema,
  modelKey,
  type AvailableModel,
  type OrchestrationSettings,
} from "../../src/contracts/index.js";
import Field from "../shared/Field.js";
import Icon from "../shared/Icon.js";
import { useAutosize } from "../shared/autosize.js";

type Profile = OrchestrationSettings["profiles"][number];
export interface ModelProfilesProps {
  modelValue: OrchestrationSettings;
  models: AvailableModel[];
  busy: boolean;
  onUpdateModelValue: (value: OrchestrationSettings) => void;
  onGenerate: (prompt: string) => void;
}

function ProfileCard({
  profile,
  models,
  onUpdate,
  onRemove,
  onEnable,
}: {
  profile: Profile;
  models: AvailableModel[];
  onUpdate: (profile: Profile) => void;
  onRemove: () => void;
  onEnable: (enabled: boolean) => void;
}) {
  const descriptionRef = useAutosize(profile.description);
  const selected = models.find(
    (model) => model.provider === profile.agent.provider && model.id === profile.agent.model,
  );
  function choose(key: string) {
    const model = models.find((item) => modelKey(item) === key);
    if (!model) return;
    onUpdate({
      ...profile,
      agent: {
        ...profile.agent,
        provider: model.provider,
        model: model.id,
        thinking: agentSchema.shape.thinking.parse(
          model.thinkingLevels.includes(profile.agent.thinking)
            ? profile.agent.thinking
            : (model.thinkingLevels[0] ?? "off"),
        ),
      },
    });
  }
  return (
    <article className="settings-card">
      <div className="card-title">
        <Icon name="spark" />
        <strong>{profile.name}</strong>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={profile.enabled}
            onChange={(event) => onEnable(event.target.checked)}
          />
          Enabled
        </label>
        <button className="icon-button" aria-label={`Remove ${profile.name}`} onClick={onRemove}>
          <Icon name="close" />
        </button>
      </div>
      <Field label="Profile name">
        {({ id }) => (
          <input
            id={id}
            value={profile.name}
            onChange={(event) => onUpdate({ ...profile, name: event.target.value })}
          />
        )}
      </Field>
      <Field label="When should this model be used?">
        {({ id }) => (
          <textarea
            id={id}
            ref={descriptionRef}
            rows={3}
            value={profile.description}
            onChange={(event) => onUpdate({ ...profile, description: event.target.value })}
          />
        )}
      </Field>
      <div className="field-grid">
        <Field label="Profile model">
          {({ id }) => (
            <select
              id={id}
              value={`${profile.agent.provider}/${profile.agent.model}`}
              onChange={(event) => choose(event.target.value)}
            >
              {!selected && (
                <option value={`${profile.agent.provider}/${profile.agent.model}`}>
                  {profile.agent.model} · unavailable
                </option>
              )}
              {models.map((model) => (
                <option key={modelKey(model)} value={modelKey(model)}>
                  {model.name} · {model.provider}
                  {model.imageInput ? " · images" : ""}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Profile thinking">
          {({ id }) => (
            <select
              id={id}
              value={profile.agent.thinking}
              onChange={(event) =>
                onUpdate({
                  ...profile,
                  agent: {
                    ...profile.agent,
                    thinking: agentSchema.shape.thinking.parse(event.target.value),
                  },
                })
              }
            >
              {[...new Set([profile.agent.thinking, ...(selected?.thinkingLevels ?? [])])].map(
                (level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ),
              )}
            </select>
          )}
        </Field>
      </div>
      <details>
        <summary>Session limits</summary>
        <p>
          Leave blank to inherit project defaults. A longer code-block timeout does not extend an AI
          session.
        </p>
        <div className="field-grid">
          <Field label="Session timeout (minutes)">
            {({ id }) => (
              <input
                id={id}
                type="number"
                min="1"
                max="60"
                step="1"
                placeholder="Project default"
                value={profile.agent.timeoutMs === undefined ? "" : profile.agent.timeoutMs / 60000}
                onChange={(event) =>
                  onUpdate({
                    ...profile,
                    agent: {
                      ...profile.agent,
                      timeoutMs:
                        event.target.value === "" ? undefined : Number(event.target.value) * 60000,
                    },
                  })
                }
              />
            )}
          </Field>
          <Field label="Maximum tool calls">
            {({ id }) => (
              <input
                id={id}
                type="number"
                min="1"
                max="1000"
                step="1"
                placeholder="Project default"
                value={profile.agent.maxToolCalls ?? ""}
                onChange={(event) =>
                  onUpdate({
                    ...profile,
                    agent: {
                      ...profile.agent,
                      maxToolCalls:
                        event.target.value === "" ? undefined : Number(event.target.value),
                    },
                  })
                }
              />
            )}
          </Field>
        </div>
      </details>
    </article>
  );
}

export default function ModelProfiles({
  modelValue: settings,
  models,
  busy,
  onUpdateModelValue,
  onGenerate,
}: ModelProfilesProps) {
  function updateProfile(profile: Profile) {
    onUpdateModelValue({
      ...settings,
      profiles: settings.profiles.map((item) => (item.id === profile.id ? profile : item)),
    });
  }
  function add() {
    const model =
      models.find((item) => item.provider === "openai" && item.id === "gpt-6.1-sol") ?? models[0];
    if (!model) return;
    onUpdateModelValue({
      ...settings,
      profiles: [
        ...settings.profiles,
        {
          id: `model-${crypto.randomUUID().slice(0, 8)}`,
          name: "New model profile",
          description: "Describe when to use this model, its strengths and tradeoffs.",
          enabled: true,
          agent: {
            provider: model.provider,
            model: model.id,
            thinking: agentSchema.shape.thinking.parse(
              model.thinkingLevels.includes("high") ? "high" : (model.thinkingLevels[0] ?? "off"),
            ),
          },
        },
      ],
    });
  }
  function generate() {
    onGenerate(
      `${settings.profiles.length ? "Regenerate" : "Generate"} model profiles for this project. Inspect the project and connected catalog. Create a concise set of useful roles for coding, careful review, and routine work with cost-aware model choices. Preserve the project default as the planning model unless I explicitly ask to change it.`,
    );
  }
  return (
    <section>
      <div className="settings-section-title">
        <div>
          <h2>A model for each kind of work</h2>
          <p>
            {settings.profiles.length} configured role profiles · {models.length} models available
            from connected providers. Add a profile to use another model, such as Terra. These cards
            are roles, not the full model catalog.
          </p>
        </div>
        <button disabled={busy || !models.length} onClick={add}>
          <Icon name="plus" />
          Add model profile
        </button>
      </div>
      {!models.length && (
        <p className="muted">
          Connect ChatGPT or another provider in Providers &amp; models first.
        </p>
      )}
      <div className="profile-generation">
        <Icon name="spark" size={23} />
        <div>
          <strong>
            {settings.profiles.length ? "Refresh your model lineup" : "Let AI set up your models"}
          </strong>
          <p>
            Use this project and the connected catalog to assign routine work to efficient models
            and demanding work to stronger ones.
          </p>
        </div>
        <button disabled={busy || !models.length} onClick={generate}>
          {settings.profiles.length ? "Regenerate with AI" : "Generate with AI"}
        </button>
      </div>
      <div className="settings-card">
        <Field
          label="Planning model"
          help="Use the project default to plan requests, or explicitly choose a profile here. The planner chooses execution models from your enabled profiles."
        >
          {({ id }) => (
            <select
              id={id}
              value={settings.coordinatorProfile}
              onChange={(event) =>
                onUpdateModelValue({ ...settings, coordinatorProfile: event.target.value })
              }
            >
              <option value="">Project default model</option>
              {settings.profiles
                .filter((profile) => profile.enabled)
                .map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
            </select>
          )}
        </Field>
      </div>
      {!settings.profiles.length && (
        <div className="settings-empty">
          <Icon name="spark" size={28} />
          <h3>Give your models a role</h3>
          <p>
            For example: “Careful reviewer — use for complex code and security checks” or “Fast
            helper — use for summaries and simple changes.” Without profiles, the full connected
            catalog is available.
          </p>
        </div>
      )}
      {settings.profiles.map((profile) => (
        <ProfileCard
          key={profile.id}
          profile={profile}
          models={models}
          onUpdate={updateProfile}
          onRemove={() =>
            onUpdateModelValue({
              ...settings,
              coordinatorProfile:
                settings.coordinatorProfile === profile.id ? "" : settings.coordinatorProfile,
              profiles: settings.profiles.filter((item) => item.id !== profile.id),
            })
          }
          onEnable={(enabled) =>
            onUpdateModelValue({
              ...settings,
              coordinatorProfile:
                !enabled && settings.coordinatorProfile === profile.id
                  ? ""
                  : settings.coordinatorProfile,
              profiles: settings.profiles.map((item) =>
                item.id === profile.id ? { ...item, enabled } : item,
              ),
            })
          }
        />
      ))}
    </section>
  );
}
