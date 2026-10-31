import type { StrategyMetadata } from "../../../src/contracts/index.js";
import { usageCost, usageTokens } from "../usage/usage-presentation.js";
import "./StrategyFacts.css";

export default function StrategyFacts({ metadata }: { metadata: StrategyMetadata }) {
  return (
    <section className="strategy-facts" aria-label="Strategy source facts">
      <h3>Source facts</h3>
      <p>
        Your endorsement means this approach was useful to you. Completion and check outcomes are
        recorded evidence, not proof of correctness or a model quality ranking.
      </p>
      {metadata.mode === "demo" && (
        <p className="setup-notice">
          Demo source: these simulated outcomes are not real project validation.
        </p>
      )}
      <dl className="strategy-fact-grid">
        <div>
          <dt>Task type</dt>
          <dd>
            {metadata.taskType.name} · {metadata.taskType.id}
          </dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{new Date(metadata.completedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Step visits</dt>
          <dd>
            {metadata.outcomes.pass} pass · {metadata.outcomes.retry} retry ·{" "}
            {metadata.outcomes.fail} fail · {metadata.outcomes.interrupted} interrupted
          </dd>
        </div>
        <div>
          <dt>Configured check conditions</dt>
          <dd>
            {metadata.checks.matched} matched · {metadata.checks.unmatched} unmatched ·{" "}
            {metadata.checks.total} recorded
          </dd>
        </div>
        <div>
          <dt>Recorded usage</dt>
          <dd>
            {usageCost(metadata.usage, metadata.usageIncomplete)} ·{" "}
            {usageTokens(metadata.usage).toLocaleString()} tokens
          </dd>
        </div>
        <div>
          <dt>Source workflow</dt>
          <dd>
            <a href={`#run=${metadata.sourceRunId}`}>{metadata.sourceRunId}</a> · revision{" "}
            {metadata.sourceRunRevision}
          </dd>
        </div>
      </dl>
      <details className="strategy-roles">
        <summary>
          Roles &amp; model choices · {metadata.roles.length}
          {metadata.omittedRoles ? ` shown, ${metadata.omittedRoles} more` : ""}
        </summary>
        <p>
          Observed models come from recorded sessions. Configured models are settings hints. Future
          planning can choose current models and compose a fresh workflow.
        </p>
        {metadata.roles.map((role) => (
          <article key={role.nodeId}>
            <h4>{role.label}</h4>
            <p>
              {role.blockId ?? "Inline block"} · {role.executionKind} · {role.visits}{" "}
              {role.visits === 1 ? "visit" : "visits"}
            </p>
            {role.modelHints.length ? (
              <ul>
                {role.modelHints.map((model) => (
                  <li
                    key={JSON.stringify([
                      model.provider,
                      model.model,
                      model.thinking,
                      model.source,
                    ])}
                  >
                    {model.provider}/{model.model} · {model.thinking} ·{" "}
                    {model.source === "observed" ? "observed session" : "configured hint"}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No model attribution recorded for this role.</p>
            )}
            {!!role.omittedModelHints && (
              <p>
                {role.omittedModelHints} additional model hints omitted from this compact record.
              </p>
            )}
          </article>
        ))}
        {!!metadata.omittedRoles && (
          <p>{metadata.omittedRoles} additional roles omitted from this compact record.</p>
        )}
        {!!metadata.models.length && (
          <details>
            <summary>Models across the source workflow</summary>
            <ul>
              {metadata.models.map((model) => (
                <li
                  key={JSON.stringify([model.provider, model.model, model.thinking, model.source])}
                >
                  {model.provider}/{model.model} · {model.thinking} · {model.source}
                </li>
              ))}
            </ul>
            {!!metadata.omittedModels && <p>{metadata.omittedModels} additional models omitted.</p>}
          </details>
        )}
      </details>
      <details>
        <summary>Acceptance signals</summary>
        <p>
          {metadata.dispositions.workCompleted} work completed · {metadata.dispositions.accepted}{" "}
          accepted · {metadata.dispositions.changesRequested} changes requested ·{" "}
          {metadata.dispositions.blocked} blocked
        </p>
        <p>Matched check conditions can include expected failures.</p>
      </details>
    </section>
  );
}
