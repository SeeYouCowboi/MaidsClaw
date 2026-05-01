import { describe, expect, it } from "bun:test";
import {
  buildAnchorPool,
  matchesRelatedEntityReferencePattern,
} from "../../src/memory/retrieval.js";

describe("buildAnchorPool — phase-1 prior-turn fallback", () => {
  it("supplements with prior-turn hints when current-turn does not fill the pool", () => {
    const result = buildAnchorPool(["Alice", "花房"], ["Bob", "茶室"]);
    // Pool cap is 3 → 2 current + 1 prior. Bob fills the 3rd slot;
    // 茶室 is dropped because the pool is now full.
    expect(result.anchors).toEqual(["Alice", "花房", "Bob"]);
    expect(result.priorTurnAnchorsUsed).toBe(1);
  });

  it("does not use prior-turn when current-turn already fills the pool", () => {
    const result = buildAnchorPool(["Alice", "花房", "管家"], ["Bob"]);
    expect(result.anchors).toEqual(["Alice", "花房", "管家"]);
    expect(result.priorTurnAnchorsUsed).toBe(0);
  });

  it("falls back to prior-turn hints when current-turn is empty", () => {
    const result = buildAnchorPool([], ["Alice", "花房"]);
    expect(result.anchors).toEqual(["Alice", "花房"]);
    expect(result.priorTurnAnchorsUsed).toBe(2);
  });

  it("fills remaining slots with prior-turn hints after current-turn", () => {
    const result = buildAnchorPool(["Alice"], ["Bob", "茶室", "花房", "管家"]);
    // Slot capacity is 3 → 1 current + 2 prior fills the pool
    expect(result.anchors).toEqual(["Alice", "Bob", "茶室"]);
    expect(result.priorTurnAnchorsUsed).toBe(2);
  });

  it("dedupes case-insensitively across current and prior layers", () => {
    const result = buildAnchorPool(["alice"], ["Alice", "Bob"]);
    expect(result.anchors).toEqual(["alice", "Bob"]);
    expect(result.priorTurnAnchorsUsed).toBe(1);
  });

  it("dedupes within prior-turn hints", () => {
    const result = buildAnchorPool([], ["Alice", "alice", "ALICE", "Bob"]);
    expect(result.anchors).toEqual(["Alice", "Bob"]);
    expect(result.priorTurnAnchorsUsed).toBe(2);
  });

  it("caps the pool at 3 anchors total", () => {
    const result = buildAnchorPool(
      ["A", "B", "C", "D"],
      ["E", "F"],
    );
    expect(result.anchors).toHaveLength(3);
    expect(result.priorTurnAnchorsUsed).toBe(0);
  });

  it("returns empty pool when both layers are empty", () => {
    const result = buildAnchorPool([], []);
    expect(result.anchors).toEqual([]);
    expect(result.priorTurnAnchorsUsed).toBe(0);
  });

  it("ignores empty/whitespace hints", () => {
    const result = buildAnchorPool(["", "  "], ["Alice"]);
    expect(result.anchors).toEqual(["Alice"]);
    expect(result.priorTurnAnchorsUsed).toBe(1);
  });

  it("preserves canonical surface form (does not lowercase the output)", () => {
    const result = buildAnchorPool(["Alice"], []);
    expect(result.anchors).toEqual(["Alice"]);
  });
});

describe("matchesRelatedEntityReferencePattern — pattern coverage", () => {
  it("matches Chinese locative-person references", () => {
    expect(matchesRelatedEntityReferencePattern("花房那边的人是谁")).toBe(true);
    expect(matchesRelatedEntityReferencePattern("这边的人都走了")).toBe(true);
    expect(matchesRelatedEntityReferencePattern("哪位最了解这件事")).toBe(true);
  });

  it("matches generic pronominal references", () => {
    expect(matchesRelatedEntityReferencePattern("那人呢")).toBe(true);
    expect(matchesRelatedEntityReferencePattern("谁知道")).toBe(true);
  });

  it("matches English variants", () => {
    expect(matchesRelatedEntityReferencePattern("Who was there")).toBe(true);
    expect(matchesRelatedEntityReferencePattern("Someone took it")).toBe(true);
    expect(matchesRelatedEntityReferencePattern("That person knows")).toBe(true);
  });

  it("does not match unrelated queries", () => {
    expect(matchesRelatedEntityReferencePattern("茶室在哪")).toBe(false);
    expect(matchesRelatedEntityReferencePattern("Where is the garden")).toBe(false);
  });
});
