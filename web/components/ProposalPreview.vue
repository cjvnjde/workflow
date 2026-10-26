<script setup lang="ts">
import { blocksForAgent } from "../../src/contracts.js";
import { executionLabel } from "../execution-label.js";
import type { DesignProposal } from "../../src/contracts.js";
defineProps<{ proposal: DesignProposal }>();
</script>

<template>
  <details class="design-preview">
    <summary>Review proposed settings</summary>
    <template v-if="proposal.scope === 'profiles'"
      ><article v-for="profile in proposal.profiles" :key="profile.id">
        <strong
          >{{ profile.name }}{{ !profile.enabled ? " · disabled" : "" }}</strong
        ><small
          >{{ profile.agent.provider }} / {{ profile.agent.model }} ·
          {{ profile.agent.thinking
          }}{{
            profile.id === proposal.coordinatorProfile
              ? " · planning model"
              : ""
          }}</small
        >
        <p>{{ profile.description }}</p>
      </article></template
    >
    <template v-if="proposal.scope === 'cases'"
      ><p>{{ proposal.instructions }}</p>
      <article v-for="item in proposal.cases" :key="item.id">
        <strong>{{ item.name }}{{ !item.enabled ? " · disabled" : "" }}</strong>
        <p>{{ item.description }}</p>
        <pre>{{ item.instructions }}</pre>
      </article></template
    >
    <template v-if="proposal.scope === 'blocks'"
      ><article
        v-for="{ bundle, rationale } in proposal.changes.blocks"
        :key="bundle.definition.id"
      >
        <strong>{{ bundle.definition.name }}</strong>
        <p>{{ rationale }}</p>
        <small>{{
          bundle.definition.executor
            ? executionLabel(bundle.definition.executor)
            : `Model: ${bundle.definition.agent?.provider}/${bundle.definition.agent?.model}`
        }}</small>
        <details>
          <summary>Instructions & outputs</summary>
          <pre>{{
            JSON.stringify(
              blocksForAgent({ [bundle.definition.id]: bundle })[
                bundle.definition.id
              ],
              null,
              2,
            )
          }}</pre>
        </details>
      </article>
      <p v-for="id in proposal.changes.remove" :key="id" class="warning">
        Remove block: {{ id }}
      </p></template
    >
    <template v-if="proposal.scope === 'capabilities'"
      ><article v-for="skill in proposal.capabilities.skills" :key="skill.id">
        <strong
          >{{ skill.name }} ·
          {{ skill.enabled ? "enabled" : "disabled" }}</strong
        >
        <pre>{{ skill.content }}</pre>
      </article>
      <article
        v-for="server in proposal.capabilities.mcpServers"
        :key="server.id"
      >
        <strong
          >{{ server.name }} ·
          {{ server.enabled ? "enabled" : "disabled" }}</strong
        >
        <pre>{{ JSON.stringify(server, null, 2) }}</pre>
      </article></template
    >
    <pre v-if="proposal.scope === 'execution'">{{
      JSON.stringify(proposal.settings, null, 2)
    }}</pre>
    <details>
      <summary>Full proposal JSON</summary>
      <pre>{{ JSON.stringify(proposal, null, 2) }}</pre>
    </details>
  </details>
</template>
