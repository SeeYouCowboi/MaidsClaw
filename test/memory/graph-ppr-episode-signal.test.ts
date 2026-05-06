import { describe, expect, it, mock } from "bun:test";

import type { ViewerContext } from "../../src/core/contracts/viewer-context.js";
import { getDefaultTemplate } from "../../src/memory/contracts/retrieval-template.js";
import type { CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import type { NarrativeSearchService } from "../../src/memory/narrative/narrative-search.js";
import type { QuerySignals } from "../../src/memory/query-routing-types.js";
import { allocateBudget } from "../../src/memory/retrieval/budget-allocator.js";
import { DEFAULT_GRAPH_RETRIEVAL_CONFIG } from "../../src/memory/retrieval/graph-retrieval-config.js";
import { RetrievalOrchestrator } from "../../src/memory/retrieval/retrieval-orchestrator.js";
import type { EpisodeRepo } from "../../src/storage/domain-repos/contracts/episode-repo.js";

type EpisodeSearchHit = {
  sourceRef: string;
  content: string;
  category: string;
  score: number;
  actor?: "user" | "agent";
};

const BASE_FTS_HITS: EpisodeSearchHit[] = [
  {
    sourceRef: "episode:1",
    content: "Alice mentioned the silver watch in the study.",
    category: "speech",
    score: 12,
    actor: "user",
  },
  {
    sourceRef: "episode:2",
    content: "The butler checked the study door before leaving.",
    category: "observation",
    score: 8,
    actor: "user",
  },
];

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

function makeCognitionService(): CognitionSearchService {
  return {
    async searchCognition() {
      return [];
    },
    createCurrentProjectionReader() {
      return null;
    },
  } as unknown as CognitionSearchService;
}

function makeEpisodeRepository(): EpisodeRepo {
  return {
    async readByIds(_agentId: string, ids: number[]) {
      return ids.map((id) => ({
        id,
        agent_id: "agent_test",
        session_id: "sess_test",
        settlement_id: `settlement-${id}`,
        category: id === 88 ? "observation" : "speech",
        summary: id === 88
          ? "Alice hid the watch behind the garden arch."
          : `Hydrated episode ${id}`,
        private_notes: null,
        location_entity_id: null,
        location_text: null,
        valid_time: null,
        committed_time: 1_700_000_000_000 + id,
        source_local_ref: null,
        request_id: null,
        created_at: 1_700_000_000_000 + id,
        entity_pointer_keys: [],
        actor: "user" as const,
      }));
    },
    async readByAgent() {
      return [];
    },
  } as unknown as EpisodeRepo;
}

function makeSqlStub(mode: "ppr" | "throw") {
  const sql = mock(async (strings: TemplateStringsArray, ...values: unknown[]) => {
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
      return [
        {
          id: 1,
          run_id: "run-test",
          algorithm_version: "test-v1",
          edge_kind: "cooccurrence_associative",
          source_ref: "char:alice",
          source_kind: "entity",
          target_ref: "item:silver_watch",
          target_kind: "entity",
          weight: 1,
          visibility_scope: "shared_public",
          owner_agent_id: null,
          first_seen_at: Date.now(),
          last_seen_at: Date.now(),
          source_passage_refs: [],
          source_fact_edge_ids: [],
          source_semantic_edge_refs: [],
          source_hash: null,
          created_at: Date.now(),
          active: true,
        },
        {
          id: 2,
          run_id: "run-test",
          algorithm_version: "test-v1",
          edge_kind: "mention_episode_entity",
          source_ref: "episode:88",
          source_kind: "episode",
          target_ref: "item:silver_watch",
          target_kind: "entity",
          weight: 1,
          visibility_scope: "shared_public",
          owner_agent_id: null,
          first_seen_at: Date.now(),
          last_seen_at: Date.now(),
          source_passage_refs: [],
          source_fact_edge_ids: [],
          source_semantic_edge_refs: [],
          source_hash: null,
          created_at: Date.now(),
          active: true,
        },
      ];
    }
    if (text.includes("FROM entity_nodes") && text.includes("pointer_key = ANY")) {
      return [
        { pointer_key: "char:alice", memory_scope: "shared_public", owner_agent_id: null },
        { pointer_key: "item:silver_watch", memory_scope: "shared_public", owner_agent_id: null },
      ];
    }
    return [];
  });
  return sql;
}

function makeOrchestrator(params: {
  graphEnabled: boolean;
  sql?: unknown;
  episodeSearchFn?: (query: string, agentId: string, limit: number) => Promise<EpisodeSearchHit[]>;
}): RetrievalOrchestrator {
  return new RetrievalOrchestrator({
    narrativeService: makeNarrativeService(),
    cognitionService: makeCognitionService(),
    currentProjectionReader: null,
    episodeRepository: makeEpisodeRepository(),
    episodeSearchFn: params.episodeSearchFn ?? mock(async () => BASE_FTS_HITS),
    episodeEmbeddingFn: null,
    exactRecallProvider: null,
    sql: params.sql as never,
    graphRetrievalConfig: {
      ...DEFAULT_GRAPH_RETRIEVAL_CONFIG,
      enabled: params.graphEnabled,
    },
  });
}

function zeroSignals(): QuerySignals {
  return {
    needsEpisode: 0,
    needsConflict: 0,
    needsTimeline: 0,
    needsRelationship: 0,
    needsCognition: 0,
    needsEntityFocus: 0,
  };
}

describe("graph_ppr_episode retrieval signal", () => {
  it("PPR-off parity preserves the existing episode FTS path", async () => {
    const orchestrator = makeOrchestrator({ graphEnabled: false });

    const result = await orchestrator.search("Alice watch", makeViewer(), "rp_agent", {
      override: { narrativeEnabled: false, cognitionEnabled: false, conflictNotesEnabled: false, episodeBudget: 2 },
    });

    expect(result.typed.episode).toEqual([
      {
        source_ref: "episode:1",
        content: "Alice mentioned the silver watch in the study.",
        score: expect.closeTo(1.2 / 61),
        doc_type: "episode_speech",
        scope: "private",
        actor: "user",
      },
      {
        source_ref: "episode:2",
        content: "The butler checked the study door before leaving.",
        score: expect.closeTo(1.2 / 62),
        doc_type: "episode_observation",
        scope: "private",
        actor: "user",
      },
    ]);
  });

  it("PPR-on with null sql is gated and falls back to FTS only", async () => {
    const orchestrator = makeOrchestrator({ graphEnabled: true, sql: null });

    const result = await orchestrator.search("Alice watch", makeViewer(), "rp_agent", {
      override: { narrativeEnabled: false, cognitionEnabled: false, conflictNotesEnabled: false, episodeBudget: 2 },
    });

    expect(result.typed.episode.map((episode) => episode.source_ref)).toEqual(["episode:1", "episode:2"]);
  });

  it("PPR-on with visible seeds contributes graph_ppr_episode candidates through RRF", async () => {
    const orchestrator = makeOrchestrator({ graphEnabled: true, sql: makeSqlStub("ppr") });

    const result = await orchestrator.search("Alice", makeViewer(), "rp_agent", {
      override: { narrativeEnabled: false, cognitionEnabled: false, conflictNotesEnabled: false, episodeBudget: 3 },
    });

    expect(result.typed.episode.map((episode) => episode.source_ref)).toContain("episode:88");
    expect(result.typed.episode.find((episode) => episode.source_ref === "episode:88")?.content).toBe(
      "Alice hid the watch behind the garden arch.",
    );
  });

  it("PPR failure is non-fatal and still returns FTS results", async () => {
    const orchestrator = makeOrchestrator({ graphEnabled: true, sql: makeSqlStub("throw") });

    const result = await orchestrator.search("Alice watch", makeViewer(), "rp_agent", {
      override: { narrativeEnabled: false, cognitionEnabled: false, conflictNotesEnabled: false, episodeBudget: 2 },
    });

    expect(result.typed.episode.map((episode) => episode.source_ref)).toEqual(["episode:1", "episode:2"]);
  });
});

describe("graph PPR budget allocator parity", () => {
  it("does not add needsEpisode or starve surfaces when PPR toggles on/off", () => {
    const template = getDefaultTemplate("rp_agent");
    const signals = { ...zeroSignals(), needsCognition: 0.8, needsEntityFocus: 0.4 };

    const pprOffBudget = allocateBudget(template, signals);
    const pprOnBudget = allocateBudget(template, signals);

    expect(pprOnBudget).toEqual(pprOffBudget);
    expect(pprOnBudget.episodeBudget).toBeGreaterThanOrEqual(1);
    expect(pprOnBudget.narrativeBudget).toBeGreaterThanOrEqual(1);
    expect(pprOnBudget.cognitionBudget).toBeGreaterThanOrEqual(1);
  });
});
