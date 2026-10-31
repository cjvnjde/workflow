import { blocksForAgent, type DesignProposal } from "../../../src/contracts/index.js";
import { executionLabel } from "../execution/execution-label.js";

export default function ProposalPreview({ proposal }: { proposal: DesignProposal }) {
  return (
    <details className="design-preview">
      <summary>Review proposed settings</summary>
      {proposal.scope === "profiles" &&
        proposal.profiles.map((profile) => (
          <article key={profile.id}>
            <strong>
              {profile.name}
              {!profile.enabled ? " · disabled" : ""}
            </strong>
            <small>
              {profile.agent.provider} / {profile.agent.model} · {profile.agent.thinking}
              {profile.id === proposal.coordinatorProfile ? " · planning model" : ""}
            </small>
            <p>{profile.description}</p>
          </article>
        ))}
      {proposal.scope === "cases" && (
        <>
          <p>{proposal.instructions}</p>
          {proposal.cases.map((item) => (
            <article key={item.id}>
              <strong>
                {item.name}
                {!item.enabled ? " · disabled" : ""}
              </strong>
              <p>{item.description}</p>
              <pre>{item.instructions}</pre>
            </article>
          ))}
        </>
      )}
      {proposal.scope === "blocks" && (
        <>
          {proposal.changes.blocks.map(({ bundle, rationale }) => (
            <article key={bundle.definition.id}>
              <strong>{bundle.definition.name}</strong>
              <p>{rationale}</p>
              <small>
                {bundle.definition.executor
                  ? executionLabel(bundle.definition.executor)
                  : `Model: ${bundle.definition.agent?.provider}/${bundle.definition.agent?.model}`}
              </small>
              <details>
                <summary>Instructions &amp; outputs</summary>
                <pre>
                  {JSON.stringify(
                    blocksForAgent({ [bundle.definition.id]: bundle })[bundle.definition.id],
                    null,
                    2,
                  )}
                </pre>
              </details>
            </article>
          ))}
          {proposal.changes.remove?.map((id) => (
            <p key={id} className="warning">
              Remove block: {id}
            </p>
          ))}
        </>
      )}
      {proposal.scope === "capabilities" && (
        <>
          {proposal.capabilities.skills.map((skill) => (
            <article key={skill.id}>
              <strong>
                {skill.name} · {skill.enabled ? "enabled" : "disabled"}
              </strong>
              <pre>{skill.content}</pre>
            </article>
          ))}
          {proposal.capabilities.mcpServers.map((server) => (
            <article key={server.id}>
              <strong>
                {server.name} · {server.enabled ? "enabled" : "disabled"}
              </strong>
              <pre>{JSON.stringify(server, null, 2)}</pre>
            </article>
          ))}
        </>
      )}
      {proposal.scope === "execution" && <pre>{JSON.stringify(proposal.settings, null, 2)}</pre>}
      <details>
        <summary>Full proposal JSON</summary>
        <pre>{JSON.stringify(proposal, null, 2)}</pre>
      </details>
    </details>
  );
}
