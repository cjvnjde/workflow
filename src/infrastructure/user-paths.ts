import os from "node:os";
import path from "node:path";

/** Local application paths follow XDG configuration and the explicit home override. */
export function userPaths() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const configDirectory = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  const directory = process.env.WORKFLOW_HOME
    ? path.resolve(process.env.WORKFLOW_HOME)
    : path.join(configDirectory, "workflow");

  return {
    directory,
    settings: path.join(directory, "settings.json"),
    auth: path.join(directory, "auth.json"),
    models: path.join(directory, "models.json"),
    catalog: path.join(directory, "model-catalog.json"),
  };
}
