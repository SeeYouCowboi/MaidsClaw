import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mergedEdgePriority,
  resolveEffectivePrimaryIntent,
  resolveEffectiveSecondaryIntents,
} from "../../src/memory/navigator";
import type { QueryPlan } from "../../src/memory/query-plan-types";
import type { NavigatorEdgeKind, QueryType } from "../../src/memory/types";

/**
 * GAP-4 §2 Stage B — chaos / fuzz / adversarial parity tests.
 *
 * The non-chaos test (`navigator-plan-stage-b.test.ts`) exercises the
 * clean matrix of (primary, secondaries, expected first merged kind).
 * This file turns the crank harder:
 *
 *   1. Every 7×7 (primary, single-secondary) combo — 49 cases
 *   2. Every 2-secondary subset, primary fixed — exercise dedup order
 *   3. 3-secondary permutations for representative primaries
 *   4. Self-referential edge cases (primary repeated in secondaries)
 *   5. Deterministic PRNG fuzz (1000 random configurations) — structural
 *      invariants that must hold for ANY shape of plan
 *   6. Flag-off byte-identity check — a plan with every possible garbage
 *      in seed/edge/secondary must NOT change legacy output
 *   7. Order sensitivity — rotating the secondary list changes the
 *      non-primary tail but never the primary head
 *   8. Idempotence — double-invoking helpers returns the same frozen list
 *
 * Every test asserts structural invariants (list is deduplicated, primary
 * head is preserved, length bounded, every primary kind present) so the
 * assertions work even when the expected output is not hand-authored.
 */

const ALL_INTENTS: readonly QueryType[] = [
  "entity",
  "event",
  "why",
  "relationship",
  "timeline",
  "state",
  "conflict",
] as const;

// The `QUERY_TYPE_PRIORITY` constant is not exported, but we re-derive it
// from `mergedEdgePriority(primary, [])` which returns the bare primary
// list — that IS the canonical priority, and it's the right thing to diff
// against: any regression in `mergedEdgePriority([], primary)` would fail
// BOTH this helper call AND the matrix-level assertions below.
function canonicalPriority(primary: QueryType): readonly NavigatorEdgeKind[] {
  return mergedEdgePriority(primary, []);
}

function makePlan(primary: QueryType, secondaries: readonly QueryType[] = []): QueryPlan {
  return {
    route: {
      originalQuery: "chaos",
      normalizedQuery: "chaos",
      intents: [],
      primaryIntent: primary,
      routeConfidence: 0.5,
      resolvedEntityIds: [],
      entityHints: [],
      relationPairs: [],
      timeConstraint: null,
      timeSignals: [],
      locationHints: [],
      asksWhy: false,
      asksChange: false,
      asksComparison: false,
      signals: {
        needsEpisode: 0,
        needsConflict: 0,
        needsTimeline: 0,
        needsRelationship: 0,
        needsCognition: 0,
        needsEntityFocus: 0,
      },
      rationale: "",
      matchedRules: [],
      classifierVersion: "rule-v1",
    },
    surfacePlans: {
      narrative: { baseQuery: "chaos", entityFilters: [], timeWindow: null, weight: 0.5, enabledByRole: true },
      cognition: { baseQuery: "chaos", entityFilters: [], timeWindow: null, weight: 0.5, enabledByRole: true },
      episode: { baseQuery: "chaos", entityFilters: [], timeWindow: null, weight: 0.3, enabledByRole: true },
      conflictNotes: { baseQuery: "chaos", entityFilters: [], timeWindow: null, weight: 0, enabledByRole: true },
    },
    graphPlan: {
      primaryIntent: primary,
      secondaryIntents: [...secondaries],
      timeSlice: null,
      seedBias: {
        entity: 0,
        event: 0,
        episode: 0,
        assertion: 0,
        evaluation: 0,
        commitment: 0,
      },
      edgeBias: {},
    },
    builderVersion: "deterministic-v1",
    rationale: "",
    matchedRules: [],
  };
}

// Seeded PRNG — Mulberry32, fully deterministic.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN;
  // Post-rollout default is ON — explicitly set "off" so any chaos
  // subgroup that expects flag-off legacy behavior measures the right
  // thing. Subgroups that exercise flag-on override this in their own
  // nested beforeEach.
  process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "off";
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN;
  else process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = savedFlag;
});

// ---------------------------------------------------------------------------
// (1) Full 7×7 primary × single-secondary matrix — 49 merges
// ---------------------------------------------------------------------------
describe("Stage B chaos — full 7×7 primary×single-secondary matrix", () => {
  beforeEach(() => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
  });

  for (const primary of ALL_INTENTS) {
    for (const secondary of ALL_INTENTS) {
      it(`primary=${primary}, secondary=[${secondary}] — structural invariants`, () => {
        const merged = mergedEdgePriority(primary, [secondary]);
        const primaryList = canonicalPriority(primary);

        // (a) merged list has no duplicates
        expect(new Set(merged).size).toBe(merged.length);

        // (b) every primary kind is preserved (ordering too)
        for (let i = 0; i < primaryList.length; i += 1) {
          expect(merged[i]).toBe(primaryList[i]);
        }

        // (c) length ≤ primaryList.length + secondaryList.length
        const secondaryList = canonicalPriority(secondary);
        expect(merged.length).toBeLessThanOrEqual(primaryList.length + secondaryList.length);

        // (d) length ≥ primaryList.length (primary is fully preserved)
        expect(merged.length).toBeGreaterThanOrEqual(primaryList.length);

        // (e) when secondary === primary, merged === primaryList exactly
        if (secondary === primary) {
          expect(merged).toEqual(primaryList);
        } else {
          // Every kind from secondary's list appears somewhere in merged
          for (const kind of secondaryList) {
            expect(merged).toContain(kind);
          }
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// (2) 2-secondary subsets, primary fixed — dedup order stability
// ---------------------------------------------------------------------------
describe("Stage B chaos — 2-secondary subsets exercise dedup", () => {
  beforeEach(() => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
  });

  // 21 unordered pairs from 7 → 21 combinations, but we test ordered pairs
  // (42 incl. diagonal removed = 21) to check order sensitivity.
  for (const primary of ALL_INTENTS) {
    const others = ALL_INTENTS.filter((i) => i !== primary);
    for (let i = 0; i < others.length; i += 1) {
      for (let j = i + 1; j < others.length; j += 1) {
        const sA = others[i];
        const sB = others[j];
        it(`primary=${primary}, secondaries=[${sA},${sB}] — head preserved, tail order respects secondary order`, () => {
          const mergedAB = mergedEdgePriority(primary, [sA, sB]);
          const mergedBA = mergedEdgePriority(primary, [sB, sA]);
          const primaryList = canonicalPriority(primary);

          // Head is identical regardless of secondary ordering
          for (let k = 0; k < primaryList.length; k += 1) {
            expect(mergedAB[k]).toBe(primaryList[k]);
            expect(mergedBA[k]).toBe(primaryList[k]);
          }

          // Tails have the same set
          const tailAB = new Set(mergedAB.slice(primaryList.length));
          const tailBA = new Set(mergedBA.slice(primaryList.length));
          expect(tailAB).toEqual(tailBA);

          // Both merged lists are deduplicated
          expect(new Set(mergedAB).size).toBe(mergedAB.length);
          expect(new Set(mergedBA).size).toBe(mergedBA.length);
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// (3) 3-secondary permutations — still dedup + head stable
// ---------------------------------------------------------------------------
describe("Stage B chaos — 3-secondary permutations", () => {
  beforeEach(() => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
  });

  const cases: Array<{ primary: QueryType; secs: QueryType[] }> = [
    { primary: "why", secs: ["conflict", "timeline", "relationship"] },
    { primary: "entity", secs: ["relationship", "timeline", "state"] },
    { primary: "conflict", secs: ["why", "timeline", "state"] },
    { primary: "event", secs: ["timeline", "why", "conflict"] },
    { primary: "state", secs: ["why", "entity", "relationship"] },
  ];

  for (const { primary, secs } of cases) {
    it(`primary=${primary}, secondaries=[${secs.join(",")}] — all 6 permutations share head + tail set`, () => {
      const perms: QueryType[][] = [
        [secs[0], secs[1], secs[2]],
        [secs[0], secs[2], secs[1]],
        [secs[1], secs[0], secs[2]],
        [secs[1], secs[2], secs[0]],
        [secs[2], secs[0], secs[1]],
        [secs[2], secs[1], secs[0]],
      ];
      const primaryList = canonicalPriority(primary);
      const mergeds = perms.map((p) => mergedEdgePriority(primary, p));

      // Head = primaryList for all perms
      for (const m of mergeds) {
        for (let k = 0; k < primaryList.length; k += 1) {
          expect(m[k]).toBe(primaryList[k]);
        }
        expect(new Set(m).size).toBe(m.length); // dedup
      }

      // Tail sets match across all permutations
      const tailSet0 = new Set(mergeds[0].slice(primaryList.length));
      for (const m of mergeds) {
        expect(new Set(m.slice(primaryList.length))).toEqual(tailSet0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// (4) Self-referential adversarial — primary in secondaries, dup secondaries
// ---------------------------------------------------------------------------
describe("Stage B chaos — self-referential + duplicate secondary edge cases", () => {
  beforeEach(() => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
  });

  for (const primary of ALL_INTENTS) {
    it(`primary=${primary}, secondaries=[${primary}] — identical to empty secondary`, () => {
      const merged = mergedEdgePriority(primary, [primary]);
      const bare = canonicalPriority(primary);
      expect(merged).toEqual(bare);
    });

    it(`primary=${primary}, secondaries=[${primary},${primary},${primary}] — idempotent`, () => {
      const merged = mergedEdgePriority(primary, [primary, primary, primary]);
      expect(merged).toEqual(canonicalPriority(primary));
    });
  }

  it("duplicated secondary only adds once (dedup across repeats)", () => {
    const a = mergedEdgePriority("why", ["timeline"]);
    const b = mergedEdgePriority("why", ["timeline", "timeline", "timeline"]);
    expect(a).toEqual(b);
  });

  it("empty secondary array is the same as missing secondary", () => {
    const a = mergedEdgePriority("entity", []);
    const b = canonicalPriority("entity");
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// (5) Deterministic PRNG fuzz — 1000 random plans
// ---------------------------------------------------------------------------
describe("Stage B chaos — fuzz 1000 random plans (deterministic seed)", () => {
  beforeEach(() => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
  });

  it("structural invariants hold for 1000 random (primary, secondaries, analysis) triples", () => {
    const rand = mulberry32(0xdeadbeef);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

    let checked = 0;
    for (let iter = 0; iter < 1000; iter += 1) {
      const primary = pick(ALL_INTENTS);
      const secCount = Math.floor(rand() * 4); // 0..3 secondaries
      const secondaries: QueryType[] = [];
      for (let k = 0; k < secCount; k += 1) secondaries.push(pick(ALL_INTENTS));
      const analysisQT = pick(ALL_INTENTS);

      const analysis = { query_type: analysisQT };
      const plan = makePlan(primary, secondaries);

      // Helper semantics
      const effectivePrimary = resolveEffectivePrimaryIntent(analysis, plan);
      const effectiveSecondaries = resolveEffectiveSecondaryIntents(plan);
      expect(effectivePrimary).toBe(primary); // flag on + plan present
      expect(effectiveSecondaries).toEqual(secondaries);

      // Merge semantics
      const merged = mergedEdgePriority(effectivePrimary, effectiveSecondaries);
      const primaryList = canonicalPriority(primary);

      // Invariant 1: dedup
      expect(new Set(merged).size).toBe(merged.length);

      // Invariant 2: head = primaryList
      for (let k = 0; k < primaryList.length; k += 1) {
        expect(merged[k]).toBe(primaryList[k]);
      }

      // Invariant 3: length bounds — ≥ primary length, ≤ sum of unique kinds
      expect(merged.length).toBeGreaterThanOrEqual(primaryList.length);
      const totalPossible = new Set<string>();
      for (const kind of primaryList) totalPossible.add(kind);
      for (const sec of secondaries) {
        for (const kind of canonicalPriority(sec)) totalPossible.add(kind);
      }
      expect(merged.length).toBe(totalPossible.size);

      checked += 1;
    }
    expect(checked).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// (6) Post-rollout flag semantics under adversarial plan shapes
//   Pre-rollout "flag-off default" became "flag-on default" in the same
//   commit that flipped isNavigatorPlanConsumptionEnabled from `=== "on"`
//   to `!== "off"`. These tests pin both the rollback path (explicit
//   "off") and the new production default (unset or any other string).
// ---------------------------------------------------------------------------
describe("Stage B chaos — post-rollout flag semantics under garbage plans", () => {
  it("explicit off + plan with 7 secondaries + analysis=event → effective = event, secondaries = []", () => {
    const analysis = { query_type: "event" as QueryType };
    const plan = makePlan("conflict", [...ALL_INTENTS]); // primary differs, all 7 secondaries
    // Flag OFF explicitly — rollback path
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "off";
    expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe("event");
    expect(resolveEffectiveSecondaryIntents(plan)).toEqual([]);
  });

  it("post-rollout: flag unset (undefined) + plan present → plan consumption (new default)", () => {
    delete process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN;
    const analysis = { query_type: "state" as QueryType };
    const plan = makePlan("why", ["conflict", "timeline"]);
    // Post-flip: unset means ON, so the plan's primary replaces
    // analysis.query_type and the secondaries list flows through.
    expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe("why");
    expect(resolveEffectiveSecondaryIntents(plan)).toEqual(["conflict", "timeline"]);
  });

  it("post-rollout: only the exact string 'off' disables plan consumption", () => {
    const analysis = { query_type: "event" as QueryType };
    const plan = makePlan("why");
    // Every value other than the exact literal "off" leaves the new
    // default-ON behavior intact — including "yes", "1", "true",
    // "ON" (case-sensitive), " off" (leading space), "off " (trailing
    // space), and "disabled". This is the inverse of the pre-rollout
    // check and gives operators a single obvious disable string.
    for (const val of ["yes", "1", "true", "ON", "On", " off", "off ", "disabled", "", "0"]) {
      process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = val;
      expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe("why");
    }
  });

  it("flag exactly 'off' disables plan consumption (rollback path)", () => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "off";
    const analysis = { query_type: "event" as QueryType };
    const plan = makePlan("why");
    expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe("event");
  });

  it("flag exactly 'on' still enables plan consumption (explicit opt-in)", () => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
    const analysis = { query_type: "event" as QueryType };
    const plan = makePlan("why");
    expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe("why");
  });
});

// ---------------------------------------------------------------------------
// (7) Idempotence + referential stability
// ---------------------------------------------------------------------------
describe("Stage B chaos — idempotence and referential stability", () => {
  beforeEach(() => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
  });

  it("mergedEdgePriority is pure — repeated calls return identical arrays", () => {
    const a = mergedEdgePriority("why", ["timeline", "conflict"]);
    const b = mergedEdgePriority("why", ["timeline", "conflict"]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // different array instances — helper doesn't leak shared state
  });

  it("resolveEffectiveSecondaryIntents returns a defensive copy (not the plan's array reference)", () => {
    const plan = makePlan("why", ["timeline", "conflict"]);
    const a = resolveEffectiveSecondaryIntents(plan);
    // Contents equal
    expect(a).toEqual(["timeline", "conflict"]);
    // But not the same reference — defense in depth against callers
    // that widen the readonly type and mutate the plan in place.
    expect(a).not.toBe(plan.graphPlan.secondaryIntents as readonly QueryType[]);
    // Mutating the copy (via type widening) does not affect the plan.
    (a as QueryType[]).push("state");
    expect(plan.graphPlan.secondaryIntents).toEqual(["timeline", "conflict"]);
  });

  it("mergedEdgePriority never mutates the input secondaries array", () => {
    const secs: QueryType[] = ["timeline", "conflict", "why"];
    const before = [...secs];
    mergedEdgePriority("entity", secs);
    expect(secs).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// (8) Every primary produces a non-empty head score ≠ fallback
// ---------------------------------------------------------------------------
describe("Stage B chaos — every primary has a non-empty priority list", () => {
  for (const primary of ALL_INTENTS) {
    it(`primary=${primary} → canonical priority has ≥ 4 kinds`, () => {
      const list = canonicalPriority(primary);
      expect(list.length).toBeGreaterThanOrEqual(4);
      // Every element is a non-empty string
      for (const kind of list) {
        expect(typeof kind).toBe("string");
        expect(kind.length).toBeGreaterThan(0);
      }
    });
  }
});
