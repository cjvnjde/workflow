import path from "node:path";
import { fileURLToPath } from "node:url";

const nativeTsc = fileURLToPath(
  new URL("./bin/tsc", import.meta.resolve("@typescript/native/package.json")),
);
const configPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const compiler = Bun.spawn([process.execPath, nativeTsc, "--project", configPath], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await compiler.exited;
