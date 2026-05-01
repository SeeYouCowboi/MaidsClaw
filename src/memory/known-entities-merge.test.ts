import { describe, expect, it } from "bun:test";

import { __knownEntitiesTestInternals__ } from "./prompt-data.js";

const { mergeKnownEntityCandidates, rankRecentSessionEntities } =
  __knownEntitiesTestInternals__;

describe("mergeKnownEntityCandidates — core entity floor", () => {
  it("ranks core pointer keys above non-core ones even when non-core is fresher", () => {
    // Settlement source priority = 3, episode = 2.
    // Without core floor, order would be: settlement-fresh first (door, window),
    // then settlement-old (alice), then episodes — pushing alice/butler down.
    const settlementRows = [
      { pointer_key: "门", display_name: null, summary: null },
      { pointer_key: "窗户", display_name: null, summary: null },
      { pointer_key: "alice", display_name: "Alice", summary: null },
      { pointer_key: "管家", display_name: null, summary: null },
      { pointer_key: "感觉", display_name: null, summary: null },
    ];
    const episodeRows = [
      { pointer_key: "茶室", display_name: null, summary: null },
    ];

    const merged = mergeKnownEntityCandidates({
      recent: [
        ...rankRecentSessionEntities(settlementRows, 3),
        ...rankRecentSessionEntities(episodeRows, 2),
      ],
      corePointerKeys: new Set(["alice", "管家", "茶室", "温室", "花房"]),
    });

    const order = merged.map((e) => e.pointer_key);
    // Core entities must precede non-core, regardless of recency rank.
    const aliceIdx = order.indexOf("alice");
    const butlerIdx = order.indexOf("管家");
    const tearoomIdx = order.indexOf("茶室");
    const doorIdx = order.indexOf("门");
    const windowIdx = order.indexOf("窗户");

    expect(aliceIdx).toBeLessThan(doorIdx);
    expect(aliceIdx).toBeLessThan(windowIdx);
    expect(butlerIdx).toBeLessThan(doorIdx);
    expect(tearoomIdx).toBeLessThan(doorIdx); // even episode-source core wins
  });

  it("preserves recency order within the core tier", () => {
    const settlementRows = [
      { pointer_key: "管家", display_name: null, summary: null }, // fresher
      { pointer_key: "alice", display_name: null, summary: null },
    ];
    const merged = mergeKnownEntityCandidates({
      recent: rankRecentSessionEntities(settlementRows, 3),
      corePointerKeys: new Set(["alice", "管家"]),
    });
    const order = merged.map((e) => e.pointer_key);
    expect(order.indexOf("管家")).toBe(0);
    expect(order.indexOf("alice")).toBe(1);
  });

  it("preserves recency order within the non-core tier", () => {
    const settlementRows = [
      { pointer_key: "门", display_name: null, summary: null }, // fresher
      { pointer_key: "窗户", display_name: null, summary: null },
    ];
    const merged = mergeKnownEntityCandidates({
      recent: rankRecentSessionEntities(settlementRows, 3),
      corePointerKeys: new Set(),
    });
    const order = merged.map((e) => e.pointer_key);
    expect(order).toEqual(["门", "窗户"]);
  });

  it("falls back to recency-only ranking when no core set is provided", () => {
    const settlementRows = [
      { pointer_key: "门", display_name: null, summary: null },
      { pointer_key: "alice", display_name: null, summary: null },
    ];
    const merged = mergeKnownEntityCandidates({
      recent: rankRecentSessionEntities(settlementRows, 3),
    });
    expect(merged.map((e) => e.pointer_key)).toEqual(["门", "alice"]);
  });

  it("does not duplicate core entities when seen via multiple sources", () => {
    const settlementRows = [
      { pointer_key: "alice", display_name: "Alice", summary: null },
    ];
    const episodeRows = [
      { pointer_key: "alice", display_name: "Alice", summary: "厨房助手" },
    ];
    const merged = mergeKnownEntityCandidates({
      recent: [
        ...rankRecentSessionEntities(settlementRows, 3),
        ...rankRecentSessionEntities(episodeRows, 2),
      ],
      corePointerKeys: new Set(["alice"]),
    });
    expect(merged.length).toBe(1);
    expect(merged[0].pointer_key).toBe("alice");
    // Settlement tier won the merge, so its (null) summary is kept rather than
    // being overwritten by the episode-tier summary. This matches existing
    // sourcePriority semantics — core boost is applied symmetrically so neither
    // side gets a hidden advantage.
  });

  it("matches core keys via canonicalized pointer form", () => {
    // Caller provides keys in lowercase; row's raw pointer_key may have
    // pre-canonical surface (e.g. uppercase). The boost should still apply
    // because corePriorityFor canonicalizes before checking.
    const settlementRows = [
      { pointer_key: "Alice", display_name: "Alice", summary: null },
      { pointer_key: "门", display_name: null, summary: null },
    ];
    const merged = mergeKnownEntityCandidates({
      recent: rankRecentSessionEntities(settlementRows, 3),
      corePointerKeys: new Set(["alice"]),
    });
    expect(merged[0].pointer_key).toBe("Alice");
  });
});
