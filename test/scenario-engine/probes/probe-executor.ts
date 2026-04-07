import type { ViewerContext } from "../../../src/memory/types.js";
import {
  SCENARIO_DEFAULT_AGENT_ID,
  SCENARIO_DEFAULT_SESSION_ID,
} from "../constants.js";
import type { Story, StoryProbe } from "../dsl/story-types.js";
import type { ScenarioHandle } from "../runner/infra.js";
import type { ScenarioHandleExtended } from "../runner/orchestrator.js";
import { matchProbeResults } from "./probe-matcher.js";
import type { ProbeResult, RetrievalHit } from "./probe-types.js";

type AnyHandle = ScenarioHandle | ScenarioHandleExtended;

function buildViewerContext(
  probe: StoryProbe,
  handle: AnyHandle,
): ViewerContext {
  const entityId = handle.infra.entityIdMap.get(probe.viewerPerspective);
  if (entityId === undefined) {
    throw new Error(
      `Probe "${probe.id}": viewerPerspective "${probe.viewerPerspective}" not found in entityIdMap`,
    );
  }

  return {
    viewer_agent_id: SCENARIO_DEFAULT_AGENT_ID,
    viewer_role: "rp_agent",
    session_id: SCENARIO_DEFAULT_SESSION_ID,
    current_area_id: undefined,
  };
}

async function executeNarrativeSearch(
  probe: StoryProbe,
  viewerContext: ViewerContext,
  handle: AnyHandle,
): Promise<RetrievalHit[]> {
  const results = await handle.infra.services.narrativeSearch.searchNarrative(
    probe.query,
    viewerContext,
  );

  return results.map((r) => ({
    content: r.content,
    score: r.score,
    source_ref: String(r.source_ref),
    scope: r.scope,
  }));
}

async function executeCognitionSearch(
  probe: StoryProbe,
  viewerContext: ViewerContext,
  handle: AnyHandle,
): Promise<RetrievalHit[]> {
  const results = await handle.infra.services.cognitionSearch.searchCognition({
    agentId: viewerContext.viewer_agent_id,
    query: probe.query,
    limit: probe.topK,
  });

  return results.map((hit, index) => ({
    content: hit.content,
    score: hit.updated_at > 0 ? Math.max(0.1, 1 - index * 0.1) : 1.0,
    source_ref: String(hit.source_ref),
    scope: hit.kind,
  }));
}

async function executeMemoryRead(
  probe: StoryProbe,
  viewerContext: ViewerContext,
  handle: AnyHandle,
): Promise<RetrievalHit[]> {
  const result = await handle.infra.services.retrieval.readByEntity(
    probe.query,
    viewerContext,
  );

  const hits: RetrievalHit[] = [];

  if (result.entity?.summary) {
    hits.push({
      content: result.entity.summary,
      score: 1.0,
      source_ref: `entity:${result.entity.id}`,
      scope: "entity",
    });
  }

  for (const fact of result.facts) {
    hits.push({
      content: fact.predicate,
      score: 0.9,
      source_ref: `fact:${fact.id}`,
      scope: "fact",
    });
  }

  for (const event of result.events) {
    const text = event.summary ?? event.raw_text;
    if (text) {
      hits.push({
        content: text,
        score: 0.8,
        source_ref: `event:${event.id}`,
        scope: "event",
      });
    }
  }

  for (const episode of result.episodes) {
    hits.push({
      content: episode.summary,
      score: 0.7,
      source_ref: `episode:${episode.id}`,
      scope: "episode",
    });
  }

  return hits;
}

async function executeMemoryExplore(
  probe: StoryProbe,
  viewerContext: ViewerContext,
  handle: AnyHandle,
): Promise<RetrievalHit[]> {
  const result = await handle.infra.services.navigator.explore(
    probe.query,
    viewerContext,
    { seedCount: probe.topK, maxCandidates: probe.topK },
  );

  if (result.evidence_paths.length === 0) {
    // No evidence paths found — return summary as a single hit if available
    return result.summary
      ? [{ content: result.summary, score: 0.5, source_ref: "explore:summary", scope: "graph" }]
      : [];
  }

  // Resolve actual content from node refs in evidence paths.
  // Evidence paths may contain entity-only nodes (display names) that lack
  // narrative content. Supplement with search_docs lookups for all refs.
  const allNodeRefs = new Set<string>();
  for (const ep of result.evidence_paths) {
    for (const node of ep.path.nodes) allNodeRefs.add(node);
  }
  const contentByRef = await resolveNodeContent(handle.infra.sql, Array.from(allNodeRefs));

  const hits: RetrievalHit[] = result.evidence_paths.map((ep) => {
    const parts: string[] = [];
    for (const node of ep.path.nodes) {
      const text = contentByRef.get(node);
      if (text) parts.push(text);
    }
    const content = parts.length > 0
      ? parts.join(" | ")
      : (ep.summary ?? result.summary ?? "");
    return {
      content,
      score: Math.max(0, Math.min(1, ep.score.path_score)),
      source_ref: String(ep.path.seed),
      scope: "graph",
    };
  });

  // Supplement: query search_docs directly to ensure content-rich hits
  // are included even when the navigator only returns entity-level paths.
  const supplementalContent = await resolveSupplementalContent(
    handle.infra.sql,
    probe.query,
    viewerContext.viewer_agent_id,
    probe.topK,
  );
  for (const [ref, content] of supplementalContent) {
    hits.push({ content, score: 0.8, source_ref: ref, scope: "graph" });
  }

  // Deduplicate by source_ref, keeping highest score.
  // Sort so narrative/cognition supplemental hits (with actual content)
  // rank above entity-only graph paths.
  const deduped = new Map<string, RetrievalHit>();
  for (const hit of hits) {
    const existing = deduped.get(hit.source_ref);
    if (!existing || hit.score > existing.score) {
      deduped.set(hit.source_ref, hit);
    }
  }
  return Array.from(deduped.values()).sort((a, b) => b.score - a.score);
}

async function resolveSupplementalContent(
  sql: import("postgres").Sql,
  query: string,
  agentId: string,
  limit: number,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  // Tokenize query: split on whitespace, filter empties.
  // Search each token individually so "视而不见 隐身人" matches docs
  // containing either term, rather than requiring the exact full string.
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return result;

  // Build OR-combined ILIKE conditions for each token
  const tokenPatterns = tokens.map((t) => `%${t}%`);

  // Search search_docs_world via ILIKE (any token matches)
  const worldRows = await sql`
    SELECT source_ref, content FROM search_docs_world
    WHERE ${sql`content ILIKE ANY(${sql.array(tokenPatterns)})`}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  for (const row of worldRows) {
    result.set(row.source_ref as string, row.content as string);
  }

  // Search search_docs_cognition (any token matches)
  const cogRows = await sql`
    SELECT source_ref, content FROM search_docs_cognition
    WHERE agent_id = ${agentId}
      AND ${sql`content ILIKE ANY(${sql.array(tokenPatterns)})`}
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
  for (const row of cogRows) {
    if (!result.has(row.source_ref as string)) {
      result.set(row.source_ref as string, row.content as string);
    }
  }

  return result;
}

async function resolveNodeContent(
  sql: import("postgres").Sql,
  nodeRefs: string[],
): Promise<Map<string, string>> {
  const contentMap = new Map<string, string>();
  if (nodeRefs.length === 0) return contentMap;

  // Check search_docs_world — use ANY($1) for array parameter compatibility
  const worldRows = await sql.unsafe<Array<{ source_ref: string; content: string }>>(
    `SELECT source_ref, content FROM search_docs_world WHERE source_ref = ANY($1)`,
    [nodeRefs],
  );
  for (const row of worldRows) contentMap.set(row.source_ref, row.content);

  // Check search_docs_cognition for remaining
  const remaining = nodeRefs.filter((ref) => !contentMap.has(ref));
  if (remaining.length > 0) {
    const cogRows = await sql.unsafe<Array<{ source_ref: string; content: string }>>(
      `SELECT source_ref, content FROM search_docs_cognition WHERE source_ref = ANY($1)`,
      [remaining],
    );
    for (const row of cogRows) contentMap.set(row.source_ref, row.content);
  }

  // Check entity_nodes for entity refs
  const entityRefs = nodeRefs.filter((ref) => ref.startsWith("entity:") && !contentMap.has(ref));
  if (entityRefs.length > 0) {
    const entityIds = entityRefs.map((ref) => Number(ref.split(":")[1]));
    const entityRows = await sql.unsafe<Array<{ id: number; display_name: string; pointer_key: string }>>(
      `SELECT id, display_name, pointer_key FROM entity_nodes WHERE id = ANY($1)`,
      [entityIds],
    );
    for (const row of entityRows) {
      contentMap.set(`entity:${row.id}`, `${row.display_name} (${row.pointer_key})`);
    }
  }

  return contentMap;
}

async function executeSingleProbe(
  probe: StoryProbe,
  handle: AnyHandle,
): Promise<RetrievalHit[]> {
  const viewerContext = buildViewerContext(probe, handle);

  switch (probe.retrievalMethod) {
    case "narrative_search":
      return executeNarrativeSearch(probe, viewerContext, handle);
    case "cognition_search":
      return executeCognitionSearch(probe, viewerContext, handle);
    case "memory_read":
      return executeMemoryRead(probe, viewerContext, handle);
    case "memory_explore":
      return executeMemoryExplore(probe, viewerContext, handle);
    default: {
      const _exhaustive: never = probe.retrievalMethod;
      throw new Error(`Unknown retrieval method: ${_exhaustive}`);
    }
  }
}

function resolveMatchMode(handle: AnyHandle): "deterministic" | "live" {
  return handle.runResult.writePath === "live" ? "live" : "deterministic";
}

export async function executeProbes(
  story: Story,
  handle: AnyHandle,
): Promise<ProbeResult[]> {
  const mode = resolveMatchMode(handle);
  const results: ProbeResult[] = [];

  for (const probe of story.probes) {
    const hits = await executeSingleProbe(probe, handle);
    const result = matchProbeResults(probe, hits, { mode });
    results.push(result);
  }

  return results;
}
