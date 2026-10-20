import type { AuthInteraction, AuthType, Credential, Provider } from "@earendil-works/pi-ai";

const oauth = {
  name: "Test account", login: async (): Promise<Credential & { type: "oauth" }> => ({ type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600_000 }),
  refresh: async () => ({ type: "oauth" as const, access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600_000 }),
  toAuth: async () => ({ apiKey: "test-access" }),
};
const apiKey = { name: "API key", login: async () => ({ type: "api_key" as const, key: "test-key" }), resolve: async () => undefined };
export const testProviders: Pick<Provider, "id" | "name" | "auth">[] = [
  { id: "openai", name: "OpenAI", auth: { oauth, apiKey } },
  { id: "test", name: "Test provider", auth: { oauth, apiKey } },
  { id: "openai-codex", name: "Legacy Codex", auth: { oauth } },
];
export function authRuntime(login: (provider: string, method: AuthType, interaction: AuthInteraction) => Promise<Credential>) {
  return { getProviders: () => testProviders, login, logout: async () => {} };
}
