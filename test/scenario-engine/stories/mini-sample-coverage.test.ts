import { describe, it, expect } from "bun:test";
import { miniSample } from "./mini-sample.js";
import { validateStory } from "../dsl/story-validation.js";
import type { AssertionStance, AssertionBasis, LogicEdgeType } from "../dsl/story-types.js";

describe("mini-sample coverage", () => {
  it("covers all 7 assertion stances", () => {
    const stances = new Set<AssertionStance>();
    for (const beat of miniSample.beats) {
      for (const assertion of beat.memoryEffects?.assertions ?? []) {
        stances.add(assertion.stance);
      }
    }
    const expected: AssertionStance[] = [
      "hypothetical",
      "tentative",
      "accepted",
      "confirmed",
      "contested",
      "rejected",
      "abandoned",
    ];
    for (const stance of expected) {
      expect(stances.has(stance)).toBe(true);
    }
  });

  it("covers all 5 assertion bases", () => {
    const bases = new Set<AssertionBasis>();
    for (const beat of miniSample.beats) {
      for (const assertion of beat.memoryEffects?.assertions ?? []) {
        if (assertion.basis) {
          bases.add(assertion.basis);
        }
      }
    }
    const expected: AssertionBasis[] = [
      "first_hand",
      "hearsay",
      "inference",
      "introspection",
      "belief",
    ];
    for (const basis of expected) {
      expect(bases.has(basis)).toBe(true);
    }
  });

  it("includes all 3 cognition kinds (assertions, evaluations, commitments)", () => {
    let hasAssertions = false;
    let hasEvaluations = false;
    let hasCommitments = false;
    for (const beat of miniSample.beats) {
      if ((beat.memoryEffects?.assertions?.length ?? 0) > 0) hasAssertions = true;
      if ((beat.memoryEffects?.evaluations?.length ?? 0) > 0) hasEvaluations = true;
      if ((beat.memoryEffects?.commitments?.length ?? 0) > 0) hasCommitments = true;
    }
    expect(hasAssertions).toBe(true);
    expect(hasEvaluations).toBe(true);
    expect(hasCommitments).toBe(true);
  });

  it("covers all 4 episode categories", () => {
    const categories = new Set<string>();
    for (const beat of miniSample.beats) {
      for (const episode of beat.memoryEffects?.episodes ?? []) {
        categories.add(episode.category);
      }
    }
    const expected = ["speech", "action", "observation", "state_change"];
    for (const cat of expected) {
      expect(categories.has(cat)).toBe(true);
    }
  });

  it("covers all 4 logic edge types", () => {
    const edgeTypes = new Set<LogicEdgeType>();
    for (const beat of miniSample.beats) {
      for (const edge of beat.memoryEffects?.logicEdges ?? []) {
        edgeTypes.add(edge.edgeType);
      }
    }
    const expected: LogicEdgeType[] = [
      "causal",
      "temporal_prev",
      "temporal_next",
      "same_episode",
    ];
    for (const type of expected) {
      expect(edgeTypes.has(type)).toBe(true);
    }
  });

  it("includes at least one alias", () => {
    let aliasCount = 0;
    for (const beat of miniSample.beats) {
      aliasCount += beat.memoryEffects?.newAliases?.length ?? 0;
    }
    expect(aliasCount).toBeGreaterThanOrEqual(1);
  });

  it("includes at least one retraction", () => {
    let retractionCount = 0;
    for (const beat of miniSample.beats) {
      retractionCount += beat.memoryEffects?.retractions?.length ?? 0;
    }
    expect(retractionCount).toBeGreaterThanOrEqual(1);
  });

  it("includes at least one contested assertion with preContestedStance", () => {
    let contestedCount = 0;
    for (const beat of miniSample.beats) {
      for (const assertion of beat.memoryEffects?.assertions ?? []) {
        if (assertion.stance === "contested" && assertion.preContestedStance !== undefined) {
          contestedCount++;
        }
      }
    }
    expect(contestedCount).toBeGreaterThanOrEqual(1);
  });

  it("passes validateStory with zero errors", () => {
    const result = validateStory(miniSample);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
