import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import {
  setupJobSchema,
  type Setup,
  type SetupJob,
  type StartSetup,
} from "../../../src/contracts/index.js";
import { client, request } from "../../shared/api.js";
import { workflowQueryKeys } from "../../shared/query-client.js";

type SetupJobsState = {
  setup: Setup | undefined;
  job: SetupJob | null;
  loading: boolean;
  pending: boolean;
  error: string;
};
type SetupAction = { url: string; body: unknown; observedJob: string };
const setupMutationKey = ["setup-action"] as const;
const setupOptions = queryOptions({
  queryKey: workflowQueryKeys.setup,
  queryFn: async ({ signal }) => {
    const [setup, latest] = await Promise.all([
      client.setupState(signal),
      client.latestSetup(signal),
    ]);
    return { setup, job: latest.job };
  },
});

/** The host owns mutations; Query owns cancellable lookups and visible-window polling. */
export function useSetupJobs(options: {
  revision: string | number;
  completed: () => Promise<void>;
}): SetupJobsController {
  const queryClient = useQueryClient();
  const [completionError, setCompletionError] = useState("");
  const completion = useRef<{
    initialized: boolean;
    generation: string | undefined;
    pending: boolean;
  }>({ initialized: false, generation: undefined, pending: false });
  const mounted = useRef(false);
  const completed = useEffectEvent(options.completed);
  const action = useMutation({
    mutationKey: setupMutationKey,
    onMutate: () => queryClient.cancelQueries({ queryKey: workflowQueryKeys.setup }),
    mutationFn: ({ url, body }: SetupAction) =>
      // Unmounting a client must never cancel a project-owned setup operation.
      request(url, setupJobSchema, { method: "POST", body }),
    onSuccess: async (job) => {
      queryClient.setQueryData(setupOptions.queryKey, (current) =>
        current ? { ...current, job } : undefined,
      );
      await queryClient.query({ ...setupOptions, staleTime: 0 });
    },
  });
  const query = useQuery({
    ...setupOptions,
    enabled: !action.isPending,
    refetchInterval: 5000,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.setup });
  }, [queryClient, options.revision]);
  useEffect(() => {
    if (!query.data) return;
    const saved = query.data.setup.completedSetup;
    const generation = saved?.generationId ?? saved?.jobId ?? saved?.completedAt;
    const current = completion.current;
    if (!current.initialized) {
      current.initialized = true;
      current.generation = generation;
      return;
    }
    if (!generation || generation === current.generation || current.pending) return;
    current.pending = true;
    void (async () => {
      try {
        await completed();
        current.generation = generation;
        if (mounted.current) setCompletionError("");
      } catch (failure) {
        if (mounted.current)
          setCompletionError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        current.pending = false;
      }
    })();
  }, [query.data, query.dataUpdatedAt]);

  const refresh = useCallback(async () => {
    if (queryClient.isMutating({ mutationKey: setupMutationKey })) return;
    try {
      await queryClient.cancelQueries({ queryKey: workflowQueryKeys.setup });
      await queryClient.query({ ...setupOptions, staleTime: 0 });
    } catch {
      // Query retains the failure for the UI and retries on the next refresh or poll.
    }
  }, [queryClient]);
  const act = async (url: string, body: unknown) => {
    if (queryClient.isMutating({ mutationKey: setupMutationKey })) return;
    const job = queryClient.getQueryData(setupOptions.queryKey)?.job;
    try {
      await action.mutateAsync({
        url,
        body,
        observedJob: job ? `${job.id}:${job.revision}` : "",
      });
    } catch {
      // The mutation retains its error; server-owned work is not cancelled on unmount.
    }
  };
  const job = query.data?.job ?? null;
  const observedJob = job ? `${job.id}:${job.revision}` : "";
  const actionError = action.variables?.observedJob === observedJob ? action.error?.message : "";
  return {
    state: {
      setup: query.data?.setup,
      job,
      loading: query.isFetching,
      pending: action.isPending,
      error: query.error?.message || actionError || completionError,
    },
    refresh,
    start: (body) => act("/api/setup-jobs", body),
    resume: (maxSetupCostUsd) =>
      job
        ? act(`/api/setup-jobs/${encodeURIComponent(job.id)}/resume`, {
            revision: job.revision,
            ...(maxSetupCostUsd !== undefined ? { maxSetupCostUsd } : {}),
          })
        : Promise.resolve(),
    cancel: () =>
      job
        ? act(`/api/setup-jobs/${encodeURIComponent(job.id)}/cancel`, {
            revision: job.revision,
          })
        : Promise.resolve(),
  };
}

export interface SetupJobsController {
  state: SetupJobsState;
  refresh: () => Promise<void>;
  start: (body: StartSetup) => Promise<void>;
  resume: (maxSetupCostUsd?: number) => Promise<void>;
  cancel: () => Promise<void>;
}
