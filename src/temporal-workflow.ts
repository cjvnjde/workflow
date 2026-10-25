import {
  ApplicationFailure,
  CancellationScope,
  CancelledFailure,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import { executionTimeoutMs, resolveInputs, runSchema, type BlockResult, type CheckResult, type WorkflowRun, type WorkflowNode, type RecoveryResult, type UsageTotals } from "./domain.js";
import { addUsage, emptyUsage } from "./budget.js";
import { failureMessage } from "./failure-message.js";
import { programStep } from "./program-steps.js";
import { executeCode } from "./code-runtime.js";
import type { CodeOperation } from "./code-schema.js";
import type { Block, CodeBlock, StepOptions, WorkflowDefinition } from "./workflow-sdk.js";
import { describeFlow } from "./composition-sdk.js";
import { executeFlow, FlowDispatchStopped } from "./composition-runtime.js";

export type AttemptIdentity = { nodeId: string; visit: number };

export type WorkflowActivities = {
  saveProjection(run: WorkflowRun, event?: { kind: string; message: string; nodeId?: string }): Promise<void>;
  settleAttempt(run: WorkflowRun, commit: boolean, identity?: AttemptIdentity): Promise<{ recovery: RecoveryResult; usage: UsageTotals }>;
  executeOperation(run: WorkflowRun, operation: CodeOperation, identity?: AttemptIdentity): Promise<unknown>;
  executeBlock(run: WorkflowRun, identity?: AttemptIdentity): Promise<{ result: BlockResult; checks: CheckResult[] }>;
};

export const pauseSignal = defineSignal("pause");
export const resumeSignal = defineSignal("resume");
export const stateQuery = defineQuery<WorkflowRun>("state");
const { saveProjection, settleAttempt } = proxyActivities<WorkflowActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 5 },
});

export async function executeWorkflow(input: WorkflowRun, loadProgram?: () => WorkflowDefinition & { blocks?: Record<string, CodeBlock<any, any>> }) {
  const parsed = runSchema.safeParse(input);
  if (!parsed.success) {
    throw ApplicationFailure.nonRetryable("Invalid workflow execution snapshot", "InvalidSnapshot");
  }
  const run = parsed.data;
  let paused = false;
  let resumeEpoch = 0;
  let resumeNotice = false;
  const interrupted = new Map<string, string>();
  run.activeNodes = [];
  const structured = run.program?.composition === "structured";
  let cancelled = false;
  const changed = () => {
    run.revision += 1;
    run.updatedAt = new Date().toISOString();
  };
  setHandler(stateQuery, () => run);
  const updateStatus = () => {
    run.status = interrupted.size ? "interrupted" : paused ? run.activeNodes!.length ? "pausing" : "paused" : "running";
    if (interrupted.size) run.error = [...interrupted.values()].join("\n");
    else delete run.error;
    if (run.activeNodes!.length) run.cursor = run.activeNodes![0]!;
  };
  setHandler(pauseSignal, () => {
    if (run.status === "running" || run.status === "pausing") {
      paused = true;
      updateStatus();
      changed();
    }
  });
  setHandler(resumeSignal, () => {
    if (run.status === "paused" || run.status === "pausing" || run.status === "interrupted") {
      resumeNotice = run.status !== "interrupted";
      paused = false;
      resumeEpoch++;
      updateStatus();
      changed();
    }
  });
  const checkpoint = async (kind: string, message: string, nodeId?: string) => {
    changed();
    await saveProjection(run, { kind, message, nodeId });
  };

  const executeNode = async (node: WorkflowNode, body?: (identity: AttemptIdentity) => Promise<{ result: BlockResult; checks: CheckResult[] }>, stopped: () => boolean = () => false): Promise<BlockResult> => {
    while (true) {
      while (true) {
        while (!stopped() && (paused || interrupted.size || run.activeNodes!.length >= 8)) await condition(() => stopped() || !paused && interrupted.size === 0 && run.activeNodes!.length < 8);
        if (stopped()) throw new FlowDispatchStopped();
        if (!resumeNotice) break;
        resumeNotice = false;
        await checkpoint("resumed", "Workflow resumed.");
      }
      const bundle = run.blocks[node.block];
      if (!bundle) {
        throw new Error(`Unknown execution node or block: ${run.cursor}`);
      }
      const visit = (run.visits[node.id] ?? 0) + 1;
      if (visit > node.maxVisits || run.attempts.length >= run.config.maxSteps) {
        throw new Error(`Workflow iteration budget exhausted at ${node.id}`);
      }
      if (!bundle.definition.executor && run.config.budget?.maxCostUsd !== undefined && (run.usage?.costUsd ?? 0) >= run.config.budget.maxCostUsd) { throw new Error("Workflow spending limit reached"); }
      resolveInputs(node, run);
      run.visits[node.id] = visit;
      const attempt: WorkflowRun["attempts"][number] = {
        nodeId: node.id,
        visit,
        startedAt: new Date().toISOString(),
        checks: [],
      };
      run.attempts.push(attempt);
      const identity = { nodeId: node.id, visit };
      run.activeNodes!.push(node.id);
      updateStatus();
      const deactivate = () => {
        run.activeNodes = run.activeNodes!.filter(id => id !== node.id);
        updateStatus();
      };
      const settle = async (commit: boolean) => {
        const settled = await CancellationScope.nonCancellable(() => settleAttempt(run, commit, identity));
        attempt.recovery = settled.recovery;
        attempt.usage = settled.usage;
        run.usage = run.attempts.reduce((total, item) => addUsage(total, item.usage ?? emptyUsage()), emptyUsage());
        return settled.recovery;
      };
      const waitToResume = async (message: string, observed: number) => {
        while (true) {
          await condition(() => stopped() || resumeEpoch > observed);
          if (stopped()) { interrupted.delete(node.id); updateStatus(); throw new FlowDispatchStopped(); }
          observed = resumeEpoch;
          const recovery = await settle(false);
          if (recovery.status !== "conflict") { break; }
          interrupted.set(node.id, `Recovery conflicts: ${recovery.conflicts.join(", ")}. Resolve them before resuming.`);
          updateStatus();
          await checkpoint("interrupted", run.error!, node.id);
        }
        interrupted.delete(node.id);
        updateStatus();
        await checkpoint("resumed", message, node.id);
      };
      await checkpoint("node_start", `${node.label} · visit ${visit}/${node.maxVisits}`, node.id);
      const activities = proxyActivities<WorkflowActivities>({
        startToCloseTimeout: executionTimeoutMs(run.config, bundle, node) + 5000,
        heartbeatTimeout: "10 seconds",
        cancellationType: "WAIT_CANCELLATION_COMPLETED",
        // Agent/check activities can mutate files. Never blindly retry them after a crash.
        retry: { maximumAttempts: 1 },
      });
      let completion: Awaited<ReturnType<WorkflowActivities["executeBlock"]>>;
      try {
        completion = body ? await body(identity) : await activities.executeBlock(run, identity);
      } catch (error) {
        attempt.finishedAt = new Date().toISOString();
        attempt.error = failureMessage(error);
        const recovery = await settle(false);
        deactivate();
        if (isCancellation(error) && CancellationScope.current().consideredCancelled) { throw error; }
        interrupted.set(node.id, `${node.label}: ${attempt.error}. ${recovery.status === "conflict" ? `Recovery conflicts: ${recovery.conflicts.join(", ")}. Resolve them before resuming.` : `File-tool recovery: ${recovery.status}. Inspect shell, Git and check-command effects before resuming.`} Resume retries this step and consumes another visit.`);
        updateStatus();
        const observed = resumeEpoch;
        await checkpoint("interrupted", run.error!, node.id);
        await waitToResume("Explicitly retrying the interrupted step. Completed steps are not replayed.", observed);
        continue;
      }
      const recovery = await settle(completion.result.outcome === "pass");
      if (recovery.status === "conflict") {
        attempt.finishedAt = new Date().toISOString();
        attempt.error = `Recovery conflicts: ${recovery.conflicts.join(", ")}`;
        deactivate();
        interrupted.set(node.id, attempt.error); updateStatus();
        const observed = resumeEpoch;
        await checkpoint("interrupted", run.error!, node.id);
        await waitToResume("Retrying after recovery conflicts were resolved.", observed);
        continue;
      }
      if (recovery.status === "restored") {
        completion.result.summary = completion.result.summary.slice(0, 13_500) + `\nHost file recovery restored this nonpassing attempt: ${recovery.restored.join(", ").slice(0, 2000)}.`;
      }
      attempt.finishedAt = new Date().toISOString();
      attempt.result = completion.result;
      attempt.checks = completion.checks;
      const evidence = completion.checks.map((check) => `${check.command}: exit ${check.exitCode}, expected ${check.expected}\n${check.output}`).join("\n\n");
      run.artifacts[node.id] = {
        ...completion.result.artifacts,
        summary: completion.result.summary + (evidence ? `\n\nHost checks:\n${evidence}` : ""),
      };
      deactivate();
      if (!structured) run.cursor = node.on[completion.result.outcome];
      await checkpoint("node_end", `${completion.result.outcome.toUpperCase()}${structured ? "" : ` → ${run.cursor}`}\n${completion.result.summary}`, node.id);
      if (paused && !run.activeNodes!.length && !interrupted.size) await checkpoint("paused", "All active steps finished. Resume continues at the next step.");
      return completion.result;
    }
  };
  try {
    await checkpoint("approved", run.mode === "demo" ? "Approved for DEMO simulation only." : "Approved. Temporal is executing the frozen workflow.");
    if (run.program) {
      const program = loadProgram?.();
      if (!program || (!program.flow && typeof program.run !== "function")) throw new Error("Export default workflow({name, flow}) or workflow({name, async run(ctx) {…}}).");
      const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
      if (program.flow && (!structured || canonical(describeFlow(program.flow)) !== canonical(run.program.structure))) throw new Error("Composition differs from its reviewed structure. Use deterministic declarations.");
      // User code can keep and customize local state. Never expose the frozen
      // approval snapshot itself: mutating a model option or an input must not
      // invalidate later checkpoints.
      const inputValue = JSON.parse(JSON.stringify(run.program.input));
      const input = program.input ? program.input.parse(inputValue) : inputValue;
      const models = JSON.parse(JSON.stringify(run.program.models)) as typeof run.program.models;
      const pending = new Set<Promise<unknown>>();
      const activeIds = new Set<string>();
      const scope = new CancellationScope();
      const step = (id: string, reference: Block | CodeBlock<any, any> | string, options: StepOptions = {}, envelope = false, stopped?: () => boolean): Promise<any> => {
        if (!structured && pending.size) return Promise.reject(new Error("Await each ctx.step before starting another; use parallel() for explicit parallel composition."));
        if (activeIds.has(id)) return Promise.reject(new Error(`Step ${id} is already active`));
        activeIds.add(id);
        const operation = (async () => {
          const saved = typeof reference === "string" ? program.blocks?.[reference] : undefined;
          const block = saved ?? reference;
          const node = programStep(run, id, run.program!.composition === "graph" ? reference : block, options);
          // Saved code keeps its reviewed metadata/resources as well as the
          // compiled function. Inline definitions derive theirs from the source.
          if (saved && typeof reference === "string") {
            const bundle = run.program!.catalog[reference]!;
            run.blocks[node.block] = JSON.parse(JSON.stringify(bundle));
            run.blocks[node.block]!.definition.id = node.block;
            if (!run.program!.composition) node.label = options.label ?? bundle.definition.name;
            const executor = run.blocks[node.block]!.definition.executor;
            if (executor?.kind === "code") {
              executor.timeoutMs = saved.options.timeoutMs ?? executor.timeoutMs;
              executor.maxOperations = saved.options.maxOperations ?? executor.maxOperations;
            }
          }
          if (typeof block !== "string" && block.kind === "code") {
            let codeError: string | undefined;
            const result = await executeNode(node, async identity => {
              const activities = proxyActivities<WorkflowActivities>({
                startToCloseTimeout: executionTimeoutMs(run.config, run.blocks[node.block]!, node) + 5000,
                heartbeatTimeout: "10 seconds", cancellationType: "WAIT_CANCELLATION_COMPLETED",
                retry: { maximumAttempts: 1 },
              });
              const completion = await executeCode({ run, node, block, step: options,
                operation: value => activities.executeOperation(run, value, identity),
                log: message => checkpoint("block_log", message, node.id),
              });
              codeError = completion.error;
              return { result: completion.result, checks: [] };
            }, stopped);
            if (codeError && !envelope) throw new Error(codeError);
            if (!envelope && result.outcome === "fail") throw new Error(result.summary);
            const data = result.artifacts.data === undefined ? undefined : JSON.parse(result.artifacts.data);
            return envelope ? { ...result, data } : data;
          }
          const result = await executeNode(node, undefined, stopped);
          let data: unknown;
          if (result.artifacts.data) {
            try { data = JSON.parse(result.artifacts.data); }
            catch { /* Nonpassing legacy steps may return diagnostics instead of typed data. */ }
          }
          return { ...result, artifacts: { ...result.artifacts, summary: run.artifacts[node.id]?.summary ?? result.summary }, data };
        })();
        pending.add(operation);
        void operation.finally(() => {
          pending.delete(operation); activeIds.delete(id);
          if (run.activeNodes!.includes(id)) { run.activeNodes = run.activeNodes!.filter(active => active !== id); updateStatus(); }
        }).catch(() => {});
        return operation;
      };
      let output: unknown;
      try {
        output = await scope.run(() => program.flow ? executeFlow({
          flow: program.flow, structure: run.program!.structure!, input, request: run.plan.task, models,
          step: (node, options, stopped) => step(node.id, node.block, options, true, stopped),
          group: async (id, state) => { (run.groups ??= {})[id] = { ...run.groups?.[id], ...state }; await checkpoint("group_state", `${id}: ${state.state}${state.iteration ? ` · iteration ${state.iteration}` : ""}`, id); },
        }) : program.run!({ input, request: run.plan.task, models, step, stepResult: (id, block, options) => step(id, block, options, true) }));
        if (pending.size) throw new Error("The workflow returned before its step finished. Await every ctx.step call.");
      } catch (error) {
        scope.cancel();
        await Promise.allSettled([...pending]);
        throw error;
      }
      if (output !== undefined) {
        run.output = (typeof output === "string" ? output : `\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``).slice(0, 64_000);
      }
      run.cursor = "$complete";
    } else {
      while (run.cursor !== "$complete" && run.cursor !== "$failed") {
        const node = run.plan.nodes.find(candidate => candidate.id === run.cursor);
        if (!node) throw new Error(`Unknown execution node: ${run.cursor}`);
        await executeNode(node);
      }
    }
    run.status = run.cursor === "$complete" ? "completed" : "failed";
  } catch (error) {
    cancelled = isCancellation(error) || CancellationScope.current().consideredCancelled;
    run.status = cancelled ? "cancelled" : "failed";
    run.error = failureMessage(error);
    run.cursor = "$failed";
  }
  run.activeNodes = [];
  await CancellationScope.nonCancellable(async () => {
    if (run.program && !structured) {
      const last = run.attempts.at(-1);
      if (last) (run.transitions ??= []).push({
        from: last.nodeId, to: run.status === "completed" ? "$complete" : "$failed",
        outcome: run.status === "completed" ? "pass" : "fail",
      });
    }
    await checkpoint("run_end", `${run.status.toUpperCase()}${run.error ? `: ${run.error}` : ""}`);
  });

  if (cancelled) {
    throw new CancelledFailure("Cancelled by user");
  }

  return run;
}
