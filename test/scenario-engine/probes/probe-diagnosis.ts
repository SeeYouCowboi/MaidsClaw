import { SCENARIO_DEFAULT_AGENT_ID } from "../constants.js";
import type { ProbeDefinition } from "./probe-types.js";
import type { ScenarioInfra } from "../runner/infra.js";

export type DiagnosisResult = {
  fragment: string;
  layer: "L1" | "L2" | "L3" | "L4" | "UNKNOWN";
  diagnosis: string;
  detail?: string;
};

function includesFragment(content: string | null | undefined, fragment: string): boolean {
  if (!content) return false;
  return content.toLowerCase().includes(fragment.toLowerCase());
}

async function foundInPrivateLayers(
  infra: ScenarioInfra,
  fragment: string,
): Promise<boolean> {
  const pattern = `%${fragment}%`;

  const cognitionRows = await infra.sql<Array<{ content: string }>>`
    SELECT COALESCE(summary_text, record_json::text, cognition_key::text) AS content
    FROM private_cognition_current
    WHERE COALESCE(summary_text, record_json::text, cognition_key::text) ILIKE ${pattern}
    LIMIT 1
  `;

  if (cognitionRows.length > 0) {
    return true;
  }

  const episodeRows = await infra.sql<Array<{ content: string }>>`
    SELECT COALESCE(summary, private_notes, '') AS content
    FROM private_episode_events
    WHERE COALESCE(summary, private_notes, '') ILIKE ${pattern}
    LIMIT 1
  `;

  return episodeRows.length > 0;
}

async function foundInSearchDocs(
  infra: ScenarioInfra,
  fragment: string,
): Promise<boolean> {
  const pattern = `%${fragment}%`;

  const cognitionRows = await infra.sql<Array<{ content: string }>>`
    SELECT content
    FROM search_docs_cognition
    WHERE content ILIKE ${pattern}
    LIMIT 1
  `;

  if (cognitionRows.length > 0) {
    return true;
  }

  const worldRows = await infra.sql<Array<{ content: string }>>`
    SELECT content
    FROM search_docs_world
    WHERE content ILIKE ${pattern}
    LIMIT 1
  `;

  return worldRows.length > 0;
}

async function queryExpandedTopK(
  probe: ProbeDefinition,
  infra: ScenarioInfra,
  expandedTopK: number,
): Promise<Array<{ content: string }>> {
  const queryPattern = `%${probe.query}%`;

  if (probe.retrievalMethod === "narrative_search") {
    return infra.sql<Array<{ content: string }>>`
      SELECT content
      FROM search_docs_world
      WHERE lower(content) ILIKE lower(${queryPattern})
      ORDER BY created_at DESC
      LIMIT ${expandedTopK}
    `;
  }

  if (probe.retrievalMethod === "cognition_search") {
    return infra.sql<Array<{ content: string }>>`
      SELECT content
      FROM search_docs_cognition
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND lower(content) ILIKE lower(${queryPattern})
      ORDER BY updated_at DESC
      LIMIT ${expandedTopK}
    `;
  }

  return infra.sql<Array<{ content: string }>>`
    SELECT content
    FROM (
      SELECT content, created_at AS sort_at
      FROM search_docs_world
      WHERE lower(content) ILIKE lower(${queryPattern})

      UNION ALL

      SELECT content, updated_at AS sort_at
      FROM search_docs_cognition
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND lower(content) ILIKE lower(${queryPattern})
    ) AS combined_docs
    ORDER BY sort_at DESC
    LIMIT ${expandedTopK}
  `;
}

async function diagnoseFragment(
  probe: ProbeDefinition,
  fragment: string,
  infra: ScenarioInfra,
): Promise<DiagnosisResult> {
  const presentInPrivate = await foundInPrivateLayers(infra, fragment);
  if (!presentInPrivate) {
    return {
      fragment,
      layer: "L1",
      diagnosis: "EXTRACTION MISSING",
      detail: "not found in private_cognition_current or private_episode_events",
    };
  }

  const presentInSearchDocs = await foundInSearchDocs(infra, fragment);
  if (!presentInSearchDocs) {
    return {
      fragment,
      layer: "L2",
      diagnosis: "PROJECTION MISSING",
      detail: "found in private tables but not in search_docs",
    };
  }

  const expandedTopK = Math.max(probe.topK * 5, 100);
  const expandedHits = await queryExpandedTopK(probe, infra, expandedTopK);
  const rank = expandedHits.findIndex((row) => includesFragment(row.content, fragment)) + 1;

  if (rank > 0 && rank > probe.topK) {
    return {
      fragment,
      layer: "L4",
      diagnosis: "RANK OVERFLOW",
      detail: `found at rank #${rank} (topK=${probe.topK})`,
    };
  }

  if (rank === 0) {
    return {
      fragment,
      layer: "L3",
      diagnosis: "RETRIEVAL FAILURE",
      detail: "found in search_docs but query did not match",
    };
  }

  return {
    fragment,
    layer: "UNKNOWN",
    diagnosis: "CAUSE UNKNOWN",
  };
}

export async function diagnoseProbeFailure(
  probe: ProbeDefinition,
  missed: string[],
  infra: ScenarioInfra,
  writePath: "live" | "scripted" | "settlement",
): Promise<DiagnosisResult[]> {
  if (writePath === "settlement") {
    return [];
  }

  const diagnoses: DiagnosisResult[] = [];

  for (const fragment of missed) {
    const diagnosis = await diagnoseFragment(probe, fragment, infra);
    diagnoses.push(diagnosis);
  }

  return diagnoses;
}
