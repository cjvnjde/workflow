import { agentSchema, resolveAgentSettings, type AgentSettings } from "./domain.js";
import type { AvailableModel } from "./library-editor-schema.js";

/** Planning uses the user's default unless they explicitly choose a coordinator. */
export function planningAgent(base: AgentSettings, explicit: Partial<AgentSettings> | undefined, models: AvailableModel[]) {
  if (explicit?.model) return resolveAgentSettings(base, explicit);
  // A refreshed catalog must never silently upgrade a saved choice (or its cost).
  // Keep unavailable explicit choices too: callers report the missing model rather
  // than charging for a different one without the user's knowledge.
  if (base.model) return resolveAgentSettings(base, explicit);
  const model = models.find(item => item.provider === "openai" && item.id === "gpt-6.1-sol")
    ?? models.find(item => item.reasoning) ?? models[0];
  return model ? resolveAgentSettings(base, { provider: model.provider, model: model.id,
    thinking: agentSchema.shape.thinking.parse(model.thinkingLevels.includes("high") ? "high" : model.thinkingLevels[0] ?? "off") }, explicit) : base;
}
