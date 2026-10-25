import { agentSchema, resolveAgentSettings, type AgentSettings } from "./domain.js";
import type { AvailableModel } from "./library-editor-schema.js";

/** Explicit coordinator choices win; an execution default must not make planning cheap by accident. */
export function planningAgent(base: AgentSettings, explicit: Partial<AgentSettings> | undefined, models: AvailableModel[]) {
  if (explicit?.model) return resolveAgentSettings(base, explicit);
  const preferred = models.find(item => item.provider === "openai" && item.id === "gpt-6.1-sol");
  if (!preferred && base.model) return resolveAgentSettings(base, explicit);
  const model = models.find(item => item.provider === "openai" && item.id === "gpt-6.1-sol")
    ?? models.find(item => item.provider === base.provider && item.id === base.model)
    ?? models.find(item => item.reasoning) ?? models[0];
  return model ? resolveAgentSettings(base, { provider: model.provider, model: model.id,
    thinking: agentSchema.shape.thinking.parse(model.thinkingLevels.includes("high") ? "high" : model.thinkingLevels[0] ?? "off") }, explicit) : base;
}
