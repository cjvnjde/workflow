import { useEffect, useState, useSyncExternalStore } from "react";
import {
  setupJobSchema,
  setupJobsLatestSchema,
  setupSchema,
  type Setup,
  type SetupJob,
  type StartSetup,
} from "../../../src/contracts/index.js";
import { request } from "../../shared/api.js";

type SetupJobsState = {
  setup: Setup | undefined;
  job: SetupJob | null;
  loading: boolean;
  pending: boolean;
  error: string;
};

function createSetupJobs() {
  let state: SetupJobsState = {
    setup: undefined,
    job: null,
    loading: false,
    pending: false,
    error: "",
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<SetupJobsState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  let controller: AbortController | undefined;
  let version = 0;
  let disposed = false;
  let initialized = false;
  let completedGeneration: string | undefined;
  let actionError = "";
  let completed: () => Promise<void> = () => Promise.resolve();

  async function refresh() {
    if (disposed) return;
    const current = ++version;
    controller?.abort();
    const lookup = new AbortController();
    controller = lookup;
    update({ loading: true });
    try {
      const [setup, latest] = await Promise.all([
        request("/api/setup", setupSchema, { signal: lookup.signal }),
        request("/api/setup-jobs/latest", setupJobsLatestSchema, { signal: lookup.signal }),
      ]);
      if (current !== version || disposed) return;
      if (state.job?.id !== latest.job?.id || state.job?.revision !== latest.job?.revision)
        actionError = "";
      update({ setup, job: latest.job, error: actionError });
      const saved = setup.completedSetup;
      const generation = saved?.generationId ?? saved?.jobId ?? saved?.completedAt;
      const changed = initialized && generation && generation !== completedGeneration;
      initialized = true;
      const previousGeneration = completedGeneration;
      completedGeneration = generation;
      if (changed) {
        try {
          await completed();
        } catch (failure) {
          if (completedGeneration === generation) completedGeneration = previousGeneration;
          throw failure;
        }
      }
    } catch (failure) {
      if (current !== version || disposed || lookup.signal.aborted) return;
      update({ error: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      if (current === version && !disposed) update({ loading: false });
    }
  }

  async function act(url: string, body: unknown) {
    if (disposed || state.pending) return;
    version++;
    controller?.abort();
    actionError = "";
    update({ loading: false, pending: true, error: "" });
    try {
      // The host owns this operation. Unmounting a client must never cancel it.
      const job = await request(url, setupJobSchema, { method: "POST", body });
      if (disposed) return;
      update({ job });
      await refresh();
    } catch (failure) {
      if (!disposed) {
        actionError = failure instanceof Error ? failure.message : String(failure);
        update({ error: actionError });
      }
    } finally {
      if (!disposed) update({ pending: false });
    }
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => state,
    setCompleted(callback: () => Promise<void>) {
      completed = callback;
    },
    mount() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      version++;
      controller?.abort();
    },
    visible() {
      if (document.visibilityState === "visible" && !state.pending && !state.loading)
        void refresh();
    },
    refresh,
    start: (body: StartSetup) => act("/api/setup-jobs", body),
    resume: (maxSetupCostUsd?: number) =>
      state.job
        ? act(`/api/setup-jobs/${encodeURIComponent(state.job.id)}/resume`, {
            revision: state.job.revision,
            ...(maxSetupCostUsd !== undefined ? { maxSetupCostUsd } : {}),
          })
        : Promise.resolve(),
    cancel: () =>
      state.job
        ? act(`/api/setup-jobs/${encodeURIComponent(state.job.id)}/cancel`, {
            revision: state.job.revision,
          })
        : Promise.resolve(),
  };
}

/** One project-owned job survives all client navigation and disconnections. */
export function useSetupJobs(options: {
  revision: string | number;
  completed: () => Promise<void>;
}) {
  const [jobs] = useState(createSetupJobs);
  const state = useSyncExternalStore(jobs.subscribe, jobs.snapshot, jobs.snapshot);
  useEffect(() => {
    jobs.setCompleted(options.completed);
  }, [jobs, options.completed]);
  useEffect(() => {
    jobs.mount();
    const timer = setInterval(jobs.visible, 5000);
    document.addEventListener("visibilitychange", jobs.visible);
    return () => {
      jobs.dispose();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", jobs.visible);
    };
  }, [jobs]);
  useEffect(() => {
    if (!jobs.snapshot().pending) void jobs.refresh();
  }, [jobs, options.revision]);
  return {
    state,
    refresh: jobs.refresh,
    start: jobs.start,
    resume: jobs.resume,
    cancel: jobs.cancel,
  };
}

export interface SetupJobsController {
  state: SetupJobsState;
  refresh: () => Promise<void>;
  start: (body: StartSetup) => Promise<void>;
  resume: (maxSetupCostUsd?: number) => Promise<void>;
  cancel: () => Promise<void>;
}
