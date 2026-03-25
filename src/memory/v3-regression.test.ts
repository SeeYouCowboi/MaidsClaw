/**
 * @file V3 Regression & Stress Test Suite
 * Covers invariants, compat-layer stability, budget math,
 * schema constants, and belief-revision guarantees.
 * Added in T36 (§28) of the Memory Refactor V3 plan.
 */
import { describe, it, expect } from "bun:test";
import {
  NODE_REF_KINDS,
  CANONICAL_NODE_REF_KINDS,
  MEMORY_RELATION_TYPES,
  type MemoryRelationType,
} from "./types.js";
import {
  VisibilityScope,
  SQL_AREA_VISIBLE,
  runMemoryMigrations,
} from "./schema.js";
import { resolveTemplate, getDefaultTemplate } from "./contracts/retrieval-template.js";
import {
  TERMINAL_STANCES,
  ALLOWED_STANCE_TRANSITIONS,
  assertLegalStanceTransition,
  assertBasisUpgradeOnly,
} from "./cognition/belief-revision.js";

// ─── 1. Schema constants (DoD #3 invariants) ─────────────────────────────────

describe("V3 regression: schema constants", () => {
  it("VisibilityScope.AREA_VISIBLE equals literal 'area_visible'", () => {
    expect(VisibilityScope.AREA_VISIBLE).toBe("area_visible");
  });

  it("SQL_AREA_VISIBLE is the correct SQL WHERE fragment", () => {
    expect(SQL_AREA_VISIBLE).toBe("visibility_scope = 'area_visible'");
  });

  it("SQL_AREA_VISIBLE is derived from VisibilityScope constant (no drift)", () => {
    expect(SQL_AREA_VISIBLE).toBe(`visibility_scope = '${VisibilityScope.AREA_VISIBLE}'`);
  });

  it("runMemoryMigrations is a function", () => {
    expect(typeof runMemoryMigrations).toBe("function");
  });
});

// ─── 2. Node ref kind invariants (T4 / DoD #4 regression) ───────────────────

describe("V3 regression: node ref kind invariants", () => {
  it("CANONICAL_NODE_REF_KINDS has exactly 6 kinds", () => {
    expect(CANONICAL_NODE_REF_KINDS).toHaveLength(6);
  });

  it("canonical kinds do not contain private_event or private_belief", () => {
    expect(CANONICAL_NODE_REF_KINDS).not.toContain("private_event");
    expect(CANONICAL_NODE_REF_KINDS).not.toContain("private_belief");
  });

  it("NODE_REF_KINDS has exactly 6 canonical kinds", () => {
    expect(NODE_REF_KINDS).toHaveLength(6);
  });

  it("NODE_REF_KINDS equals canonical kinds", () => {
    expect(NODE_REF_KINDS).toEqual(CANONICAL_NODE_REF_KINDS);
  });

  it("canonical kinds include all 6 V3 standard kinds", () => {
    for (const k of ["event", "entity", "fact", "assertion", "evaluation", "commitment"]) {
      expect(CANONICAL_NODE_REF_KINDS).toContain(k);
    }
  });

  it("canonical kinds are exactly the supported graph node kinds", () => {
    const canonicalSet = new Set<string>(CANONICAL_NODE_REF_KINDS);
    expect(canonicalSet.has("private_event")).toBe(false);
    expect(canonicalSet.has("private_belief")).toBe(false);
  });
});

// ─── 3. MemoryRelationType completeness (T1 / T13 regression) ────────────────

describe("V3 regression: MemoryRelationType completeness", () => {
  it("has 9 relation types (V2 baseline + V3 extensions)", () => {
    expect(MEMORY_RELATION_TYPES).toHaveLength(9);
  });

  it("contains V2 baseline types", () => {
    const v2Types: MemoryRelationType[] = [
      "supports", "triggered", "conflicts_with", "derived_from", "supersedes",
    ];
    for (const t of v2Types) {
      expect(MEMORY_RELATION_TYPES).toContain(t);
    }
  });

  it("contains V3 extended types", () => {
    const v3Types: MemoryRelationType[] = [
      "surfaced_as", "published_as", "resolved_by", "downgraded_by",
    ];
    for (const t of v3Types) {
      expect(MEMORY_RELATION_TYPES).toContain(t);
    }
  });

  it("no duplicate relation types", () => {
    const unique = new Set(MEMORY_RELATION_TYPES);
    expect(unique.size).toBe(MEMORY_RELATION_TYPES.length);
  });
});

// ─── 4. Retrieval budget math (T29 regression) ───────────────────────────────

describe("V3 regression: retrieval budget math", () => {
  it("rp_agent default template has all required budget fields", () => {
    const t = getDefaultTemplate("rp_agent");
    expect(typeof t.narrativeBudget).toBe("number");
    expect(typeof t.cognitionBudget).toBe("number");
    expect(typeof t.conflictNotesBudget).toBe("number");
    expect(typeof t.episodicBudget).toBe("number");
    expect(typeof t.conflictBoostFactor).toBe("number");
  });

  it("task_agent template has all budgets at 0", () => {
    const t = getDefaultTemplate("task_agent");
    expect(t.narrativeBudget).toBe(0);
    expect(t.cognitionBudget).toBe(0);
    expect(t.conflictNotesBudget).toBe(0);
    expect(t.episodicBudget).toBe(0);
    expect(t.conflictBoostFactor).toBe(0);
  });

  it("rp_agent has positive conflictBoostFactor (adaptive conflict budget works)", () => {
    const t = getDefaultTemplate("rp_agent");
    expect(t.conflictBoostFactor).toBeGreaterThanOrEqual(1);
  });

  it("resolveTemplate override replaces only specified fields", () => {
    const base = getDefaultTemplate("rp_agent");
    const overridden = resolveTemplate("rp_agent", { narrativeBudget: 10 });
    expect(overridden.narrativeBudget).toBe(10);
    expect(overridden.cognitionBudget).toBe(base.cognitionBudget);
    expect(overridden.conflictBoostFactor).toBe(base.conflictBoostFactor);
  });

  it("episodeBudget mirrors episodicBudget in resolved template", () => {
    const t = resolveTemplate("rp_agent", { episodicBudget: 7 });
    expect(t.episodeBudget).toBe(t.episodicBudget);
    expect(t.episodeBudget).toBe(7);
  });
});

// ─── 5. Belief revision module (T2 regression) ───────────────────────────────

describe("V3 regression: belief-revision module exports", () => {
  it("TERMINAL_STANCES is non-empty", () => {
    expect(TERMINAL_STANCES.size).toBeGreaterThan(0);
  });

  it("TERMINAL_STANCES contains rejected and abandoned", () => {
    expect(TERMINAL_STANCES.has("rejected")).toBe(true);
    expect(TERMINAL_STANCES.has("abandoned")).toBe(true);
  });

  it("ALLOWED_STANCE_TRANSITIONS covers all non-terminal stances", () => {
    const nonTerminal = ["hypothetical", "tentative", "accepted", "confirmed", "contested"];
    for (const stance of nonTerminal) {
      expect(ALLOWED_STANCE_TRANSITIONS.has(stance as never)).toBe(true);
    }
  });

  it("assertLegalStanceTransition throws for rejected → uncertain (terminal stance)", () => {
    expect(() => {
      assertLegalStanceTransition({ id: 1, stance: "rejected", basis: null, preContestedStance: null }, "uncertain" as never, "k:1");
    }).toThrow();
  });

  it("assertLegalStanceTransition throws for abandoned → any transition", () => {
    expect(() => {
      assertLegalStanceTransition({ id: 2, stance: "abandoned", basis: null, preContestedStance: null }, "tentative", "k:2");
    }).toThrow();
  });

  it("assertBasisUpgradeOnly does not throw for same basis (no-op)", () => {
    expect(() => {
      assertBasisUpgradeOnly("first_hand", "first_hand", "k:3");
    }).not.toThrow();
  });

  it("assertBasisUpgradeOnly throws for downgrade (observation → belief)", () => {
    expect(() => {
      assertBasisUpgradeOnly("first_hand", "belief", "k:4");
    }).toThrow();
  });
});
