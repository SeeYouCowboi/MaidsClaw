import type { ViewerContext } from "../../../src/memory/types.js";
import { SCENARIO_DEFAULT_SESSION_ID } from "../constants.js";
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
    viewer_agent_id: String(entityId),
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
  // memory_read uses narrative search as a read-oriented query.
  // The query typically targets a specific entity or topic, so
  // the narrative search surface doubles as a read path.
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
    return result.summary
      ? [{ content: result.summary, score: 0.5, source_ref: "explore:summary", scope: "graph" }]
      : [];
  }

  return result.evidence_paths.map((ep) => ({
    content: ep.summary ?? result.summary ?? "",
    score: Math.max(0, Math.min(1, ep.score.path_score)),
    source_ref: String(ep.path.seed),
    scope: "graph",
  }));
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
