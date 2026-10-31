import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Failure to launch a desktop browser must not stop a ready host. */
export async function openBrowser(url: string) {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  try {
    await execute(command, args, { timeout: 5000 });
  } catch {
    console.error(`Could not open the browser automatically. Open ${url} in your browser.`);
  }
}
