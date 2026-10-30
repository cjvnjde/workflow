import { loadLibrary } from "./library.js";
import { loadOrchestration } from "./orchestration-settings.js";
import type { ActivitySink } from "./agent-session.js";
import { SetupJobs, type SetupJobServices } from "./setup-jobs.js";

export type InitializeSetupOptions = {
  instructions?: string; regenerate?: boolean; signal?: AbortSignal; emit?: ActivitySink; maxSetupCostUsd?: number;
};

/** Embedded compatibility helper. Interactive clients use the host's SetupJobs. */
export async function initializeSetup(project: string, options: InitializeSetupOptions = {}, services: SetupJobServices = {}) {
  const jobs = new SetupJobs(project, services, options.emit);
  const [library, state] = await Promise.all([loadLibrary(project), loadOrchestration(project)]);
  const counts = { profiles: state.settings.profiles.length, cases: state.settings.cases.length, blocks: Object.keys(library.blocks).length };
  const signal = options.signal ?? AbortSignal.timeout(600_000);
  const abort = () => { void jobs.close(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted(); await jobs.initialize();
    let job;
    try { job = await jobs.start({ instructions: options.instructions, regenerate: options.regenerate, maxSetupCostUsd: options.maxSetupCostUsd }); }
    catch (error) { if (error instanceof Error && error.message.startsWith("No connected provider")) return { status: "unconnected" as const, ...counts }; throw error; }
    if (job.status === "completed") return { status: "existing" as const, ...(job.result ?? counts) };
    // Invoking this synchronous compatibility function is an explicit retry.
    if (job.actions.canResume) job = await jobs.resume(job.id, { revision: job.revision });
    job = await jobs.wait(job.id); signal.throwIfAborted();
    if (job.status !== "completed" || !job.result) throw new Error(job.error ?? `Setup ${job.status}. Resume ${job.id} to continue.`);
    return { status: "generated" as const, profiles: job.result.profiles, cases: job.result.cases, blocks: job.result.blocks };
  } finally { signal.removeEventListener("abort", abort); await jobs.close(); }
}
