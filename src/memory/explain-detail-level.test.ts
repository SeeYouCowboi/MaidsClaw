import { describe, expect, it } from "bun:test";
import { GraphNavigator, type NarrativeSearchServiceLike, type CognitionSearchServiceLike } from "./navigator";
import type { GraphReadQueryRepo, GraphNodeVisibilityRecord, GraphNodeSnapshot } from "../storage/domain-repos/contracts/graph-read-query-repo";
import type { ViewerContext, NodeRef, SeedCandidate, MemoryExploreInput } from "./types";
import type { RetrievalService } from "./retrieval";
import type { AliasService } from "./alias";

function makeNodeRef(kind: string, id: number): NodeRef {
  return `${kind}:${id}` as NodeRef;
}

function makeViewer(overrides?: Partial<ViewerContext>): ViewerContext {
  return {
    viewer_agent_id: "agent-1",
    viewer_role: "rp_agent",
    can_read_admin_only: false,
    current_area_id: 100,
    session_id: "sess-1",
    ...overrides,
  };
}

function makeStubReadRepo(): GraphReadQueryRepo {
  return {
    async getNodeSalience() { return []; },
    async readLogicEdges() { return []; },
    async readMemoryRelationEdges() { return []; },
    async readSemanticEdges() { return []; },
    async readStateFactEdges() { return []; },
    async readEventParticipantContexts() { return []; },
    async readActiveFactsForEntityFrontier() { return []; },
    async readVisibleEventsForEntityFrontier() { return []; },
    async readAgentAssertionsLinkedToEntities() { return []; },
    async readAgentAssertionDetails() { return []; },
    async resolveEntityRefByPointerKey() { return null; },
    async getNodeSnapshots(refs) {
      return refs.map((ref) => ({
        nodeRef: ref,
        kind: "event" as const,
        summary: `Summary for ${ref}`,
        timestamp: Date.now() - 3600_000,
      }));
    },
    async getNodeVisibility(refs): Promise<GraphNodeVisibilityRecord[]> {
      return refs.map((ref) => ({
        nodeRef: ref,
        kind: "event" as const,
        visibilityScope: "world_public" as const,
        locationEntityId: 100,
        ownerAgentId: null,
      }));
    },
    async getPrivateNodeOwners() { return []; },
    async listRelationTypesForFrontier() { return []; },
  };
}

function makeStubRetrieval(seeds: SeedCandidate[]) {
  return {
    async localizeSeedsHybrid(): Promise<SeedCandidate[]> {
      return seeds;
    },
  };
}

function makeStubAlias() {
  return {
    resolveAlias(): number | null { return null; },
    resolveAliases(): Map<string, number | null> { return new Map(); },
    resolveRef(): NodeRef | null { return null; },
  };
}

describe("ExplainDetailLevel differentiation", () => {
  const eventRef1 = makeNodeRef("event", 1);
  const eventRef2 = makeNodeRef("event", 2);
  const seeds: SeedCandidate[] = [
    {
      node_ref: eventRef1,
      node_kind: "event",
      lexical_score: 0.9,
      semantic_score: 0.8,
      fused_score: 0.85,
      source_scope: "world",
    },
    {
      node_ref: eventRef2,
      node_kind: "event",
      lexical_score: 0.7,
      semantic_score: 0.6,
      fused_score: 0.65,
      source_scope: "private",
    },
  ];

  function makeNavigator() {
    const readRepo = makeStubReadRepo();
    const retrieval = makeStubRetrieval(seeds);
    const alias = makeStubAlias();
    return new GraphNavigator(
      readRepo as unknown as GraphReadQueryRepo,
      retrieval as unknown as RetrievalService,
      alias as unknown as AliasService,
    );
  }

  it("standard level does NOT include provenance on evidence paths", async () => {
    const nav = makeNavigator();
    const viewer = makeViewer();
    const input: MemoryExploreInput = { query: "test query", detailLevel: "standard" };

    const result = await nav.explore("test query", viewer, input);

    for (const ep of result.evidence_paths) {
      expect(ep.provenance).toBeUndefined();
    }
    expect(result.audit_summary).toBeUndefined();
  });

  it("audit level attaches provenance to every evidence path", async () => {
    const nav = makeNavigator();
    const viewer = makeViewer();
    const input: MemoryExploreInput = { query: "test query", detailLevel: "audit" };

    const result = await nav.explore("test query", viewer, input);

    expect(result.evidence_paths.length).toBeGreaterThan(0);
    for (const ep of result.evidence_paths) {
      expect(ep.provenance).toBeDefined();
      expect(typeof ep.provenance!.source_surface).toBe("string");
      expect(ep.provenance!.source_surface.length).toBeGreaterThan(0);
      expect(typeof ep.provenance!.confidence_score).toBe("number");
      expect(ep.provenance!.confidence_score).toBeGreaterThanOrEqual(0);
      expect(ep.provenance!.confidence_score).toBeLessThanOrEqual(1);
      expect(Array.isArray(ep.provenance!.conflict_refs)).toBe(true);
      expect(Array.isArray(ep.provenance!.edge_layers)).toBe(true);
      expect(ep.provenance!.committed_time === null || typeof ep.provenance!.committed_time === "number").toBe(true);
    }
  });

  it("audit level includes audit_summary on the result", async () => {
    const nav = makeNavigator();
    const viewer = makeViewer();
    const input: MemoryExploreInput = { query: "test query", detailLevel: "audit" };

    const result = await nav.explore("test query", viewer, input);

    expect(result.audit_summary).toBeDefined();
    expect(result.audit_summary!.total_paths).toBe(result.evidence_paths.length);
    expect(Array.isArray(result.audit_summary!.surfaces_used)).toBe(true);
    expect(result.audit_summary!.surfaces_used.length).toBeGreaterThan(0);
    expect(typeof result.audit_summary!.conflict_count).toBe("number");
  });

  it("audit result has strictly more data than standard (superset contract)", async () => {
    const nav = makeNavigator();
    const viewer = makeViewer();

    const standardResult = await nav.explore("test query", viewer, { query: "test query", detailLevel: "standard" });
    const auditResult = await nav.explore("test query", viewer, { query: "test query", detailLevel: "audit" });

    const standardHasProvenance = standardResult.evidence_paths.some((ep) => ep.provenance !== undefined);
    const auditHasProvenance = auditResult.evidence_paths.length > 0 &&
      auditResult.evidence_paths.every((ep) => ep.provenance !== undefined);

    expect(standardHasProvenance).toBe(false);
    expect(auditHasProvenance).toBe(true);

    expect(standardResult.audit_summary).toBeUndefined();
    expect(auditResult.audit_summary).toBeDefined();

    const auditExclusiveKeys = new Set(["provenance"]);
    for (const ep of auditResult.evidence_paths) {
      const epKeys = new Set(Object.keys(ep));
      for (const key of auditExclusiveKeys) {
        expect(epKeys.has(key)).toBe(true);
      }
    }
    for (const ep of standardResult.evidence_paths) {
      const epKeys = new Set(Object.keys(ep));
      for (const key of auditExclusiveKeys) {
        expect(epKeys.has(key)).toBe(false);
      }
    }
  });

  it("concise level truncates paths and has no provenance", async () => {
    const nav = makeNavigator();
    const viewer = makeViewer();
    const input: MemoryExploreInput = { query: "test query", detailLevel: "concise" };

    const result = await nav.explore("test query", viewer, input);

    expect(result.evidence_paths.length).toBeLessThanOrEqual(3);
    for (const ep of result.evidence_paths) {
      expect(ep.provenance).toBeUndefined();
    }
    expect(result.audit_summary).toBeUndefined();
  });
});
