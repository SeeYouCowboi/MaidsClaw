import { SCENARIO_DEFAULT_AGENT_ID } from "../constants.js";
import type { ReasoningChainProbe } from "../dsl/story-types.js";
import type { ScenarioInfra } from "../runner/infra.js";
import type { ReasoningChainResult } from "./scenario-assertion-types.js";

async function resolveEpisodeIdByRef(
  infra: ScenarioInfra,
  episodeRef: string,
): Promise<number | null> {
  const byLocalRef = await infra.sql<{ id: number | string }[]>`
    SELECT id
    FROM private_episode_events
    WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
      AND source_local_ref = ${episodeRef}
    ORDER BY id DESC
    LIMIT 1
  `;

  if (byLocalRef.length > 0) {
    return Number(byLocalRef[0].id);
  }

  const bySummary = await infra.sql<{ id: number | string }[]>`
    SELECT id
    FROM private_episode_events
    WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
      AND summary = ${episodeRef}
    ORDER BY id DESC
    LIMIT 1
  `;

  if (bySummary.length > 0) {
    return Number(bySummary[0].id);
  }

  return null;
}

async function verifyExpectedEdge(
  infra: ScenarioInfra,
  edge: NonNullable<ReasoningChainProbe["expectedEdges"]>[number],
): Promise<{ fromRef: string; toRef: string; found: boolean }> {
  const fromId = await resolveEpisodeIdByRef(infra, edge.fromEpisodeLocalRef);
  const toId = await resolveEpisodeIdByRef(infra, edge.toEpisodeLocalRef);

  if (fromId == null || toId == null) {
    return {
      fromRef: edge.fromEpisodeLocalRef,
      toRef: edge.toEpisodeLocalRef,
      found: false,
    };
  }

  const rows = await infra.sql<{ id: number | string }[]>`
    SELECT id
    FROM logic_edges
    WHERE source_event_id = ${fromId}
      AND target_event_id = ${toId}
      AND relation_type = ${edge.edgeType}
    LIMIT 1
  `;

  return {
    fromRef: edge.fromEpisodeLocalRef,
    toRef: edge.toEpisodeLocalRef,
    found: rows.length > 0,
  };
}

export async function verifyReasoningChains(
  probes: ReasoningChainProbe[],
  infra: ScenarioInfra,
): Promise<ReasoningChainResult[]> {
  if (probes.length === 0) {
    return [];
  }

  return Promise.all(
    probes.map(async (probe): Promise<ReasoningChainResult> => {
      const cognitionResults = await Promise.all(
        probe.expectedCognitions.map(async (expected) => {
          const current = await infra.repos.cognition.getCurrent(
            SCENARIO_DEFAULT_AGENT_ID,
            expected.cognitionKey,
          );
          const found = current !== null;
          const actualStance = current?.stance ?? undefined;
          const stanceMatch = found && actualStance === expected.expectedStance;

          return {
            cognitionKey: expected.cognitionKey,
            found,
            stanceMatch,
            actualStance,
          };
        }),
      );

      const passed = cognitionResults.every((r) => r.found && r.stanceMatch);

      let edgeResults: ReasoningChainResult["edgeResults"];
      if (probe.expectEdges === true && Array.isArray(probe.expectedEdges)) {
        edgeResults = await Promise.all(
          probe.expectedEdges.map((edge) => verifyExpectedEdge(infra, edge)),
        );
      }

      return {
        kind: "reasoning_chain",
        probeId: probe.id,
        passed,
        cognitionResults,
        edgeResults,
      };
    }),
  );
}
