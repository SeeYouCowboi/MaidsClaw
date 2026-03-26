import { describe, expect, it } from "bun:test";
import { AliasService } from "../../src/memory/alias.js";
import { GraphNavigator } from "../../src/memory/navigator.js";
import { AuthorizationPolicy } from "../../src/memory/redaction-policy.js";
import { makeNodeRef } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import type { Db } from "../helpers/memory-test-utils.js";
import { cleanupDb, createTempDb, createViewerContext, seedStandardEntities } from "../helpers/memory-test-utils.js";
import type { EvidencePath, NodeRef, SeedCandidate, ViewerContext } from "../../src/memory/types.js";

class StubRetrieval {
  constructor(private readonly seeds: SeedCandidate[]) {}

  async localizeSeedsHybrid(): Promise<SeedCandidate[]> {
    return this.seeds;
  }
}

function buildNavigator(db: Db, seeds: SeedCandidate[]): GraphNavigator {
  return new GraphNavigator(db as any, new StubRetrieval(seeds) as any, new AliasService(db as any));
}

function toSeed(nodeRef: NodeRef, nodeKind: SeedCandidate["node_kind"]): SeedCandidate {
  const isPrivate =
    nodeKind === "assertion" ||
    nodeKind === "evaluation" ||
    nodeKind === "commitment";
  return {
    node_ref: nodeRef,
    node_kind: nodeKind,
    lexical_score: 0.95,
    semantic_score: 0,
    fused_score: 0.95,
    source_scope: isPrivate ? "private" : "world",
  };
}

function createWorldEvent(storage: GraphStorageService, locationEntityId: number, summary: string): number {
  return storage.createProjectedEvent({
    sessionId: "session-visibility-tests",
    summary,
    timestamp: Date.now(),
    participants: "[]",
    locationEntityId,
    eventCategory: "observation",
    origin: "runtime_projection",
    visibilityScope: "world_public",
  });
}

function createPrivateAssertion(storage: GraphStorageService, agentId: string, cognitionKey: string, predicate: string): { id: number; ref: NodeRef } {
  return storage.upsertExplicitAssertion({
    agentId,
    cognitionKey,
    settlementId: `${cognitionKey}:settlement`,
    opIndex: 0,
    sourcePointerKey: "__self__",
    predicate,
    targetPointerKey: "bob",
    stance: "accepted",
    basis: "first_hand",
  });
}

function insertMemoryRelation(
  db: Db,
  sourceNodeRef: NodeRef,
  targetNodeRef: NodeRef,
  relationType: "supports" | "triggered" | "conflicts_with" | "derived_from" | "supersedes" = "supports",
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memory_relations
      (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
     VALUES (?, ?, ?, 0.9, 'direct', 'system', ?, ?, ?)`,
  ).run(sourceNodeRef, targetNodeRef, relationType, `test:${relationType}:${now}`, now, now);
}

function makeScore() {
  return {
    seed_score: 0.5,
    edge_type_score: 0.5,
    temporal_consistency: 1,
    query_intent_match: 0.5,
    support_score: 0,
    recency_score: 0.5,
    hop_penalty: 0,
    redundancy_penalty: 0,
    path_score: 0.4,
  };
}

describe("validation explain visibility/redaction", () => {
  it("Explain applies visibility filter (cross-agent)", async () => {
    const { db, dbPath } = createTempDb();
    try {
      const storage = new GraphStorageService(db);
      const { locationId } = seedStandardEntities(db);

      const publicEventId = createWorldEvent(storage, locationId, "Public clue about agent_x");
      const privateAssertion = createPrivateAssertion(storage, "agent_x", "vis:t1", "AGENT_X_PRIVATE_COGNITION_T1");
      insertMemoryRelation(db, makeNodeRef("event", publicEventId), privateAssertion.ref, "supports");

      const navigator = buildNavigator(db, [toSeed(makeNodeRef("event", publicEventId), "event")]);
      const viewerY: ViewerContext = createViewerContext({
        viewer_agent_id: "agent_y",
        viewer_role: "rp_agent",
        current_area_id: locationId,
        session_id: "session-agent-y",
      });

      const result = await navigator.explore("why agent_x appears cautious", viewerY, {
        query: "why agent_x appears cautious",
        mode: "why",
      });

      const serializedPaths = JSON.stringify(result.evidence_paths);
      expect(serializedPaths).not.toContain("AGENT_X_PRIVATE_COGNITION_T1");
      expect(serializedPaths).not.toContain(privateAssertion.ref);
      expect(
        result.evidence_paths.every((path) =>
          path.path.nodes.every((node) => !String(node).startsWith("assertion:") && !String(node).startsWith("private_"))),
      ).toBe(true);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("Redacted placeholder has exact structure", () => {
    const { db, dbPath } = createTempDb();
    try {
      const storage = new GraphStorageService(db);
      const { locationId } = seedStandardEntities(db);

      const eventRef = makeNodeRef("event", createWorldEvent(storage, locationId, "Visible anchor event"));
      const assertionRef = createPrivateAssertion(storage, "agent_x", "vis:t2", "PRIVATE_FOR_STRUCTURE_TEST").ref;

      const navigator = buildNavigator(db, []);
      const viewerY = createViewerContext({ viewer_agent_id: "agent_y", viewer_role: "rp_agent", current_area_id: locationId });

      const unsafePath: EvidencePath = {
        path: {
          seed: eventRef,
          nodes: [eventRef, assertionRef],
          edges: [
            {
              from: eventRef,
              to: assertionRef,
              kind: "fact_support",
              layer: "symbolic",
              weight: 1,
              timestamp: Date.now(),
              summary: "supports",
            },
          ],
          depth: 1,
        },
        score: makeScore(),
        supporting_nodes: [assertionRef],
        supporting_facts: [],
      };

      const safePath = (navigator as any).applyPostFilterSafetyNet(unsafePath, viewerY) as EvidencePath | null;
      expect(safePath).not.toBeNull();
      expect(safePath?.redacted_placeholders).toHaveLength(1);

      const placeholder = safePath?.redacted_placeholders?.[0];
      expect(placeholder?.type).toBe("redacted");
      expect(["hidden", "private", "admin_only"]).toContain(placeholder?.reason);
      expect(placeholder?.node_ref).toBe(assertionRef);
      expect(Object.keys(placeholder ?? {}).sort()).toEqual(["node_ref", "reason", "type"]);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("Hidden node retains structure trace", () => {
    const { db, dbPath } = createTempDb();
    try {
      const storage = new GraphStorageService(db);
      const { locationId } = seedStandardEntities(db);

      const startEventRef = makeNodeRef("event", createWorldEvent(storage, locationId, "Path start"));
      const endEventRef = makeNodeRef("event", createWorldEvent(storage, locationId, "Path end"));
      const hiddenAssertionRef = createPrivateAssertion(storage, "agent_x", "vis:t3", "HIDDEN_INTERMEDIATE_LINK").ref;

      const navigator = buildNavigator(db, []);
      const viewerY = createViewerContext({ viewer_agent_id: "agent_y", viewer_role: "rp_agent", current_area_id: locationId });

      const unsafePath: EvidencePath = {
        path: {
          seed: startEventRef,
          nodes: [startEventRef, hiddenAssertionRef, endEventRef],
          edges: [
            {
              from: startEventRef,
              to: hiddenAssertionRef,
              kind: "fact_support",
              layer: "symbolic",
              weight: 1,
              timestamp: Date.now(),
              summary: "hidden hop in middle",
            },
            {
              from: hiddenAssertionRef,
              to: endEventRef,
              kind: "fact_support",
              layer: "symbolic",
              weight: 1,
              timestamp: Date.now(),
              summary: "hidden hop to end",
            },
          ],
          depth: 2,
        },
        score: makeScore(),
        supporting_nodes: [hiddenAssertionRef],
        supporting_facts: [],
      };

      const safePath = (navigator as any).applyPostFilterSafetyNet(unsafePath, viewerY) as EvidencePath | null;
      expect(safePath).not.toBeNull();
      expect(safePath?.path.nodes).toEqual([startEventRef, endEventRef]);
      expect(safePath?.path.edges).toHaveLength(0);
      expect((safePath?.redacted_placeholders?.length ?? 0) > 0).toBe(true);
      expect(safePath?.redacted_placeholders?.some((placeholder) => placeholder.node_ref === hiddenAssertionRef)).toBe(true);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("Admin-only access follows explicit viewer capability", () => {
    const { db, dbPath } = createTempDb();
    try {
      const authorization = new AuthorizationPolicy();
      const adminViewer = createViewerContext({
        viewer_agent_id: "agent_admin",
        viewer_role: "task_agent",
        can_read_admin_only: true,
      });
      const nonAdminViewer = createViewerContext({
        viewer_agent_id: "agent_rp",
        viewer_role: "maiden",
        can_read_admin_only: false,
      });

      expect(authorization.canViewAdminOnly(adminViewer)).toBe(true);
      expect(authorization.canViewAdminOnly(nonAdminViewer)).toBe(false);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("Private cognition not in explain evidence paths", async () => {
    const { db, dbPath } = createTempDb();
    try {
      const storage = new GraphStorageService(db);
      const { locationId } = seedStandardEntities(db);

      const publicEventRef = makeNodeRef("event", createWorldEvent(storage, locationId, "Public anchor for explain"));
      const privateAssertion = createPrivateAssertion(storage, "agent_x", "vis:t5", "PRIVATE_MARKER_XYZ");
      insertMemoryRelation(db, publicEventRef, privateAssertion.ref, "supports");

      const navigator = buildNavigator(db, [
        toSeed(publicEventRef, "event"),
        toSeed(privateAssertion.ref, "assertion"),
      ]);
      const viewerY = createViewerContext({
        viewer_agent_id: "agent_y",
        viewer_role: "rp_agent",
        current_area_id: locationId,
        session_id: "session-agent-y-t5",
      });

      const result = await navigator.explore("explain private cognition risk", viewerY, {
        query: "explain private cognition risk",
        mode: "conflict",
      });
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain("PRIVATE_MARKER_XYZ");
      expect(serialized).not.toContain(privateAssertion.ref);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("memory_explore traverses both logic_edges + memory_relations (characterization)", async () => {
    const { db, dbPath } = createTempDb();
    try {
      const storage = new GraphStorageService(db);
      const { locationId } = seedStandardEntities(db);

      const event1 = createWorldEvent(storage, locationId, "First event");
      const event2 = createWorldEvent(storage, locationId, "Second event");
      storage.createLogicEdge(event1, event2, "causal");

      const event1Ref = makeNodeRef("event", event1);
      const event2Ref = makeNodeRef("event", event2);
      insertMemoryRelation(db, event1Ref, event2Ref, "supports");

      const navigator = buildNavigator(db, [toSeed(event1Ref, "event")]);
      const viewer = createViewerContext({
        viewer_agent_id: "agent_y",
        viewer_role: "rp_agent",
        current_area_id: locationId,
        session_id: "session-agent-y-t6",
      });

      // V3 migration target: see V3 candidates §18.2 — navigator uses both logic_edges and memory_relations by design
      const result = await navigator.explore("timeline around event transitions", viewer, {
        query: "timeline around event transitions",
        mode: "timeline",
      });

      expect(Array.isArray(result.evidence_paths)).toBe(true);
      expect(result.evidence_paths.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanupDb(db, dbPath);
    }
  });
});
