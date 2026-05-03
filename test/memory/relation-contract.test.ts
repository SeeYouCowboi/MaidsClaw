import { describe, expect, it } from "bun:test";
import {
  CONSENSUS_EDGE_SEMANTICS_MATRIX,
  EDGE_SEMANTICS_BY_TABLE,
  FACT_EDGE_PREDICATE_WILDCARD,
  getRelationContract,
  isKnownRelationType,
  isResolutionChainType,
  KNOWN_NODE_KINDS,
  LOGIC_EDGE_CONTRACTS,
  MEMORY_RELATION_CONTRACTS,
  RELATION_CONTRACTS,
  RESOLUTION_CHAIN_TYPES,
} from "../../src/memory/contracts/relation-contract.js";
import {
  CONSENSUS_EDGE_LAYERS,
  LOGIC_EDGE_TYPES,
  MEMORY_RELATION_TYPES,
  NAVIGATOR_EDGE_LAYERS,
  SEMANTIC_EDGE_TYPES,
} from "../../src/memory/types.js";

describe("relation-contract centralization", () => {
  it("RELATION_CONTRACTS contains all logic edge + memory relation entries", () => {
    const logicKeys = Object.keys(LOGIC_EDGE_CONTRACTS);
    const memoryKeys = Object.keys(MEMORY_RELATION_CONTRACTS);
    const combinedKeys = Object.keys(RELATION_CONTRACTS);

    expect(combinedKeys.sort()).toEqual([...logicKeys, ...memoryKeys].sort());
  });

  it("MEMORY_RELATION_CONTRACTS covers every MemoryRelationType from types.ts", () => {
    for (const relType of MEMORY_RELATION_TYPES) {
      expect(relType in MEMORY_RELATION_CONTRACTS).toBe(true);
    }
    expect(Object.keys(MEMORY_RELATION_CONTRACTS)).toHaveLength(MEMORY_RELATION_TYPES.length);
  });

  it("RESOLUTION_CHAIN_TYPES are all present in RELATION_CONTRACTS", () => {
    for (const chainType of RESOLUTION_CHAIN_TYPES) {
      expect(isKnownRelationType(chainType)).toBe(true);
      expect(isResolutionChainType(chainType)).toBe(true);
    }
  });

  it("every contract has valid endpoint families from KNOWN_NODE_KINDS or 'unknown'", () => {
    const validFamilies = new Set([...KNOWN_NODE_KINDS, "unknown"]);
    for (const [, contract] of Object.entries(RELATION_CONTRACTS)) {
      expect(validFamilies.has(contract.source_family)).toBe(true);
      expect(validFamilies.has(contract.target_family)).toBe(true);
    }
  });

  it("getRelationContract returns undefined for unknown types", () => {
    expect(getRelationContract("nonexistent")).toBeUndefined();
    const supportsContract = getRelationContract("supports");
    expect(supportsContract).toBeDefined();
    expect(supportsContract?.truth_bearing).toBe(true);
  });

  it("consensus matrix enumerates all known logic/memory/semantic kinds plus fact wildcard", () => {
    for (const edgeKind of LOGIC_EDGE_TYPES) {
      expect(CONSENSUS_EDGE_SEMANTICS_MATRIX[edgeKind]).toBeDefined();
      expect(EDGE_SEMANTICS_BY_TABLE.logic_edges[edgeKind]).toBeDefined();
    }

    for (const edgeKind of MEMORY_RELATION_TYPES) {
      expect(CONSENSUS_EDGE_SEMANTICS_MATRIX[edgeKind]).toBeDefined();
      expect(EDGE_SEMANTICS_BY_TABLE.memory_relations[edgeKind]).toBeDefined();
    }

    for (const edgeKind of SEMANTIC_EDGE_TYPES) {
      expect(CONSENSUS_EDGE_SEMANTICS_MATRIX[edgeKind]).toBeDefined();
      expect(EDGE_SEMANTICS_BY_TABLE.semantic_edges[edgeKind]).toBeDefined();
    }

    expect(EDGE_SEMANTICS_BY_TABLE.fact_edges[FACT_EDGE_PREDICATE_WILDCARD]).toBeDefined();
    expect(CONSENSUS_EDGE_SEMANTICS_MATRIX[FACT_EDGE_PREDICATE_WILDCARD]).toBeDefined();
    expect(FACT_EDGE_PREDICATE_WILDCARD).toBe("__fact_edge_wildcard__");
  });

  it("each matrix entry has required metadata fields", () => {
    const tableValues = new Set(["logic_edges", "memory_relations", "semantic_edges", "fact_edges"]);
    const layerValues = new Set(["narrative", "cognitive", "latent", "world_state"]);
    const endpointFamilies = new Set(["any", ...KNOWN_NODE_KINDS]);
    const lifecycleValues = new Set(["immutable", "supersedable", "regenerable"]);

    for (const semantics of Object.values(CONSENSUS_EDGE_SEMANTICS_MATRIX)) {
      expect(tableValues.has(semantics.table)).toBe(true);
      expect(layerValues.has(semantics.layer)).toBe(true);
      expect(Array.isArray(semantics.endpointFamilies)).toBe(true);
      expect(semantics.endpointFamilies).toHaveLength(2);
      expect(endpointFamilies.has(semantics.endpointFamilies[0])).toBe(true);
      expect(endpointFamilies.has(semantics.endpointFamilies[1])).toBe(true);
      expect(typeof semantics.truthBearing).toBe("boolean");
      expect(typeof semantics.heuristicOnly).toBe("boolean");
      expect(typeof semantics.temporal).toBe("boolean");
      expect(lifecycleValues.has(semantics.lifecycle)).toBe(true);
      if (semantics.cardinality_per_source !== undefined) {
        expect(Number.isInteger(semantics.cardinality_per_source)).toBe(true);
        expect(semantics.cardinality_per_source).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the three contradiction concepts distinct by layer", () => {
    expect(CONSENSUS_EDGE_SEMANTICS_MATRIX.contradict.layer).toBe("narrative");
    expect(CONSENSUS_EDGE_SEMANTICS_MATRIX.conflicts_with.layer).toBe("cognitive");
    expect(CONSENSUS_EDGE_SEMANTICS_MATRIX.conflict_or_update.layer).toBe("latent");

    const contradictionLayers = new Set([
      CONSENSUS_EDGE_SEMANTICS_MATRIX.contradict.layer,
      CONSENSUS_EDGE_SEMANTICS_MATRIX.conflicts_with.layer,
      CONSENSUS_EDGE_SEMANTICS_MATRIX.conflict_or_update.layer,
    ]);
    expect(contradictionLayers.size).toBe(3);
  });

  it("isKnownRelationType / getRelationContract / isResolutionChainType behave on edge cases", () => {
    expect(isKnownRelationType("supports")).toBe(true);
    expect(isKnownRelationType("causal")).toBe(true);
    expect(isKnownRelationType("__nope__")).toBe(false);
    expect(isKnownRelationType("")).toBe(false);

    const causal = getRelationContract("causal");
    expect(causal?.layer).toBe("narrative");
    expect(causal?.truth_bearing).toBe(true);

    expect(isResolutionChainType("conflicts_with")).toBe(true);
    expect(isResolutionChainType("resolved_by")).toBe(true);
    expect(isResolutionChainType("downgraded_by")).toBe(true);
    expect(isResolutionChainType("supports")).toBe(false);
    expect(isResolutionChainType("causal")).toBe(false);
  });

  it("only the four expected entries declare cardinality_per_source, with locked values", () => {
    const declared: Record<string, number> = {};
    for (const [key, semantics] of Object.entries(CONSENSUS_EDGE_SEMANTICS_MATRIX)) {
      if (semantics.cardinality_per_source !== undefined) {
        declared[key] = semantics.cardinality_per_source;
      }
    }
    expect(declared).toEqual({
      temporal_prev: 1,
      temporal_next: 1,
      semantic_similar: 4,
      conflict_or_update: 2,
      entity_bridge: 2,
    });
  });

  it("EmbeddingLinker semantic-edge cardinalities match RelationContract.cardinality_per_source", async () => {
    const source = await Bun.file("src/memory/embedding-linker.ts").text();
    const semSim = EDGE_SEMANTICS_BY_TABLE.semantic_edges.semantic_similar.cardinality_per_source;
    const conflict = EDGE_SEMANTICS_BY_TABLE.semantic_edges.conflict_or_update.cardinality_per_source;
    const bridge = EDGE_SEMANTICS_BY_TABLE.semantic_edges.entity_bridge.cardinality_per_source;
    expect(semSim).toBe(4);
    expect(conflict).toBe(2);
    expect(bridge).toBe(2);

    expect(source).toContain(`similarCount >= ${semSim}`);
    expect(source).toContain(`conflictCount >= ${conflict}`);
    expect(source).toContain(`bridgeCount >= ${bridge}`);
  });

  it("legacy NavigatorEdgeLayer values stay distinct from consensus EdgeLayer values", () => {
    expect(NAVIGATOR_EDGE_LAYERS).toEqual(["state", "symbolic", "heuristic"]);
    expect(CONSENSUS_EDGE_LAYERS).toEqual(["narrative", "cognitive", "latent", "world_state"]);
    const overlap = NAVIGATOR_EDGE_LAYERS.filter((l) =>
      (CONSENSUS_EDGE_LAYERS as readonly string[]).includes(l),
    );
    expect(overlap).toEqual([]);
  });

  it("every contract.layer is a consensus EdgeLayer (never a NavigatorEdgeLayer)", () => {
    const consensusSet = new Set<string>(CONSENSUS_EDGE_LAYERS);
    const navigatorSet = new Set<string>(NAVIGATOR_EDGE_LAYERS);
    for (const [, contract] of Object.entries(RELATION_CONTRACTS)) {
      expect(consensusSet.has(contract.layer)).toBe(true);
      expect(navigatorSet.has(contract.layer)).toBe(false);
    }
    for (const semantics of Object.values(CONSENSUS_EDGE_SEMANTICS_MATRIX)) {
      expect(consensusSet.has(semantics.layer)).toBe(true);
      expect(navigatorSet.has(semantics.layer)).toBe(false);
    }
  });
});
