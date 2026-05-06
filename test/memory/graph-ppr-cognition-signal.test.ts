import { describe, expect, it, mock } from "bun:test";

import type { ViewerContext } from "../../src/core/contracts/viewer-context.js";
import type { CognitionHit, CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import type { NarrativeSearchService } from "../../src/memory/narrative/narrative-search.js";
import { DEFAULT_GRAPH_RETRIEVAL_CONFIG } from "../../src/memory/retrieval/graph-retrieval-config.js";
import { RetrievalOrchestrator } from "../../src/memory/retrieval/retrieval-orchestrator.js";
import type { NodeRef } from "../../src/memory/types.js";
import type { EpisodeRepo } from "../../src/storage/domain-repos/contracts/episode-repo.js";

type GraphSqlMode = "ppr" | "tie" | "throw";

function makeViewer(): ViewerContext {
  return {
    viewer_agent_id: "agent_test",
    viewer_role: "rp_agent",
    can_read_admin_only: false,
    current_area_id: 100,
    session_id: "sess_test",
  };
}

function makeNarrativeService(): NarrativeSearchService {
  return {
    async generateMemoryHints() {
      return [];
    },
    async searchNarrative() {
      return [];
    },
  } as unknown as NarrativeSearchService;
}

function makeCognitionHit(sourceRef: string, content: string, updatedAt: number): CognitionHit {
  return {
    kind: "assertion",
    basis: "first_hand",
    stance: "confirmed",
    cognitionKey: sourceRef.replace("cognition_key:", ""),
    source_ref: sourceRef as NodeRef,
    content,
    updated_at: updatedAt,
    provenance: "test",
    groundingVerificationLevel: "strong_verified",
  };
}

function makeCognitionService(hits: CognitionHit[]): CognitionSearchService {
  return {
    async searchCognition() {
      return hits;
    },
    createCurrentProjectionReader() {
      return null;
    },
  } as unknown as CognitionSearchService;
}

function makeEpisodeRepository(): EpisodeRepo {
  return {
    async readByIds() {
      return [];
    },
    async readByAgent() {
      return [];
    },
  } as unknown as EpisodeRepo;
}

function makeGraphEdge(params: {
  id: number;
  edgeKind: string;
  sourceRef: string;
  sourceKind: string;
  targetRef: string;
  targetKind: string;
  weight: number;
}) {
  const now = Date.now();
  return {
    id: params.id,
    run_id: "run-test",
    algorithm_version: "test-v1",
    edge_kind: params.edgeKind,
    source_ref: params.sourceRef,
    source_kind: params.sourceKind,
    target_ref: params.targetRef,
    target_kind: params.targetKind,
    weight: params.weight,
    visibility_scope: "shared_public",
    owner_agent_id: null,
    first_seen_at: now,
    last_seen_at: now,
    source_passage_refs: [],
    source_fact_edge_ids: [],
    source_semantic_edge_refs: [],
    source_hash: null,
    created_at: now,
    active: true,
  };
}

function makeSqlStub(mode: GraphSqlMode) {
  return mock(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (mode === "throw") {
      throw new Error("stub graph failure");
    }

    const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
    if (text.includes("FROM entity_aliases")) {
      return [];
    }
    if (text.includes("FROM entity_nodes") && text.includes("WHERE (pointer_key")) {
      const lookup = values[0];
      if (lookup === "Alice" || lookup === "char:alice") {
        return [{ pointer_key: "char:alice" }];
      }
      return [];
    }
    if (text.includes("EXISTS (SELECT 1 FROM node_embeddings")) {
      return [{ has_rows: false }];
    }
    if (text.includes("FROM graph_retrieval_edges")) {
      const watchEdgeWeight = mode === "tie" ? 1 : 3;
      const cognition2Weight = mode === "tie" ? 1 : 3;
      return [
        makeGraphEdge({
          id: 1,
          edgeKind: "cooccurrence_associative",
          sourceRef: "char:alice",
          sourceKind: "entity",
          targetRef: "item:silver_watch",
          targetKind: "entity",
          weight: watchEdgeWeight,
        }),
        makeGraphEdge({
          id: 2,
          edgeKind: "cooccurrence_associative",
          sourceRef: "char:alice",
          sourceKind: "entity",
          targetRef: "loc:garden",
          targetKind: "entity",
          weight: 1,
        }),
        makeGraphEdge({
          id: 3,
          edgeKind: "mention_cognition_entity",
          sourceRef: "cognition_key:older",
          sourceKind: "cognition",
          targetRef: "loc:garden",
          targetKind: "entity",
          weight: 1,
        }),
        makeGraphEdge({
          id: 4,
          edgeKind: "mention_cognition_entity",
          sourceRef: "cognition_key:newer",
          sourceKind: "cognition",
          targetRef: "item:silver_watch",
          targetKind: "entity",
          weight: cognition2Weight,
        }),
      ];
    }
    if (text.includes("FROM entity_nodes") && text.includes("pointer_key = ANY")) {
      return [
        { pointer_key: "char:alice", memory_scope: "shared_public", owner_agent_id: null },
        { pointer_key: "item:silver_watch", memory_scope: "shared_public", owner_agent_id: null },
        { pointer_key: "loc:garden", memory_scope: "shared_public", owner_agent_id: null },
      ];
    }
    return [];
  });
}

function makeOrchestrator(params: {
  graphEnabled: boolean;
  hits: CognitionHit[];
  sql?: unknown;
}): RetrievalOrchestrator {
  return new RetrievalOrchestrator({
    narrativeService: makeNarrativeService(),
    cognitionService: makeCognitionService(params.hits),
    currentProjectionReader: null,
    episodeRepository: makeEpisodeRepository(),
    episodeSearchFn: mock(async () => []),
    episodeEmbeddingFn: null,
    exactRecallProvider: null,
    sql: params.sql as never,
    graphRetrievalConfig: {
      ...DEFAULT_GRAPH_RETRIEVAL_CONFIG,
      enabled: params.graphEnabled,
    },
  });
}

describe("graph_ppr_cognition retrieval signal", () => {
  it("PPR-off parity preserves cognition updated_at order", async () => {
    const hits = [
      makeCognitionHit("cognition_key:newer", "Newer belief about the watch.", 300),
      makeCognitionHit("cognition_key:older", "Older belief about the garden.", 100),
    ];
    const orchestrator = makeOrchestrator({ graphEnabled: false, hits });

    const result = await orchestrator.search("Alice", makeViewer(), "rp_agent", {
      override: { narrativeEnabled: false, conflictNotesEnabled: false, episodeBudget: 0, cognitionBudget: 2 },
    });

    expect(result.typed.cognition.map((hit) => hit.source_ref)).toEqual([
      "cognition_key:newer",
      "cognition_key:older",
    ]);
  });

  it("PPR-on re-ranks cognition hits by graph cognition score", async () => {
    const hits = [
      makeCognitionHit("cognition_key:older", "Older belief about the garden.", 100),
      makeCognitionHit("cognition_key:newer", "Newer belief about the watch.", 300),
    ];
    const orchestrator = makeOrchestrator({ graphEnabled: true, hits, sql: makeSqlStub("ppr") });

    const result = await orchestrator.search("Alice", makeViewer(), "rp_agent", {
      override: { narrativeEnabled: false, conflictNotesEnabled: false, episodeBudget: 0, cognitionBudget: 2 },
    });

    expect(result.typed.cognition.map((hit) => hit.source_ref)).toEqual([
      "cognition_key:newer",
      "cognition_key:older",
    ]);
  });

  it("PPR failure is non-fatal for cognition order", async () => {
    const hits = [
      makeCognitionHit("cognition_key:newer", "Newer belief about the watch.", 300),
      makeCognitionHit("cognition_key:older", "Older belief about the garden.", 100),
    ];
    const orchestrator = makeOrchestrator({ graphEnabled: true, hits, sql: makeSqlStub("throw") });

    const result = await orchestrator.search("Alice", makeViewer(), "rp_agent", {
      override: { narrativeEnabled: false, conflictNotesEnabled: false, episodeBudget: 0, cognitionBudget: 2 },
    });

    expect(result.typed.cognition.map((hit) => hit.source_ref)).toEqual([
      "cognition_key:newer",
      "cognition_key:older",
    ]);
  });

  it("preserves updated_at descending as equal-PPR tie-breaker", async () => {
    const hits = [
      makeCognitionHit("cognition_key:older", "Older belief about the garden.", 100),
      makeCognitionHit("cognition_key:newer", "Newer belief about the watch.", 300),
    ];
    const orchestrator = makeOrchestrator({ graphEnabled: true, hits, sql: makeSqlStub("tie") });

    const result = await orchestrator.search("Alice", makeViewer(), "rp_agent", {
      override: { narrativeEnabled: false, conflictNotesEnabled: false, episodeBudget: 0, cognitionBudget: 2 },
    });

    expect(result.typed.cognition.map((hit) => hit.source_ref)).toEqual([
      "cognition_key:newer",
      "cognition_key:older",
    ]);
  });
});
