/** Public output names are stable; implementations live with their owning module. */
export const entrypoints = {
  "workflow-sdk": "sdk/workflow-sdk.ts",
  "program-runtime": "core/execution/program-runtime.ts",
  application: "core/application.ts",
  "http-server": "http/http-server.ts",
  client: "client/client.ts",
  contracts: "contracts/index.ts",
  core: "core/index.ts",
  web: "http/index.ts",
  terminal: "terminal/index.ts",
  tui: "terminal/workspace.ts",
  "tool-worker": "core/tools/tool-worker.ts",
} as const;
