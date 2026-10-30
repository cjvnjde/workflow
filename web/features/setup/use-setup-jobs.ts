import { onMounted, onScopeDispose, reactive, watch } from "vue";
import {
  setupJobSchema,
  setupJobsLatestSchema,
  setupSchema,
  type Setup,
  type SetupJob,
  type StartSetup,
} from "../../../src/contracts/index.js";
import { request } from "../../shared/api.js";

/** One project-owned job survives all client navigation and disconnections. */
export function useSetupJobs(options: {
  revision: () => string | number;
  completed: () => Promise<void>;
}) {
  const state = reactive({
    setup: undefined as Setup | undefined,
    job: null as SetupJob | null,
    loading: false,
    pending: false,
    error: "",
  });
  let controller: AbortController | undefined;
  let version = 0;
  let disposed = false;
  let initialized = false;
  let completedGeneration: string | undefined;
  let actionError = "";
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh() {
    if (disposed) return;
    const current = ++version;
    controller?.abort();
    controller = new AbortController();
    state.loading = true;
    try {
      const [setup, latest] = await Promise.all([
        request("/api/setup", setupSchema, { signal: controller.signal }),
        request("/api/setup-jobs/latest", setupJobsLatestSchema, {
          signal: controller.signal,
        }),
      ]);
      if (current !== version || disposed) return;
      if (state.job?.id !== latest.job?.id || state.job?.revision !== latest.job?.revision)
        actionError = "";
      state.setup = setup;
      state.job = latest.job;
      state.error = actionError;
      const completed = setup.completedSetup;
      const generation = completed?.generationId ?? completed?.jobId ?? completed?.completedAt;
      const changed = initialized && generation && generation !== completedGeneration;
      initialized = true;
      const previousGeneration = completedGeneration;
      completedGeneration = generation;
      if (changed) {
        try {
          await options.completed();
        } catch (failure) {
          if (completedGeneration === generation) completedGeneration = previousGeneration;
          throw failure;
        }
      }
    } catch (failure) {
      if (current !== version || disposed || controller.signal.aborted) return;
      state.error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      if (current === version && !disposed) state.loading = false;
    }
  }

  async function act(url: string, body: unknown) {
    if (disposed || state.pending) return;
    version++;
    controller?.abort();
    state.loading = false;
    state.pending = true;
    actionError = "";
    state.error = "";
    try {
      // The host owns this operation. Unmounting a client must never cancel it.
      const job = await request(url, setupJobSchema, { method: "POST", body });
      if (disposed) return;
      state.job = job;
      await refresh();
    } catch (failure) {
      if (!disposed)
        state.error = actionError = failure instanceof Error ? failure.message : String(failure);
    } finally {
      if (!disposed) state.pending = false;
    }
  }
  const start = (body: StartSetup) => act("/api/setup-jobs", body);
  const resume = (maxSetupCostUsd?: number) =>
    state.job
      ? act(`/api/setup-jobs/${encodeURIComponent(state.job.id)}/resume`, {
          revision: state.job.revision,
          ...(maxSetupCostUsd !== undefined ? { maxSetupCostUsd } : {}),
        })
      : Promise.resolve();
  const cancel = () =>
    state.job
      ? act(`/api/setup-jobs/${encodeURIComponent(state.job.id)}/cancel`, {
          revision: state.job.revision,
        })
      : Promise.resolve();
  watch(
    options.revision,
    () => {
      if (!state.pending) void refresh();
    },
    { immediate: true },
  );
  const visible = () => {
    if (document.visibilityState === "visible" && !state.pending) void refresh();
  };
  onMounted(() => {
    timer = setInterval(() => {
      if (!state.loading) visible();
    }, 5000);
    document.addEventListener("visibilitychange", visible);
  });
  onScopeDispose(() => {
    disposed = true;
    version++;
    controller?.abort();
    clearInterval(timer);
    document.removeEventListener("visibilitychange", visible);
  });
  return { state, refresh, start, resume, cancel };
}

export type SetupJobsController = ReturnType<typeof useSetupJobs>;
