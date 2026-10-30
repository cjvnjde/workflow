<script setup lang="ts">
import type { StrategyMetadata } from "../../src/contracts.js";
import { usageCost, usageTokens } from "../usage-presentation.js";
defineProps<{ metadata: StrategyMetadata }>();
const date = (value: string) => new Date(value).toLocaleString();
</script>

<template>
  <section class="strategy-facts" aria-label="Strategy source facts">
    <h3>Source facts</h3>
    <p>
      Your endorsement means this approach was useful to you. Completion and
      check outcomes are recorded evidence, not proof of correctness or a model
      quality ranking.
    </p>
    <p v-if="metadata.mode === 'demo'" class="setup-notice">
      Demo source: these simulated outcomes are not real project validation.
    </p>
    <dl class="strategy-fact-grid">
      <div>
        <dt>Task type</dt>
        <dd>{{ metadata.taskType.name }} · {{ metadata.taskType.id }}</dd>
      </div>
      <div>
        <dt>Completed</dt>
        <dd>{{ date(metadata.completedAt) }}</dd>
      </div>
      <div>
        <dt>Step visits</dt>
        <dd>
          {{ metadata.outcomes.pass }} pass ·
          {{ metadata.outcomes.retry }} retry ·
          {{ metadata.outcomes.fail }} fail ·
          {{ metadata.outcomes.interrupted }} interrupted
        </dd>
      </div>
      <div>
        <dt>Configured check conditions</dt>
        <dd>
          {{ metadata.checks.matched }} matched ·
          {{ metadata.checks.unmatched }} unmatched ·
          {{ metadata.checks.total }} recorded
        </dd>
      </div>
      <div>
        <dt>Recorded usage</dt>
        <dd>
          {{ usageCost(metadata.usage, metadata.usageIncomplete) }} ·
          {{ usageTokens(metadata.usage).toLocaleString() }} tokens
        </dd>
      </div>
      <div>
        <dt>Source workflow</dt>
        <dd>
          <a :href="`#run=${metadata.sourceRunId}`">{{
            metadata.sourceRunId
          }}</a>
          · revision {{ metadata.sourceRunRevision }}
        </dd>
      </div>
    </dl>
    <details class="strategy-roles">
      <summary>
        Roles & model choices · {{ metadata.roles.length
        }}{{
          metadata.omittedRoles ? ` shown, ${metadata.omittedRoles} more` : ""
        }}
      </summary>
      <p>
        Observed models come from recorded sessions. Configured models are
        settings hints. Future planning can choose current models and compose a
        fresh workflow.
      </p>
      <article v-for="role in metadata.roles" :key="role.nodeId">
        <h4>{{ role.label }}</h4>
        <p>
          {{ role.blockId ?? "Inline block" }} · {{ role.executionKind }} ·
          {{ role.visits }} {{ role.visits === 1 ? "visit" : "visits" }}
        </p>
        <ul v-if="role.modelHints.length">
          <li v-for="(model, index) in role.modelHints" :key="index">
            {{ model.provider }}/{{ model.model }} · {{ model.thinking }} ·
            {{
              model.source === "observed"
                ? "observed session"
                : "configured hint"
            }}
          </li>
        </ul>
        <p v-else>No model attribution recorded for this role.</p>
        <p v-if="role.omittedModelHints">
          {{ role.omittedModelHints }} additional model hints omitted from this
          compact record.
        </p>
      </article>
      <p v-if="metadata.omittedRoles">
        {{ metadata.omittedRoles }} additional roles omitted from this compact
        record.
      </p>
      <details v-if="metadata.models.length">
        <summary>Models across the source workflow</summary>
        <ul>
          <li v-for="(model, index) in metadata.models" :key="index">
            {{ model.provider }}/{{ model.model }} · {{ model.thinking }} ·
            {{ model.source }}
          </li>
        </ul>
        <p v-if="metadata.omittedModels">
          {{ metadata.omittedModels }} additional models omitted.
        </p>
      </details>
    </details>
    <details>
      <summary>Acceptance signals</summary>
      <p>
        {{ metadata.dispositions.workCompleted }} work completed ·
        {{ metadata.dispositions.accepted }} accepted ·
        {{ metadata.dispositions.changesRequested }} changes requested ·
        {{ metadata.dispositions.blocked }} blocked
      </p>
      <p>Matched check conditions can include expected failures.</p>
    </details>
  </section>
</template>

<style scoped>
.strategy-facts {
  min-width: 0;
}
.strategy-facts p {
  line-height: 1.6;
  color: var(--ctp-subtext0);
}
.strategy-facts h3 {
  margin-top: 0;
}
.strategy-facts summary {
  cursor: pointer;
  line-height: 1.5;
}
.strategy-facts details {
  margin-top: 16px;
}
.strategy-fact-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.strategy-fact-grid dt {
  color: var(--ctp-subtext0);
  font-size: 11px;
  margin-bottom: 5px;
}
.strategy-fact-grid dd {
  margin: 0;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.strategy-roles article {
  padding: 12px;
  margin-top: 10px;
  background: var(--ctp-mantle);
  border-radius: 8px;
  overflow-wrap: anywhere;
}
.strategy-roles h4 {
  margin: 0;
}
.strategy-roles article p {
  margin: 6px 0;
}
.strategy-facts li {
  margin: 5px 0;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .strategy-fact-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
