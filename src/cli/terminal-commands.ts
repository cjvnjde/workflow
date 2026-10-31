import {
  getSupportedThinkingLevels,
  type AuthInteraction,
  type AuthPrompt,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import {
  ExtensionSelectorComponent,
  LoginDialogComponent,
  ModelSelectorComponent,
  OAuthSelectorComponent,
  ThinkingSelectorComponent,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "../contracts/domain.js";
import { getModelRuntime } from "../core/models/model-runtime.js";
import { SecretPrompt, WorkflowTerminal } from "../terminal/terminal-ui.js";
import { loadUserSettings, saveUserSettings } from "../core/settings/user-settings.js";
import { userPaths } from "../infrastructure/user-paths.js";
import { loginMethods } from "../core/models/auth-policy.js";

type LoginOption = ConstructorParameters<typeof OAuthSelectorComponent>[1][number];

export function loginOptions(runtime: ModelRuntime) {
  const options: LoginOption[] = [];
  for (const provider of runtime.getProviders()) {
    const status = runtime.getProviderAuthStatus(provider.id);
    const common = {
      id: provider.id,
      name: provider.name,
      subscription: provider.auth.oauth?.isSubscription === true,
      status: status.configured
        ? {
            type: runtime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
            source: status.label ?? status.source,
          }
        : undefined,
    };
    if (provider.auth.oauth && loginMethods(provider).includes("oauth")) {
      options.push({ ...common, authType: "oauth", method: provider.auth.oauth });
    }
    if (provider.auth.apiKey?.login && loginMethods(provider).includes("api_key")) {
      options.push({ ...common, authType: "api_key", method: provider.auth.apiKey });
    }
  }

  return options.sort((a, b) => a.name.localeCompare(b.name));
}

export function authInteraction(
  ui: WorkflowTerminal,
  dialog: LoginDialogComponent,
): AuthInteraction {
  const signal = AbortSignal.any([ui.signal, dialog.signal]);
  const prompt = async (request: AuthPrompt) => {
    const promptSignal = request.signal ? AbortSignal.any([signal, request.signal]) : signal;
    promptSignal.throwIfAborted();
    if (request.type === "select" || request.type === "secret") {
      try {
        const value = await ui.show<string>((done, cancel) => {
          if (request.type === "secret") {
            return new SecretPrompt(request.message, done, cancel);
          }

          return new ExtensionSelectorComponent(
            request.message,
            request.options.map((option) => option.label),
            (label) => {
              const option = request.options.find((candidate) => candidate.label === label);
              if (option) {
                done(option.id);
              }
            },
            cancel,
          );
        }, promptSignal);
        if (value === undefined) {
          throw new Error("Authentication cancelled");
        }

        return value;
      } finally {
        ui.mount(dialog);
      }
    }
    const response =
      request.type === "manual_code"
        ? dialog.showManualInput(request.message)
        : dialog.showPrompt(request.message, request.placeholder);
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        response,
        new Promise<never>((_resolve, reject) => {
          abort = () => {
            reject(new Error("Authentication cancelled"));
          };
          promptSignal.addEventListener("abort", abort, { once: true });
          if (promptSignal.aborted) {
            abort();
          }
        }),
      ]);
    } finally {
      if (abort) {
        promptSignal.removeEventListener("abort", abort);
      }
    }
  };

  return {
    signal,
    prompt,
    notify: (event) => {
      if (event.type === "auth_url") {
        dialog.showAuth(event.url, event.instructions);
      } else if (event.type === "device_code") {
        dialog.showDeviceCode(event);
        dialog.showWaiting("Waiting for authentication…");
      } else if (event.type === "info") {
        dialog.showInfo(event.message, event.links);
      } else {
        dialog.showProgress(event.message);
      }
    },
  };
}

export async function chooseModel(ui: WorkflowTerminal, runtime: ModelRuntime, provider?: string) {
  const settings = await loadUserSettings();
  const current =
    settings.agent.provider && settings.agent.model
      ? runtime.getModel(settings.agent.provider, settings.agent.model)
      : undefined;
  if (!(await runtime.getAvailable(undefined, { signal: ui.signal })).length) {
    throw new Error("No models are available. Connect a provider with workflow login first.");
  }
  const model = await ui.show<Model<Api>>(
    (done, cancel) =>
      new ModelSelectorComponent(
        ui.tui,
        current,
        runtime,
        [],
        done,
        cancel,
        provider,
        done,
        settings.agent.provider && settings.agent.model
          ? { provider: settings.agent.provider, id: settings.agent.model }
          : undefined,
      ),
  );
  if (!model) {
    return undefined;
  }
  settings.agent.provider = model.provider;
  settings.agent.model = model.id;
  const supported = getSupportedThinkingLevels(model);
  const previous = settings.agent.thinking ?? "medium";
  settings.agent.thinking = supported.includes(previous)
    ? previous
    : supported.includes("medium")
      ? "medium"
      : (supported[0] ?? "off");
  await saveUserSettings(settings);

  return model;
}

async function login(ui: WorkflowTerminal, runtime: ModelRuntime, providerRef?: string) {
  let options = loginOptions(runtime);
  if (providerRef) {
    options = options.filter(
      (option) =>
        option.id.toLowerCase() === providerRef.toLowerCase() ||
        option.name.toLowerCase() === providerRef.toLowerCase(),
    );
    if (!options.length) {
      throw new Error(
        `Unknown provider or no interactive login available: ${providerRef}. Run workflow login to browse providers.`,
      );
    }
  }
  if (options.length > 1) {
    const types = [...new Set(options.map((option) => option.authType))];
    if (types.length > 1) {
      const method = await ui.show<string>(
        (done, cancel) =>
          new ExtensionSelectorComponent(
            providerRef ? `Sign in to ${options[0]?.name}` : "Connect an LLM provider",
            ["Sign in with an account", "Sign in with an API key"],
            done,
            cancel,
          ),
      );
      if (!method) {
        return "Login cancelled. No credentials changed.";
      }
      const type = method === "Sign in with an account" ? "oauth" : "api_key";
      options = options.filter((option) => option.authType === type);
    }
  }
  const selected =
    options.length === 1
      ? options[0]
      : await ui.show<LoginOption>(
          (done, cancel) =>
            new OAuthSelectorComponent(
              "login",
              options,
              (id, type) => {
                const option = options.find(
                  (candidate) => candidate.id === id && candidate.authType === type,
                );
                if (option) {
                  done(option);
                }
              },
              cancel,
            ),
        );
  if (!selected) {
    return "Login cancelled. No credentials changed.";
  }
  const dialog = new LoginDialogComponent(
    ui.tui,
    selected.id,
    () => {},
    selected.name,
    `workflow · Sign in to ${selected.name}`,
  );
  ui.mount(dialog);
  const settings = await loadUserSettings();
  await saveUserSettings(settings);
  await runtime.login(selected.id, selected.authType, authInteraction(ui, dialog), {
    agentName: "workflow",
    getDeviceId: () => settings.deviceId,
  });
  dialog.showWaiting("Authenticated. Refreshing the model catalog…");
  const refreshed = await runtime.refresh({
    providers: [selected.id],
    allowNetwork: true,
    signal: AbortSignal.any([ui.signal, dialog.signal, AbortSignal.timeout(15_000)]),
  });
  if (ui.signal.aborted || dialog.signal.aborted) {
    return `Connected ${selected.name}. Credentials were saved; model selection was cancelled. Use workflow model when ready.`;
  }
  const warning =
    refreshed.aborted || refreshed.errors.size
      ? " Catalog refresh was unavailable; cached models are being used."
      : "";
  if (!settings.agent.model) {
    const model = await chooseModel(ui, runtime, selected.id);

    return `Connected ${selected.name}.${model ? ` Default model: ${model.provider}/${model.id}.` : " Select a default with workflow model."}${warning}`;
  }

  return `Connected ${selected.name}. Credentials saved to ${userPaths().auth}.${warning}\nUse workflow model to change the default model.`;
}

async function logout(ui: WorkflowTerminal, runtime: ModelRuntime, providerRef?: string) {
  let options: LoginOption[] = (await runtime.listCredentials({ signal: ui.signal })).map(
    (credential) => ({
      id: credential.providerId,
      name: runtime.getProvider(credential.providerId)?.name ?? credential.providerId,
      authType: credential.type,
    }),
  );
  if (providerRef) {
    const reference = providerRef.toLowerCase();
    options = options.filter(
      (option) => option.id.toLowerCase() === reference || option.name.toLowerCase() === reference,
    );
  }
  if (!options.length) {
    return "No matching stored credentials to remove.";
  }
  const selected =
    options.length === 1
      ? options[0]
      : await ui.show<LoginOption>(
          (done, cancel) =>
            new OAuthSelectorComponent(
              "logout",
              options,
              (id) => {
                const option = options.find((candidate) => candidate.id === id);
                if (option) {
                  done(option);
                }
              },
              cancel,
            ),
        );
  if (!selected) {
    return "Logout cancelled.";
  }
  const confirmed = await ui.show<string>(
    (done, cancel) =>
      new ExtensionSelectorComponent(
        `Remove saved credentials for ${selected.name}?`,
        ["Cancel", "Remove credentials"],
        done,
        cancel,
      ),
  );
  if (confirmed !== "Remove credentials") {
    return "Logout cancelled.";
  }
  await runtime.logout(selected.id, { signal: ui.signal });

  return `Removed credentials for ${selected.name}. Provider-side access is not revoked. Optional environment keys remain unchanged.`;
}

export async function runTerminalCommand(command: string, provider?: string) {
  if (command === "auth") {
    const runtime = await getModelRuntime();
    const credentials = await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) });
    console.log(`Workflow credentials: ${userPaths().auth}`);
    for (const credential of credentials) {
      console.log(`  ${credential.providerId} · ${credential.type}`);
    }
    if (!credentials.length) {
      console.log("No saved credentials. Run workflow login.");
    }
    const settings = await loadUserSettings();
    console.log(
      `Default model: ${settings.agent.provider && settings.agent.model ? `${settings.agent.provider}/${settings.agent.model}` : "not selected; run workflow model"}`,
    );
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `workflow ${command} requires an interactive terminal. Run it directly, without piping input/output. No Pi installation is needed.`,
    );
  }
  const ui = new WorkflowTerminal();
  ui.start();
  try {
    const runtime = await getModelRuntime();
    let message: string;
    if (command === "login") {
      message = await login(ui, runtime, provider);
    } else if (command === "logout") {
      message = await logout(ui, runtime, provider);
    } else if (command === "model") {
      const model = await chooseModel(ui, runtime, provider);
      message = model
        ? `Default model: ${model.provider}/${model.id}. New workflow proposals use this selection.`
        : "Model selection cancelled.";
    } else if (command === "thinking") {
      const settings = await loadUserSettings();
      const model =
        settings.agent.provider && settings.agent.model
          ? runtime.getModel(settings.agent.provider, settings.agent.model)
          : undefined;
      if (!model) {
        throw new Error("Choose a model with workflow model first.");
      }
      const level = await ui.show<AgentSettings["thinking"]>(
        (done, cancel) =>
          new ThinkingSelectorComponent(
            settings.agent.thinking ?? "medium",
            getSupportedThinkingLevels(model),
            done,
            cancel,
          ),
      );
      if (level) {
        settings.agent.thinking = level;
        await saveUserSettings(settings);
      }
      message = level
        ? `Default thinking: ${level}. Project and step settings can override it.`
        : "Thinking selection cancelled.";
    } else {
      throw new Error(`Unknown terminal command: ${command}`);
    }
    ui.finish(message);
  } catch (error) {
    if (
      ui.signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || /cancelled|canceled/i.test(error.message)))
    ) {
      ui.finish("Setup cancelled. Any credentials already saved have been kept.");
      return;
    }
    ui.finish(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    ui.stop();
  }
}
