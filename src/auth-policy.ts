import type { Provider } from "@earendil-works/pi-ai";

/** One account flow: ChatGPT. All other new connections use API keys. */
export function loginMethods(provider: Pick<Provider, "id" | "auth">) {
  const methods: ("oauth" | "api_key")[] = [];
  if (provider.id === "openai" && provider.auth.oauth) { methods.push("oauth"); }
  if (provider.auth.apiKey?.login) { methods.push("api_key"); }
  return methods;
}
