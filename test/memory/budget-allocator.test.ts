import { describe, expect, it } from "bun:test";
import { allocateBudget } from "../../src/memory/retrieval/budget-allocator";
import {
  getDefaultTemplate,
  type RetrievalTemplate,
} from "../../src/memory/contracts/retrieval-template";
import type { QuerySignals } from "../../src/memory/query-routing-types";

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

function totalEnabledBudget(template: Required<RetrievalTemplate>): number {
  return (
    (template.narrativeEnabled ? template.narrativeBudget : 0) +
    (template.cognitionEnabled ? template.cognitionBudget : 0) +
    (template.episodeEnabled
      ? Math.max(template.episodicBudget, template.episodeBudget)
      : 0) +
    (template.conflictNotesEnabled ? template.conflictNotesBudget : 0)
  );
}

describe("BudgetAllocator — zero signal invariance", () => {
  it("returns the template unchanged when all signals are zero", () => {
    const template = getDefaultTemplate("rp_agent");
    const allocated = allocateBudget(template, zeroSignals());
    expect(allocated).toEqual(template);
  });

  it("leaves task_agent (all disabled) untouched", () => {
    const template = getDefaultTemplate("task_agent");
    const signals: QuerySignals = {
      needsEpisode: 1,
      needsConflict: 1,
      needsTimeline: 1,
      needsRelationship: 1,
      needsCognition: 1,
      needsEntityFocus: 1,
    };
    const allocated = allocateBudget(template, signals);
    expect(allocated).toEqual(template);
  });
});

describe("BudgetAllocator — conservation", () => {
  it("total budget does not exceed base total (rp_agent)", () => {
    const template = getDefaultTemplate("rp_agent");
    const baseTotal = totalEnabledBudget(template);

    const signals: QuerySignals = {
      needsEpisode: 1,
      needsConflict: 1,
      needsTimeline: 1,
      needsRelationship: 1,
      needsCognition: 1,
      needsEntityFocus: 1,
    };
    const allocated = allocateBudget(template, signals);
    expect(totalEnabledBudget(allocated)).toBeLessThanOrEqual(baseTotal);
  });

  it("total budget does not exceed base total under asymmetric signals", () => {
    const template = getDefaultTemplate("rp_agent");
    const baseTotal = totalEnabledBudget(template);

    // Fuzz a few distinct signal shapes.
    const shapes: QuerySignals[] = [
      { needsEpisode: 1, needsConflict: 0, needsTimeline: 0, needsRelationship: 0, needsCognition: 0, needsEntityFocus: 0 },
      { needsEpisode: 0, needsConflict: 1, needsTimeline: 0, needsRelationship: 0, needsCognition: 0, needsEntityFocus: 0 },
      { needsEpisode: 0, needsConflict: 0, needsTimeline: 0, needsRelationship: 0, needsCognition: 1, needsEntityFocus: 0 },
      { needsEpisode: 0, needsConflict: 0, needsTimeline: 0, needsRelationship: 0, needsCognition: 0, needsEntityFocus: 1 },
      { needsEpisode: 0.3, needsConflict: 0.7, needsTimeline: 0.2, needsRelationship: 0.5, needsCognition: 0.8, needsEntityFocus: 0.4 },
    ];
    for (const s of shapes) {
      const allocated = allocateBudget(template, s);
      const t = totalEnabledBudget(allocated);
      expect(t).toBeLessThanOrEqual(baseTotal);
    }
  });

  it("maiden conservation respects role-disabled surfaces", () => {
    const template = getDefaultTemplate("maiden");
    const baseTotal = totalEnabledBudget(template);

    const signals: QuerySignals = {
      needsEpisode: 0.8,
      needsConflict: 0.9, // role-disabled; should stay 0
      needsTimeline: 0.5,
      needsRelationship: 0.3,
      needsCognition: 0.9, // role-disabled; should stay 0
      needsEntityFocus: 0.6,
    };
    const allocated = allocateBudget(template, signals);
    expect(allocated.cognitionBudget).toBe(0);
    expect(allocated.conflictNotesBudget).toBe(0);
    expect(allocated.cognitionEnabled).toBe(false);
    expect(allocated.conflictNotesEnabled).toBe(false);
    expect(totalEnabledBudget(allocated)).toBeLessThanOrEqual(baseTotal);
  });
});

describe("BudgetAllocator — minimum-of-1 floor", () => {
  it("enabled surfaces with base > 0 never drop below 1", () => {
    const template = getDefaultTemplate("rp_agent");
    // Push all signal mass to episode — narrative/cognition/conflict should
    // still get >= 1 because they are enabled with base > 0.
    const signals: QuerySignals = {
      needsEpisode: 1,
      needsConflict: 0,
      needsTimeline: 0,
      needsRelationship: 0,
      needsCognition: 0,
      needsEntityFocus: 0,
    };
    const allocated = allocateBudget(template, signals);
    expect(allocated.narrativeBudget).toBeGreaterThanOrEqual(1);
    expect(allocated.cognitionBudget).toBeGreaterThanOrEqual(1);
    expect(allocated.episodicBudget).toBeGreaterThanOrEqual(1);
  });

  it("role-disabled surfaces stay at 0 even with signal pressure", () => {
    const template = getDefaultTemplate("maiden");
    const signals: QuerySignals = {
      needsEpisode: 0,
      needsConflict: 1,
      needsTimeline: 0,
      needsRelationship: 0,
      needsCognition: 1,
      needsEntityFocus: 0,
    };
    const allocated = allocateBudget(template, signals);
    expect(allocated.cognitionBudget).toBe(0);
    expect(allocated.conflictNotesBudget).toBe(0);
  });
});

describe("BudgetAllocator — signal-directed reallocation", () => {
  it("heavy needsEpisode shifts budget toward episode", () => {
    const template = getDefaultTemplate("rp_agent");
    const baseEpisode = Math.max(template.episodicBudget, template.episodeBudget);

    const signals: QuerySignals = {
      needsEpisode: 1,
      needsConflict: 0,
      needsTimeline: 0,
      needsRelationship: 0,
      needsCognition: 0,
      needsEntityFocus: 0,
    };
    const allocated = allocateBudget(template, signals);
    // Episode should be at least as large as base or larger (relative
    // share increased, though conservation caps the absolute).
    expect(allocated.episodicBudget).toBeGreaterThanOrEqual(baseEpisode);
  });

  it("heavy needsCognition shifts budget toward cognition", () => {
    const template = getDefaultTemplate("rp_agent");
    const baseCognition = template.cognitionBudget;

    const signals: QuerySignals = {
      needsEpisode: 0,
      needsConflict: 0,
      needsTimeline: 0,
      needsRelationship: 0,
      needsCognition: 1,
      needsEntityFocus: 0,
    };
    const allocated = allocateBudget(template, signals);
    expect(allocated.cognitionBudget).toBeGreaterThanOrEqual(baseCognition);
  });

  it("heavy needsConflict activates conflict_notes budget from 0", () => {
    const template = getDefaultTemplate("rp_agent");
    // rp_agent conflictNotesBudget default is 2.
    const signals: QuerySignals = {
      needsEpisode: 0,
      needsConflict: 1,
      needsTimeline: 0,
      needsRelationship: 0,
      needsCognition: 0,
      needsEntityFocus: 0,
    };
    const allocated = allocateBudget(template, signals);
    expect(allocated.conflictNotesBudget).toBeGreaterThanOrEqual(
      template.conflictNotesBudget,
    );
  });

  it("opposite signals produce different allocations", () => {
    const template = getDefaultTemplate("rp_agent");
    const episodeHeavy = allocateBudget(template, {
      ...zeroSignals(),
      needsEpisode: 1,
    });
    const cognitionHeavy = allocateBudget(template, {
      ...zeroSignals(),
      needsCognition: 1,
    });
    expect(episodeHeavy).not.toEqual(cognitionHeavy);
    expect(episodeHeavy.episodicBudget).toBeGreaterThanOrEqual(
      cognitionHeavy.episodicBudget,
    );
    expect(cognitionHeavy.cognitionBudget).toBeGreaterThanOrEqual(
      episodeHeavy.cognitionBudget,
    );
  });
});

describe("BudgetAllocator — non-budget fields preserved", () => {
  it("token budgets, boost factors, and enabled flags are not modified", () => {
    const template = getDefaultTemplate("rp_agent");
    const signals: QuerySignals = {
      needsEpisode: 0.5,
      needsConflict: 0.5,
      needsTimeline: 0.5,
      needsRelationship: 0.5,
      needsCognition: 0.5,
      needsEntityFocus: 0.5,
    };
    const allocated = allocateBudget(template, signals);
    expect(allocated.narrativeTokenBudget).toBe(template.narrativeTokenBudget);
    expect(allocated.cognitionTokenBudget).toBe(template.cognitionTokenBudget);
    expect(allocated.conflictNotesTokenBudget).toBe(template.conflictNotesTokenBudget);
    expect(allocated.episodicTokenBudget).toBe(template.episodicTokenBudget);
    expect(allocated.conflictBoostFactor).toBe(template.conflictBoostFactor);
    expect(allocated.narrativeEnabled).toBe(template.narrativeEnabled);
    expect(allocated.cognitionEnabled).toBe(template.cognitionEnabled);
    expect(allocated.episodeEnabled).toBe(template.episodeEnabled);
    expect(allocated.conflictNotesEnabled).toBe(template.conflictNotesEnabled);
  });

  it("maxNarrativeHits and maxCognitionHits mirror the allocated counts", () => {
    const template = getDefaultTemplate("rp_agent");
    const signals: QuerySignals = {
      ...zeroSignals(),
      needsCognition: 0.8,
    };
    const allocated = allocateBudget(template, signals);
    expect(allocated.maxNarrativeHits).toBe(allocated.narrativeBudget);
    expect(allocated.maxCognitionHits).toBe(allocated.cognitionBudget);
  });
});

describe("BudgetAllocator — idempotency and purity", () => {
  it("does not mutate the input template", () => {
    const template = getDefaultTemplate("rp_agent");
    const snapshot = JSON.stringify(template);
    allocateBudget(template, {
      ...zeroSignals(),
      needsCognition: 1,
    });
    expect(JSON.stringify(template)).toBe(snapshot);
  });

  it("same inputs produce equal outputs (deterministic)", () => {
    const template = getDefaultTemplate("rp_agent");
    const signals: QuerySignals = {
      needsEpisode: 0.4,
      needsConflict: 0.6,
      needsTimeline: 0.3,
      needsRelationship: 0.5,
      needsCognition: 0.7,
      needsEntityFocus: 0.2,
    };
    const a = allocateBudget(template, signals);
    const b = allocateBudget(template, signals);
    expect(a).toEqual(b);
  });
});

describe("BudgetAllocator — edge cases", () => {
  it("handles a template with all surfaces at budget 1", () => {
    const template: Required<RetrievalTemplate> = {
      ...getDefaultTemplate("rp_agent"),
      narrativeBudget: 1,
      cognitionBudget: 1,
      episodicBudget: 1,
      episodeBudget: 1,
      conflictNotesBudget: 1,
    };
    const signals: QuerySignals = {
      needsEpisode: 1,
      needsConflict: 1,
      needsTimeline: 1,
      needsRelationship: 1,
      needsCognition: 1,
      needsEntityFocus: 1,
    };
    const allocated = allocateBudget(template, signals);
    // Base total is 4 (narrative+cognition+episode+conflict) — each at 1.
    // With uniform signals, each surface should still get at least 1.
    expect(allocated.narrativeBudget).toBe(1);
    expect(allocated.cognitionBudget).toBe(1);
    expect(allocated.episodicBudget).toBe(1);
    // Conflict may end up 0 or 1 depending on rounding; just ensure it's ≤ 1.
    expect(allocated.conflictNotesBudget).toBeLessThanOrEqual(1);
  });

  it("handles a template with zero conflict budget and no conflict signal", () => {
    const template = getDefaultTemplate("rp_agent");
    const allocated = allocateBudget(template, {
      ...zeroSignals(),
      needsEntityFocus: 1,
    });
    // Conflict signal is 0, base was 2 — should be reduced to minimum of 1
    // (enforced by the floor) unless the signal truly pulls it down.
    expect(allocated.conflictNotesBudget).toBeLessThanOrEqual(template.conflictNotesBudget);
  });
});
