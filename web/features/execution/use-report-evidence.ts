import { useEffect, useState } from "react";
import {
  isReportEvidenceEvent,
  type ReportEvidence,
  type RunEvent,
  type WorkflowRun,
} from "../../../src/contracts/index.js";
import { client } from "../../shared/api.js";

/** Full saved evidence is separate from the lossy live activity window. */
export function useReportEvidence(run: WorkflowRun, liveEvents: RunEvent[]) {
  const [retry, setRetry] = useState(0);
  const lastEvidenceId = liveEvents.filter(isReportEvidenceEvent).at(-1)?.id;
  const requestKey = `${run.id}/${run.revision}/${lastEvidenceId ?? ""}/${retry}`;
  const [result, setResult] = useState<{
    runId: string;
    requestKey: string;
    snapshot?: ReportEvidence;
    loading: boolean;
    error: string;
  }>({ runId: run.id, requestKey, loading: true, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setResult((previous) => ({
        runId: run.id,
        requestKey,
        snapshot: previous.runId === run.id ? previous.snapshot : undefined,
        loading: true,
        error: "",
      }));
      try {
        const snapshot = await client.reportEvidence(run.id, controller.signal);
        if (!controller.signal.aborted)
          setResult({ runId: run.id, requestKey, snapshot, loading: false, error: "" });
      } catch (failure) {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            ...previous,
            loading: false,
            error: failure instanceof Error ? failure.message : String(failure),
          }));
      }
    }, 80);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [run.id, requestKey]);
  const snapshot = result.runId === run.id ? result.snapshot : undefined;
  const loading = result.requestKey !== requestKey || result.loading;
  const error = result.requestKey === requestKey ? result.error : "";
  return {
    events: snapshot?.events ?? [],
    complete: !!snapshot?.available && !loading && !error,
    available: !!snapshot?.available,
    loading,
    error,
    refresh: () => setRetry((value) => value + 1),
  };
}
