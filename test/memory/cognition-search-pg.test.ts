import { describe, expect, it } from "bun:test";
import {
  CognitionSearchService,
  CurrentProjectionReader,
  type CognitionHit,
} from "../../src/memory/cognition/cognition-search.js";
import type { CognitionCurrentRow } from "../../src/memory/cognition/private-cognition-current.js";
import type { RelationReadRepo } from "../../src/storage/domain-repos/contracts/relation-read-repo.js";
import type { CognitionSearchRepo } from "../../src/storage/domain-repos/contracts/cognition-search-repo.js";
import type { CognitionProjectionRepo } from "../../src/storage/domain-repos/contracts/cognition-projection-repo.js";
import type { NodeRef } from "../../src/memory/types.js";

function makeHit(overrides: Partial<CognitionHit> = {}): CognitionHit {
  return {
    kind: "assertion",
    basis: "first_hand",
    stance: "accepted",
    cognitionKey: null,
    source_ref: "assertion:1" as NodeRef,
    content: "sample",
    updated_at: 100,
    ...overrides,
  };
}

function makeSearchRepo(overrides: Partial<CognitionSearchRepo> = {}): CognitionSearchRepo {
  return {
    async searchBySimilarity() {
      return [];
    },
    async searchByKind() {
      return [];
    },
    async filterActiveCommitments(items: CognitionHit[]) {
      return items;
    },
    async sortCommitments(items: CognitionHit[]) {
      return items;
    },
    async getActiveCurrent() {
      return [];
    },
    async resolveCognitionKey() {
      return null;
    },
    ...overrides,
  };
}

function makeRelationRepo(overrides: Partial<RelationReadRepo> = {}): RelationReadRepo {
  return {
    async getConflictEvidence() {
      return [];
    },
    async getConflictHistory() {
      return [];
    },
    async resolveSourceAgentId() {
      return null;
    },
    async resolveCanonicalCognitionRefByKey() {
      return null;
    },
    ...overrides,
  };
}

function makeProjectionRepo(overrides: Partial<CognitionProjectionRepo> = {}): CognitionProjectionRepo {
  return {
    async upsertFromEvent() {
      return;
    },
    async rebuild() {
      return;
    },
    async getCurrent() {
      return null;
    },
    async getAllCurrent() {
      return [];
    },
    ...overrides,
  };
}

describe("CognitionSearchService (PG repos)", () => {
  it("uses similarity search for long query and enriches contested hits", async () => {
    let usedSimilarity = false;
    let resolveCalls = 0;
    const searchRepo = makeSearchRepo({
      async searchBySimilarity() {
        usedSimilarity = true;
        return [
          makeHit({
            source_ref: "assertion:7" as NodeRef,
            stance: "contested",
            cognitionKey: null,
            content: "contested claim",
          }),
        ];
      },
      async resolveCognitionKey() {
        resolveCalls += 1;
        return "ck:7";
      },
    });

    const relationRepo = makeRelationRepo({
      async getConflictEvidence() {
        return [
          {
            targetRef: "assertion:9",
            strength: 0.8,
            sourceKind: "agent_op",
            sourceRef: "settlement:1",
            createdAt: 100,
          },
        ];
      },
      async getConflictHistory() {
        return [
          {
            relation_type: "resolved_by",
            source_node_ref: "assertion:7",
            target_node_ref: "assertion:42",
            created_at: 111,
          },
        ];
      },
    });

    const projectionRepo = makeProjectionRepo({
      async getCurrent() {
        return {
          id: 7,
          agent_id: "agent-1",
          cognition_key: "ck:7",
          kind: "assertion",
          stance: "contested",
          basis: "first_hand",
          status: "active",
          pre_contested_stance: "accepted",
          conflict_summary: "projection summary",
          conflict_factor_refs_json: JSON.stringify(["assertion:9"]),
          summary_text: "",
          record_json: "{}",
          source_event_id: 1,
          updated_at: 100,
        };
      },
    });

    const service = new CognitionSearchService(searchRepo, relationRepo, projectionRepo);
    const hits = await service.searchCognition({
      agentId: "agent-1",
      query: "contested claim details",
      limit: 5,
    });

    expect(usedSimilarity).toBe(true);
    expect(resolveCalls).toBe(1);
    expect(hits).toHaveLength(1);
    expect(hits[0].cognitionKey).toBe("ck:7");
    expect(hits[0].conflictSummary).toBe("projection summary");
    expect(hits[0].conflictFactorRefs).toEqual(["assertion:9"]);
    expect(hits[0].resolution).toEqual({ type: "resolved_by", by_node_ref: "assertion:42" });
  });

  it("uses kind search when query is too short", async () => {
    let kindCalled = false;
    const searchRepo = makeSearchRepo({
      async searchBySimilarity() {
        throw new Error("should not use similarity for short query");
      },
      async searchByKind() {
        kindCalled = true;
        return [makeHit({ source_ref: "assertion:2" as NodeRef })];
      },
    });

    const service = new CognitionSearchService(searchRepo, makeRelationRepo(), makeProjectionRepo());
    const hits = await service.searchCognition({
      agentId: "agent-1",
      kind: "assertion",
      query: "hi",
    });

    expect(kindCalled).toBe(true);
    expect(hits).toHaveLength(1);
  });

  it("defaults activeOnly=true for commitment searches", async () => {
    let observedActiveOnly: boolean | undefined;
    const searchRepo = makeSearchRepo({
      async searchByKind(_agentId, _kind, options) {
        observedActiveOnly = options.activeOnly;
        return [makeHit({ kind: "commitment", source_ref: "commitment:3" as NodeRef })];
      },
    });

    const service = new CognitionSearchService(searchRepo, makeRelationRepo(), makeProjectionRepo());
    await service.searchCognition({
      agentId: "agent-1",
      kind: "commitment",
      query: "no",
    });

    expect(observedActiveOnly).toBe(true);
  });
});

describe("CurrentProjectionReader (async)", () => {
  const rows: CognitionCurrentRow[] = [
    {
      id: 10,
      agent_id: "agent-1",
      cognition_key: "k-assert",
      kind: "assertion",
      stance: "accepted",
      basis: "first_hand",
      status: "active",
      pre_contested_stance: null,
      conflict_summary: null,
      conflict_factor_refs_json: null,
      summary_text: "A",
      record_json: "{}",
      source_event_id: 1,
      updated_at: 10,
    },
    {
      id: 20,
      agent_id: "agent-1",
      cognition_key: "k-commit",
      kind: "commitment",
      stance: null,
      basis: null,
      status: "retracted",
      pre_contested_stance: null,
      conflict_summary: null,
      conflict_factor_refs_json: null,
      summary_text: "B",
      record_json: "{}",
      source_event_id: 2,
      updated_at: 20,
    },
  ];

  it("exposes async current-reader methods", async () => {
    const projectionRepo = makeProjectionRepo({
      async getCurrent() {
        return rows[0];
      },
      async getAllCurrent() {
        return rows;
      },
    });

    const reader = new CurrentProjectionReader(projectionRepo);
    const current = await reader.getCurrent("agent-1", "k-assert");
    const all = await reader.getAllCurrent("agent-1");
    const byKind = await reader.getAllCurrentByKind("agent-1", "assertion");
    const active = await reader.getActiveCurrent("agent-1");

    expect(current?.id).toBe(10);
    expect(all).toHaveLength(2);
    expect(byKind).toHaveLength(1);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(10);
  });
});
