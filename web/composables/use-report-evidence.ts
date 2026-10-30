import { computed, ref, shallowRef, watch } from "vue";
import {
  isReportEvidenceEvent,
  type ReportEvidence,
  type RunEvent,
  type WorkflowRun,
} from "../../src/contracts.js";
import { client } from "../api.js";

/** Full saved evidence is separate from the lossy live activity window. */
export function useReportEvidence(
  run: () => WorkflowRun,
  liveEvents: () => RunEvent[],
) {
  const snapshot = shallowRef<ReportEvidence>();
  const loading = ref(true);
  const error = ref("");
  const retry = ref(0);
  watch(
    [
      () => run().id,
      () => run().revision,
      () => liveEvents().filter(isReportEvidenceEvent).at(-1)?.id,
      retry,
    ],
    ([id], previous, cleanup) => {
      const controller = new AbortController();
      if (id !== previous?.[0]) snapshot.value = undefined;
      loading.value = true;
      error.value = "";
      // Coalesce projection updates while active steps are saving checkpoints.
      const timer = setTimeout(async () => {
        try {
          const value = await client.reportEvidence(id, controller.signal);
          if (!controller.signal.aborted) snapshot.value = value;
        } catch (failure) {
          if (!controller.signal.aborted)
            error.value =
              failure instanceof Error ? failure.message : String(failure);
        } finally {
          if (!controller.signal.aborted) loading.value = false;
        }
      }, 80);
      cleanup(() => {
        clearTimeout(timer);
        controller.abort();
      });
    },
    { immediate: true },
  );
  return {
    events: computed(() => snapshot.value?.events ?? []),
    complete: computed(
      () => !!snapshot.value?.available && !loading.value && !error.value,
    ),
    available: computed(() => !!snapshot.value?.available),
    loading,
    error,
    refresh: () => {
      retry.value++;
    },
  };
}
