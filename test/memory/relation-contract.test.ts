import { describe, expect, it } from "bun:test";
import {
  RELATION_CONTRACTS,
  LOGIC_EDGE_CONTRACTS,
  MEMORY_RELATION_CONTRACTS,
  KNOWN_NODE_KINDS,
  RESOLUTION_CHAIN_TYPES,
  isKnownRelationType,
  getRelationContract,
  isResolutionChainType,
} from "../../src/memory/contracts/relation-contract.js";
import { MEMORY_RELATION_TYPES } from "../../src/memory/types.js";

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
    expect(getRelationContract("supports")).toBeDefined();
    expect(getRelationContract("supports")!.truth_bearing).toBe(true);
  });
});
