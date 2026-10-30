import { mkdir } from "node:fs/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { userPaths } from "../../infrastructure/user-paths.js";

const runtimes = new Map<string, Promise<ModelRuntime>>();

export async function getModelRuntime() {
  const paths = userPaths();
  let runtime = runtimes.get(paths.directory);
  if (!runtime) {
    runtime = (async () => {
      await mkdir(paths.directory, { recursive: true, mode: 0o700 });

      return await ModelRuntime.create({
        authPath: paths.auth,
        modelsPath: paths.models,
        modelsStorePath: paths.catalog,
      });
    })();
    runtimes.set(paths.directory, runtime);
    void runtime.catch(() => {
      runtimes.delete(paths.directory);
    });
  }

  return await runtime;
}
