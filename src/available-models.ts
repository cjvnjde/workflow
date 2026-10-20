import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getModelRuntime } from "./model-runtime.js";
import { modelCatalogSchema } from "./library-editor-schema.js";

export async function availableModels(signal: AbortSignal, refresh = false) {
  const runtime = await getModelRuntime();
  const warnings: string[] = [];
  if (refresh) {
    const result = await runtime.refresh({ allowNetwork: true, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (result.aborted || result.errors.size) { warnings.push("Some catalogs could not be refreshed; cached model information is included."); }
  }
  signal.throwIfAborted();
  const models = await runtime.getAvailable(undefined, { signal });
  return modelCatalogSchema.parse({
    warnings,
    models: models.map((model) => ({
      provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning,
      imageInput: model.input.includes("image"),
      thinkingLevels: getSupportedThinkingLevels(model), contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      // All-zero catalog rates may mean unavailable billing information, rather than free inference.
      cost: Object.values(model.cost).some((value) => typeof value === "number" && value > 0) ? model.cost : null,
    })),
  });
}
