/**
 * @file Type-level tests for canonical vs legacy node-ref kinds split.
 * All assertions are compile-time; runtime tests verify constant arrays.
 */
import { describe, it, expect } from "bun:test";
import {
  NODE_REF_KINDS,
  CANONICAL_NODE_REF_KINDS,
  LEGACY_NODE_REF_KINDS,
  type NodeRefKind,
  type CanonicalNodeRefKind,
} from "./types.js";

describe("NODE_REF_KINDS canonical/legacy split", () => {
  it("NODE_REF_KINDS contains all 8 kinds (canonical + legacy)", () => {
    expect(NODE_REF_KINDS).toHaveLength(8);
    expect(NODE_REF_KINDS).toContain("event");
    expect(NODE_REF_KINDS).toContain("entity");
    expect(NODE_REF_KINDS).toContain("fact");
    expect(NODE_REF_KINDS).toContain("assertion");
    expect(NODE_REF_KINDS).toContain("evaluation");
    expect(NODE_REF_KINDS).toContain("commitment");
    expect(NODE_REF_KINDS).toContain("private_event");
    expect(NODE_REF_KINDS).toContain("private_belief");
  });

  it("CANONICAL_NODE_REF_KINDS contains exactly 6 canonical kinds", () => {
    expect(CANONICAL_NODE_REF_KINDS).toEqual([
      "event",
      "entity",
      "fact",
      "assertion",
      "evaluation",
      "commitment",
    ]);
  });

  it("LEGACY_NODE_REF_KINDS contains exactly 2 legacy kinds", () => {
    expect(LEGACY_NODE_REF_KINDS).toEqual(["private_event", "private_belief"]);
  });

  it("canonical and legacy are disjoint subsets of NODE_REF_KINDS", () => {
    const all = new Set<string>(NODE_REF_KINDS);
    const canonical = new Set<string>(CANONICAL_NODE_REF_KINDS);
    const legacy = new Set<string>(LEGACY_NODE_REF_KINDS);

    for (const k of canonical) {
      expect(all.has(k)).toBe(true);
    }

    for (const k of legacy) {
      expect(all.has(k)).toBe(true);
    }

    for (const k of canonical) {
      expect(legacy.has(k)).toBe(false);
    }

    expect(canonical.size + legacy.size).toBe(all.size);
  });
});

// Type-level assertions using TypeScript's type system
// These will cause compile errors if the types drift
type _CanonicalSubsetOfNodeRef = CanonicalNodeRefKind extends NodeRefKind ? true : never;
const _typeTest1: _CanonicalSubsetOfNodeRef = true;

// Verify specific canonical kinds are assignable to CanonicalNodeRefKind
type _EventIsCanonical = "event" extends CanonicalNodeRefKind ? true : never;
type _EntityIsCanonical = "entity" extends CanonicalNodeRefKind ? true : never;
type _FactIsCanonical = "fact" extends CanonicalNodeRefKind ? true : never;
type _AssertionIsCanonical = "assertion" extends CanonicalNodeRefKind ? true : never;
type _EvaluationIsCanonical = "evaluation" extends CanonicalNodeRefKind ? true : never;
type _CommitmentIsCanonical = "commitment" extends CanonicalNodeRefKind ? true : never;
const _typeTest2: _EventIsCanonical = true;
const _typeTest3: _EntityIsCanonical = true;
const _typeTest4: _FactIsCanonical = true;
const _typeTest5: _AssertionIsCanonical = true;
const _typeTest6: _EvaluationIsCanonical = true;
const _typeTest7: _CommitmentIsCanonical = true;

// _typeTest vars are intentionally unused — they exist only for type checking
void _typeTest1;
void _typeTest2;
void _typeTest3;
void _typeTest4;
void _typeTest5;
void _typeTest6;
void _typeTest7;
