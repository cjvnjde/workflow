import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { usageSchema, type UsageTotals } from "../../contracts/domain.js";
import { emptyUsage } from "../execution/budget.js";
import { atomicWrite } from "../../infrastructure/atomic-file.js";

export function attemptDirectory(project: string, runId: string, nodeId: string, visit: number) {
  return path.join(project, ".workflow", "runs", runId, "attempts", `${nodeId}-${visit}`);
}
export async function loadUsage(directory: string): Promise<UsageTotals> {
  try {
    return usageSchema.parse(
      JSON.parse(await readFile(path.join(directory, "usage.json"), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return emptyUsage();
    }
    throw error;
  }
}
export async function saveUsage(directory: string, usage: UsageTotals) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicWrite(
    path.join(directory, "usage.json"),
    JSON.stringify(usageSchema.parse(usage)) + "\n",
  );
}
