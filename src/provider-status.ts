import { getModelRuntime } from "./model-runtime.js";
import { providerStatusSchema } from "./setup-schema.js";

/** Public connection metadata only. Never serialize credential objects. */
export async function providerStatus(signal: AbortSignal) {
  const runtime = await getModelRuntime();
  await runtime.getAvailable(undefined, { signal });
  return providerStatusSchema.parse(runtime.getProviders().flatMap((provider) => {
    const status = runtime.getProviderAuthStatus(provider.id);
    return status.configured ? [{
      id: provider.id, name: provider.name,
      method: runtime.isUsingOAuth(provider.id) ? "oauth" : "api_key",
      source: status.source === "stored" || status.source === "runtime" || status.source === "environment" ? status.source : "config",
    }] : [];
  }));
}
