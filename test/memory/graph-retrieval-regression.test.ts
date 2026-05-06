import { describe, expect, it, mock } from "bun:test";

import type { CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import type { NarrativeSearchService } from "../../src/memory/narrative/narrative-search.js";
import type { QueryPlan } from "../../src/memory/query-plan-types.js";
import type { QueryRoute, QuerySignals } from "../../src/memory/query-routing-types.js";
import { RetrievalOrchestrator } from "../../src/memory/retrieval/retrieval-orchestrator.js";
import type { MemoryHint, ViewerContext } from "../../src/memory/types.js";
import {
  applyWorldStateOpsForSettlement,
  type GraphStoreRepoForWorldStateOps,
} from "../../src/memory/world-state-ops-applier.js";
import type { WorldStateOp } from "../../src/runtime/rp-turn-contract.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

function makeViewer(): ViewerContext {
  return {
    viewer_agent_id: "agent-a",
    viewer_role: "rp_agent",
    can_read_admin_only: false,
    current_area_id: null,
    session_id: "sess-graph-regression",
  };
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

function makePlan(entityFilters: number[]): QueryPlan {
  const route: QueryRoute = {
    originalQuery: "Alice对我有什么承诺",
    normalizedQuery: "Alice对我有什么承诺",
    intents: [{ type: "why", confidence: 0.8, evidence: ["承诺"] }],
    primaryIntent: "why",
    routeConfidence: 0.8,
    resolvedEntityIds: entityFilters,
    entityHints: ["loc:flower_garden"],
    relationPairs: [],
    timeConstraint: null,
    timeSignals: [],
    locationHints: ["loc:flower_garden"],
    asksWhy: true,
    asksChange: false,
    asksComparison: false,
    signals: { ...zeroSignals(), needsCognition: 1, needsEntityFocus: 1 },
    rationale: "graph multi-hop should expand flower_garden to Alice",
    matchedRules: ["fixture:flower_garden_anchor"],
    classifierVersion: "regression-fixture-v1",
  };

  return {
    route,
    surfacePlans: {
      narrative: {
        baseQuery: route.normalizedQuery,
        rewrittenQuery: route.normalizedQuery,
        entityFilters,
        timeWindow: null,
        weight: 0.2,
        enabledByRole: true,
      },
      cognition: {
        baseQuery: route.normalizedQuery,
        rewrittenQuery: route.normalizedQuery,
        entityFilters,
        timeWindow: null,
        kind: "commitment",
        weight: 1,
        enabledByRole: true,
      },
      episode: {
        baseQuery: route.normalizedQuery,
        rewrittenQuery: route.normalizedQuery,
        entityFilters,
        timeWindow: null,
        weight: 0.2,
        enabledByRole: true,
      },
      conflictNotes: {
        baseQuery: route.normalizedQuery,
        rewrittenQuery: route.normalizedQuery,
        entityFilters,
        timeWindow: null,
        weight: 0,
        enabledByRole: true,
      },
    },
    graphPlan: {
      primaryIntent: "why",
      secondaryIntents: ["entity"],
      timeSlice: null,
      seedBias: {
        entity: 1,
        event: 0.3,
        episode: 0.4,
        assertion: 0.5,
        evaluation: 0.1,
        commitment: 1,
      },
      edgeBias: { entity_bridge: 1, participant: 0.8 },
    },
    builderVersion: "regression-fixture-v1",
    rationale: "cognition multi-hop baseline",
    matchedRules: ["fixture:flower_garden_anchor"],
  };
}

function makeNarrativeService(): NarrativeSearchService {
  return {
    async generateMemoryHints(): Promise<MemoryHint[]> {
      return [];
    },
    async searchNarrative(): Promise<MemoryHint[]> {
      return [];
    },
  } as unknown as NarrativeSearchService;
}

function makeCognitionService() {
  const searchCognition = mock(async (params: { entityIds?: number[] }) => {
    if (params.entityIds?.includes(101)) {
      return [
        {
          kind: "commitment",
          basis: null,
          stance: "accepted",
          cognitionKey: "alice/flower-commitment",
          source_ref: "commitment:9001",
          content: "Alice 承诺在花房见到我时不会否认那次会面。",
          updated_at: 1_700_000_000_000,
          provenance: "fixture",
          groundingVerificationLevel: "context_verified",
        },
      ];
    }
    return [];
  });

  return {
    service: {
      searchCognition,
      createCurrentProjectionReader() {
        return null;
      },
    } as unknown as CognitionSearchService,
    searchCognition,
  };
}

describe("graph retrieval regression baselines", () => {
  it("surfaces Alice-related commitment cognition via flower_garden multi-hop entity expansion", async () => {
    const cognition = makeCognitionService();
    const orchestrator = new RetrievalOrchestrator({
      narrativeService: makeNarrativeService(),
      cognitionService: cognition.service,
      currentProjectionReader: null,
      episodeRepository: null,
      episodeSearchFn: null,
    });

    const currentPreImplementationPlan = makePlan([88]);
    const requiredGraphExpandedPlan = makePlan([88, 101]);

    const required = await orchestrator.search(
      "Alice对我有什么承诺",
      makeViewer(),
      "rp_agent",
      { queryPlan: requiredGraphExpandedPlan },
    );
    expect(required.typed.cognition.map((hit) => hit.source_ref)).toContain(
      "commitment:9001",
    );

    const current = await orchestrator.search(
      "Alice对我有什么承诺",
      makeViewer(),
      "rp_agent",
      { queryPlan: currentPreImplementationPlan },
    );
    expect(current.typed.cognition.map((hit) => hit.source_ref)).toContain(
      "commitment:9001",
    );
  });

  it("rejects invalid fact predicates before fact_edges insert", async () => {
    const op: WorldStateOp = {
      subject: { kind: "pointer_key", value: "char:alice" },
      predicate: "likes_unknown_free_text",
      object: { kind: "pointer_key", value: "item:tea" },
      factText: "Alice likes an uncontrolled free-text object.",
      visibility: "shared_public",
    };
    const graphStoreRepo = {
      resolveEntityByPointerKey: mock(async (pointerKey: string) => {
        if (pointerKey === "char:alice") return 101;
        if (pointerKey === "item:tea") return 202;
        return null;
      }),
      createWorldStateFactEdge: mock(async () => ({ id: 1, created: true })),
      upsertEntity: mock(async () => 999),
    } as GraphStoreRepoForWorldStateOps & {
      createWorldStateFactEdge: ReturnType<typeof mock>;
    };

    const result = await applyWorldStateOpsForSettlement({
      settlementId: "settlement-invalid-predicate",
      sessionId: "sess-invalid-predicate",
      agentId: "agent-a",
      worldStateOps: [op],
      graphStoreRepo,
      unresolvedOpsRepo: { enqueueOp: mock(async () => undefined) },
    });

    expect(result.failedOps + result.skippedOps).toBe(1);
    expect(result.writtenOps).toBe(0);
    expect(graphStoreRepo.createWorldStateFactEdge).toHaveBeenCalledTimes(0);
  });
});

if (skipPgTests) {
  describe("graph retrieval rebuild idempotency (PG)", () => {
    it.skip("skips without PG_TEST_URL/JOBS_PG_URL/PG_APP_URL/PG_APP_TEST_URL", () => {});
  });
} else {
  describe("graph retrieval rebuild idempotency (PG)", () => {
    it("rebuilding derived retrieval graph twice does not duplicate active edges", async () => {
      await ensureTestPgAppDb();
      const pool = createTestPgAppPool();
      try {
        await withTestAppSchema(pool, async (sql) => {
          await bootstrapDerivedSchema(sql, { skipVector: true });

          const beforeTableRows = await sql`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_name = 'graph_retrieval_edges'
          `;
          expect(beforeTableRows.length).toBe(1);

          await sql`SELECT rebuild_graph_retrieval_edges()`;
          await sql`SELECT rebuild_graph_retrieval_edges()`;

          const duplicateRows = await sql`
            SELECT source_ref, target_ref, edge_kind, owner_agent_id, COUNT(*) AS cnt
            FROM graph_retrieval_edges
            WHERE active = TRUE
            GROUP BY source_ref, target_ref, edge_kind, owner_agent_id
            HAVING COUNT(*) > 1
          `;
          expect(duplicateRows).toHaveLength(0);
        });
      } finally {
        await teardownAppPool(pool);
      }
    });
  });
}
