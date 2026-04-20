import { describe, expect, it } from "bun:test";
import { AreaWorldProjectionRepo } from "../../../src/memory/projection/area-world-projection-repo.js";

function makeNoopDb() {
  return {
    exec(_sql: string) {},
    prepare(_sql: string) {
      return {
        run(..._params: unknown[]) {
          return { changes: 0, lastInsertRowid: 0 };
        },
        all(..._params: unknown[]) {
          return [];
        },
        get(..._params: unknown[]) {
          return undefined;
        },
      };
    },
  };
}

describe("SQLite deferred source kind guard", () => {
  it("rejects evidence_reveal with DEFERRED_SOURCE_KIND error", async () => {
    const repo = new AreaWorldProjectionRepo(makeNoopDb());
    await expect(
      repo.applyAreaFactCommit({
        sessionId: "test-session",
        areaId: 1,
        factKey: "test-fact",
        valueJson: { data: true },
        sourceKind: "evidence_reveal",
        exposureScope: "area_visible",
        sourceSettlementId: null,
        sourceAgentId: null,
        validTime: new Date(),
        committedTime: new Date(),
      }),
    ).rejects.toThrow("DEFERRED_SOURCE_KIND:");
  });

  it("rejects institutional_speech_act with DEFERRED_SOURCE_KIND error", async () => {
    const repo = new AreaWorldProjectionRepo(makeNoopDb());
    await expect(
      repo.applyAreaFactCommit({
        sessionId: "test-session",
        areaId: 1,
        factKey: "test-fact",
        valueJson: { data: true },
        sourceKind: "institutional_speech_act",
        exposureScope: "area_visible",
        sourceSettlementId: null,
        sourceAgentId: null,
        validTime: new Date(),
        committedTime: new Date(),
      }),
    ).rejects.toThrow("DEFERRED_SOURCE_KIND:");
  });

  it("allows lore_seed source kind", async () => {
    const repo = new AreaWorldProjectionRepo(makeNoopDb());
    await expect(
      repo.applyAreaFactCommit({
        sessionId: "test-session",
        areaId: 1,
        factKey: "test-fact",
        valueJson: { data: true },
        sourceKind: "lore_seed",
        exposureScope: "area_visible",
        sourceSettlementId: null,
        sourceAgentId: null,
        validTime: new Date(),
        committedTime: new Date(),
      }),
    ).resolves.toBeDefined();
  });
});
