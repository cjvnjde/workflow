import type { z } from "zod";
import { automationConfigSchema, type AutomationConfig } from "../contracts/automation-schema.js";
import { workSignalSchema, discoveryResultSchema } from "../contracts/automation-signal-schema.js";

/** Validate and normalize a reusable scheduler definition; this never starts execution. */
export function automation(config: z.input<typeof automationConfigSchema>): AutomationConfig {
  return automationConfigSchema.parse(config);
}
export function workSignal(signal: z.input<typeof workSignalSchema>) {
  return workSignalSchema.parse(signal);
}
export function discoveryResult(result: z.input<typeof discoveryResultSchema>) {
  return discoveryResultSchema.parse(result);
}
export { automationConfigSchema } from "../contracts/automation-schema.js";
export type {
  AutomationConfig,
  AutomationTarget,
  AutomationSchedule,
} from "../contracts/automation-schema.js";
export {
  workSignalSchema,
  discoveryResultSchema,
  automationContextSchema,
  automationCaseContextSchema,
} from "../contracts/automation-signal-schema.js";
export type {
  WorkSignal,
  DiscoveryResult,
  AutomationContext,
  AutomationCaseContext,
} from "../contracts/automation-signal-schema.js";
