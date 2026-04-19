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
      query: "x",
    });

    expect(kindCalled).toBe(true);
    expect(hits).toHaveLength(1);
  });

  it("defaults activeOnly=false for searches when not explicitly provided", async () => {
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
      query: "x",
    });

    expect(observedActiveOnly).toBe(false);
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

describe("CognitionSearchService — trust-order ranking (Task 8)", () => {
  it("sorts assertion hits by verification then basis trust order", async () => {
    const searchRepo = makeSearchRepo({
      async searchByKind() {
        return [
          makeHit({
            source_ref: "assertion:1" as NodeRef,
            basis: "belief",
            stance: "accepted",
            updated_at: 300,
            cognitionKey: "k1",
          }),
          makeHit({
            source_ref: "assertion:2" as NodeRef,
            basis: "first_hand",
            stance: "accepted",
            updated_at: 100,
            cognitionKey: "k2",
          }),
          makeHit({
            source_ref: "assertion:3" as NodeRef,
            basis: "inference",
            stance: "accepted",
            updated_at: 200,
            cognitionKey: "k3",
          }),
        ];
      },
    });

    const projectionRepo = makeProjectionRepo({
      async getCurrent(_agentId: string, key: string) {
        const map: Record<string, { groundingVerificationLevel: string; provenance: string; basis: string }> = {
          k1: { groundingVerificationLevel: "unverified", provenance: "talker_sketch_auto", basis: "belief" },
          k2: { groundingVerificationLevel: "strong_verified", provenance: "user_stated", basis: "first_hand" },
          k3: { groundingVerificationLevel: "context_verified", provenance: "thinker_inferred", basis: "inference" },
        };
        const data = map[key];
        if (!data) return null;
        return {
          id: 1,
          agent_id: "agent-1",
          cognition_key: key,
          kind: "assertion",
          stance: "accepted",
          basis: data.basis,
          status: "active",
          pre_contested_stance: null,
          conflict_summary: null,
          conflict_factor_refs_json: null,
          summary_text: "",
          record_json: JSON.stringify({ provenance: data.provenance, groundingVerificationLevel: data.groundingVerificationLevel }),
          source_event_id: 1,
          updated_at: 100,
        };
      },
    });

    const service = new CognitionSearchService(searchRepo, makeRelationRepo(), projectionRepo);
    const hits = await service.searchCognition({
      agentId: "agent-1",
      kind: "assertion",
      query: "x",
    });

    expect(hits).toHaveLength(3);
    expect(hits[0].source_ref).toBe("assertion:2");
    expect(hits[0].groundingVerificationLevel).toBe("strong_verified");
    expect(hits[1].source_ref).toBe("assertion:3");
    expect(hits[1].groundingVerificationLevel).toBe("context_verified");
    expect(hits[2].source_ref).toBe("assertion:1");
    expect(hits[2].groundingVerificationLevel).toBe("unverified");
  });

  it("populates provenance and groundingVerificationLevel from record_json", async () => {
    const searchRepo = makeSearchRepo({
      async searchByKind() {
        return [
          makeHit({
            source_ref: "assertion:10" as NodeRef,
            basis: "belief",
            stance: "accepted",
            cognitionKey: "key-weak",
          }),
          makeHit({
            source_ref: "assertion:11" as NodeRef,
            basis: "first_hand",
            stance: "accepted",
            cognitionKey: "key-strong",
          }),
        ];
      },
    });

    const projectionRepo = makeProjectionRepo({
      async getCurrent(_agentId: string, key: string) {
        if (key === "key-weak") {
          return {
            id: 10,
            agent_id: "agent-1",
            cognition_key: "key-weak",
            kind: "assertion",
            stance: "accepted",
            basis: "belief",
            status: "active",
            pre_contested_stance: null,
            conflict_summary: null,
            conflict_factor_refs_json: null,
            summary_text: "weak claim",
            record_json: JSON.stringify({
              provenance: "talker_sketch_auto",
              groundingVerificationLevel: "unverified",
            }),
            source_event_id: 1,
            updated_at: 100,
          };
        }
        if (key === "key-strong") {
          return {
            id: 11,
            agent_id: "agent-1",
            cognition_key: "key-strong",
            kind: "assertion",
            stance: "accepted",
            basis: "first_hand",
            status: "active",
            pre_contested_stance: null,
            conflict_summary: null,
            conflict_factor_refs_json: null,
            summary_text: "strong claim",
            record_json: JSON.stringify({
              provenance: "user_stated",
              groundingVerificationLevel: "strong_verified",
            }),
            source_event_id: 2,
            updated_at: 200,
          };
        }
        return null;
      },
    });

    const service = new CognitionSearchService(searchRepo, makeRelationRepo(), projectionRepo);
    const hits = await service.searchCognition({
      agentId: "agent-1",
      kind: "assertion",
      query: "x",
    });

    const strong = hits.find((h) => h.cognitionKey === "key-strong");
    const weak = hits.find((h) => h.cognitionKey === "key-weak");

    expect(strong).toBeDefined();
    expect(strong!.provenance).toBe("user_stated");
    expect(strong!.groundingVerificationLevel).toBe("strong_verified");

    expect(weak).toBeDefined();
    expect(weak!.provenance).toBe("talker_sketch_auto");
    expect(weak!.groundingVerificationLevel).toBe("unverified");
  });

  it("enforces full trust ordering: verification first, then basis within bucket", async () => {
    const searchRepo = makeSearchRepo({
      async searchByKind() {
        return [
          makeHit({ source_ref: "assertion:sv-b" as NodeRef, cognitionKey: "sv-b", basis: "belief", updated_at: 10 }),
          makeHit({ source_ref: "assertion:sv-fh" as NodeRef, cognitionKey: "sv-fh", basis: "first_hand", updated_at: 11 }),
          makeHit({ source_ref: "assertion:cv-h" as NodeRef, cognitionKey: "cv-h", basis: "hearsay", updated_at: 12 }),
          makeHit({ source_ref: "assertion:cv-i" as NodeRef, cognitionKey: "cv-i", basis: "inference", updated_at: 13 }),
          makeHit({ source_ref: "assertion:uv-null" as NodeRef, cognitionKey: "uv-null", basis: null, updated_at: 14 }),
          makeHit({ source_ref: "assertion:uv-fh" as NodeRef, cognitionKey: "uv-fh", basis: "first_hand", updated_at: 15 }),
          makeHit({ source_ref: "assertion:cv-fh" as NodeRef, cognitionKey: "cv-fh", basis: "first_hand", updated_at: 16 }),
          makeHit({ source_ref: "assertion:sv-i" as NodeRef, cognitionKey: "sv-i", basis: "inference", updated_at: 17 }),
        ];
      },
    });

    const projectionRepo = makeProjectionRepo({
      async getCurrent(_agentId, key) {
        const map: Record<string, { verification: string; provenance: string; basis: string | null }> = {
          "sv-fh": { verification: "strong_verified", provenance: "user_stated", basis: "first_hand" },
          "sv-i": { verification: "strong_verified", provenance: "thinker_inferred", basis: "inference" },
          "sv-b": { verification: "strong_verified", provenance: "talker_sketch_explicit", basis: "belief" },
          "cv-fh": { verification: "context_verified", provenance: "user_stated", basis: "first_hand" },
          "cv-h": { verification: "context_verified", provenance: "legacy_unknown", basis: "hearsay" },
          "cv-i": { verification: "context_verified", provenance: "thinker_inferred", basis: "inference" },
          "uv-fh": { verification: "unverified", provenance: "user_stated", basis: "first_hand" },
          "uv-null": { verification: "unverified", provenance: "legacy_unknown", basis: null },
        };
        const data = map[key];
        if (!data) return null;
        return {
          id: 1,
          agent_id: "agent-1",
          cognition_key: key,
          kind: "assertion",
          stance: "accepted",
          basis: data.basis,
          status: "active",
          pre_contested_stance: null,
          conflict_summary: null,
          conflict_factor_refs_json: null,
          summary_text: "",
          record_json: JSON.stringify({
            provenance: data.provenance,
            groundingVerificationLevel: data.verification,
          }),
          source_event_id: 1,
          updated_at: 100,
        };
      },
    });

    const service = new CognitionSearchService(searchRepo, makeRelationRepo(), projectionRepo);
    const hits = await service.searchCognition({
      agentId: "agent-1",
      kind: "assertion",
      query: "x",
    });

    expect(hits.map((h) => h.cognitionKey)).toEqual([
      "sv-fh",
      "sv-i",
      "sv-b",
      "cv-fh",
      "cv-h",
      "cv-i",
      "uv-fh",
      "uv-null",
    ]);
  });

  it("excludes retracted assertions when activeOnly=true", async () => {
    const searchRepo = makeSearchRepo({
      async searchByKind(_agentId, _kind, options) {
        if (options.activeOnly) {
          return [
            makeHit({ source_ref: "assertion:active" as NodeRef, cognitionKey: "k-active", content: "active assertion" }),
          ];
        }
        return [
          makeHit({ source_ref: "assertion:active" as NodeRef, cognitionKey: "k-active", content: "active assertion" }),
          makeHit({ source_ref: "assertion:retracted" as NodeRef, cognitionKey: "k-retracted", content: "retracted assertion" }),
        ];
      },
    });

    const projectionRepo = makeProjectionRepo({
      async getCurrent(_agentId, key) {
        return {
          id: 1,
          agent_id: "agent-1",
          cognition_key: key,
          kind: "assertion",
          stance: "accepted",
          basis: "first_hand",
          status: key === "k-retracted" ? "retracted" : "active",
          pre_contested_stance: null,
          conflict_summary: null,
          conflict_factor_refs_json: null,
          summary_text: "",
          record_json: JSON.stringify({ provenance: "user_stated", groundingVerificationLevel: "strong_verified" }),
          source_event_id: 1,
          updated_at: 100,
        };
      },
    });

    const service = new CognitionSearchService(searchRepo, makeRelationRepo(), projectionRepo);
    const hits = await service.searchCognition({
      agentId: "agent-1",
      kind: "assertion",
      query: "x",
      activeOnly: true,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].content).toBe("active assertion");
  });

  it("ranks weak unverified belief below strong_verified first_hand in same query", async () => {
    const searchRepo = makeSearchRepo({
      async searchByKind() {
        return [
          makeHit({ source_ref: "assertion:weak" as NodeRef, cognitionKey: "weak-key", basis: "belief", content: "weak memory" }),
          makeHit({ source_ref: "assertion:strong" as NodeRef, cognitionKey: "strong-key", basis: "first_hand", content: "strong memory" }),
        ];
      },
    });

    const projectionRepo = makeProjectionRepo({
      async getCurrent(_agentId, key) {
        if (key === "strong-key") {
          return {
            id: 2,
            agent_id: "agent-1",
            cognition_key: key,
            kind: "assertion",
            stance: "accepted",
            basis: "first_hand",
            status: "active",
            pre_contested_stance: null,
            conflict_summary: null,
            conflict_factor_refs_json: null,
            summary_text: "",
            record_json: JSON.stringify({ provenance: "user_stated", groundingVerificationLevel: "strong_verified" }),
            source_event_id: 2,
            updated_at: 200,
          };
        }
        return {
          id: 1,
          agent_id: "agent-1",
          cognition_key: key,
          kind: "assertion",
          stance: "accepted",
          basis: "belief",
          status: "active",
          pre_contested_stance: null,
          conflict_summary: null,
          conflict_factor_refs_json: null,
          summary_text: "",
          record_json: JSON.stringify({ provenance: "talker_sketch_auto", groundingVerificationLevel: "unverified" }),
          source_event_id: 1,
          updated_at: 100,
        };
      },
    });

    const service = new CognitionSearchService(searchRepo, makeRelationRepo(), projectionRepo);
    const hits = await service.searchCognition({
      agentId: "agent-1",
      kind: "assertion",
      query: "x",
    });

    expect(hits).toHaveLength(2);
    expect(hits[0].cognitionKey).toBe("strong-key");
    expect(hits[1].cognitionKey).toBe("weak-key");
  });
});
