import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { ProjectionManager } from "../../src/memory/projection/projection-manager.js";
import { SessionService } from "../../src/session/service.js";
import { PgAreaWorldProjectionRepo } from "../../src/storage/domain-repos/pg/area-world-projection-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

async function bootstrapAll(pool: postgres.Sql): Promise<void> {
  await bootstrapTruthSchema(pool);
  await bootstrapDerivedSchema(pool);
}

describe.skipIf(skipPgTests)("scene-fact-projection", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    sql = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(sql);
  });

  it("assigns monotonic event ids and links current rows to source event ids", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const repo = new PgAreaWorldProjectionRepo(pool);

      const t1 = new Date("2026-04-20T10:00:00.000Z");
      const t2 = new Date("2026-04-20T10:00:01.000Z");

      const area1 = await repo.applyAreaFactCommit({
        sessionId: "sess-1",
        areaId: 10,
        factKey: "status:gate",
        valueJson: { open: false },
        sourceKind: "system_event",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-1",
        sourceAgentId: "agent-1",
        validTime: t1,
        committedTime: t1,
      });
      const area2 = await repo.applyAreaFactCommit({
        sessionId: "sess-1",
        areaId: 10,
        factKey: "status:gate",
        valueJson: { open: true },
        sourceKind: "action_commitment",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-2",
        sourceAgentId: "agent-1",
        validTime: t2,
        committedTime: t2,
      });

      expect(area2.eventId > area1.eventId).toBeTrue();

      const areaCurrent = await pool`
        SELECT source_event_id
        FROM scene_area_fact_current
        WHERE session_id = 'sess-1' AND area_id = 10 AND fact_key = 'status:gate'
      `;
      expect(areaCurrent).toHaveLength(1);
      expect(BigInt(String(areaCurrent[0].source_event_id))).toBe(area2.eventId);

      const world1 = await repo.applyWorldFactCommit({
        sessionId: "sess-1",
        factKey: "location:artifact",
        valueJson: { holder: "bob" },
        sourceKind: "lore_seed",
        exposureScope: "world_public",
        sourceSettlementId: "stl-3",
        sourceAgentId: null,
        validTime: t1,
        committedTime: t1,
      });
      const world2 = await repo.applyWorldFactCommit({
        sessionId: "sess-1",
        factKey: "location:artifact",
        valueJson: { holder: "alice" },
        sourceKind: "action_commitment",
        exposureScope: "world_public",
        sourceSettlementId: "stl-4",
        sourceAgentId: "agent-1",
        validTime: t2,
        committedTime: t2,
      });

      expect(world2.eventId > world1.eventId).toBeTrue();

      const worldCurrent = await pool`
        SELECT source_event_id
        FROM scene_world_fact_current
        WHERE session_id = 'sess-1' AND fact_key = 'location:artifact'
      `;
      expect(worldCurrent).toHaveLength(1);
      expect(BigInt(String(worldCurrent[0].source_event_id))).toBe(world2.eventId);
    });
  });

  it("applies latest-wins: older commits are ignored and same-time higher event id wins", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const repo = new PgAreaWorldProjectionRepo(pool);

      const newer = new Date("2026-04-20T12:00:00.000Z");
      const older = new Date("2026-04-20T11:00:00.000Z");

      await repo.applyAreaFactCommit({
        sessionId: "sess-2",
        areaId: 7,
        factKey: "status:alarm",
        valueJson: { state: "armed" },
        sourceKind: "system_event",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-new",
        sourceAgentId: null,
        validTime: newer,
        committedTime: newer,
      });

      await repo.applyAreaFactCommit({
        sessionId: "sess-2",
        areaId: 7,
        factKey: "status:alarm",
        valueJson: { state: "disarmed" },
        sourceKind: "action_commitment",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-old",
        sourceAgentId: "agent-7",
        validTime: older,
        committedTime: older,
      });

      const areaFacts = await repo.getVisibleAreaFacts({
        sessionId: "sess-2",
        areaId: 7,
      });
      expect(areaFacts).toHaveLength(1);
      expect(areaFacts[0].valueJson).toEqual({ state: "armed" });

      const sameTime = new Date("2026-04-20T13:00:00.000Z");
      const first = await repo.applyWorldFactCommit({
        sessionId: "sess-2",
        factKey: "holder:relic",
        valueJson: { who: "alice" },
        sourceKind: "system_event",
        exposureScope: "world_public",
        sourceSettlementId: "stl-w1",
        sourceAgentId: null,
        validTime: sameTime,
        committedTime: sameTime,
      });
      const second = await repo.applyWorldFactCommit({
        sessionId: "sess-2",
        factKey: "holder:relic",
        valueJson: { who: "bob" },
        sourceKind: "action_commitment",
        exposureScope: "world_public",
        sourceSettlementId: "stl-w2",
        sourceAgentId: "agent-7",
        validTime: sameTime,
        committedTime: sameTime,
      });

      expect(second.eventId > first.eventId).toBeTrue();

      const worldFacts = await repo.getVisibleWorldFacts({ sessionId: "sess-2" });
      expect(worldFacts).toHaveLength(1);
      expect(worldFacts[0].valueJson).toEqual({ who: "bob" });
      expect(worldFacts[0].sourceEventId).toBe(second.eventId);
    });
  });

  it("filters system-only scene facts from visible reads", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const repo = new PgAreaWorldProjectionRepo(pool);
      const now = new Date("2026-04-20T14:00:00.000Z");

      await repo.applyAreaFactCommit({
        sessionId: "sess-3",
        areaId: 1,
        factKey: "status:door",
        valueJson: { state: "open" },
        sourceKind: "system_event",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-a1",
        sourceAgentId: null,
        validTime: now,
        committedTime: now,
      });
      await repo.applyAreaFactCommit({
        sessionId: "sess-3",
        areaId: 1,
        factKey: "status:trap",
        valueJson: { armed: true },
        sourceKind: "system_event",
        exposureScope: "system_only",
        sourceSettlementId: "stl-a2",
        sourceAgentId: null,
        validTime: now,
        committedTime: now,
      });

      const allArea = await repo.getVisibleAreaFacts({
        sessionId: "sess-3",
        areaId: 1,
      });
      const visibleArea = await repo.getVisibleAreaFacts({
        sessionId: "sess-3",
        areaId: 1,
        excludeSystemOnly: true,
      });
      expect(allArea).toHaveLength(2);
      expect(visibleArea).toHaveLength(1);
      expect(visibleArea[0].factKey).toBe("status:door");

      await repo.applyWorldFactCommit({
        sessionId: "sess-3",
        factKey: "location:crown",
        valueJson: { where: "vault" },
        sourceKind: "lore_seed",
        exposureScope: "world_public",
        sourceSettlementId: "stl-w1",
        sourceAgentId: null,
        validTime: now,
        committedTime: now,
      });
      await repo.applyWorldFactCommit({
        sessionId: "sess-3",
        factKey: "status:counterintel",
        valueJson: { active: true },
        sourceKind: "system_event",
        exposureScope: "system_only",
        sourceSettlementId: "stl-w2",
        sourceAgentId: null,
        validTime: now,
        committedTime: now,
      });

      const allWorld = await repo.getVisibleWorldFacts({ sessionId: "sess-3" });
      const visibleWorld = await repo.getVisibleWorldFacts({
        sessionId: "sess-3",
        excludeSystemOnly: true,
      });
      expect(allWorld).toHaveLength(2);
      expect(visibleWorld).toHaveLength(1);
      expect(visibleWorld[0].factKey).toBe("location:crown");
    });
  });

  it("rejects deferred source kinds before persisting scene fact rows", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const repo = new PgAreaWorldProjectionRepo(pool);
      const now = new Date("2026-04-20T14:30:00.000Z");

      await expect(
        repo.applyAreaFactCommit({
          sessionId: "sess-deferred-guard",
          areaId: 99,
          factKey: "status:lever",
          valueJson: { toggled: true },
          sourceKind: "evidence_reveal",
          exposureScope: "area_visible",
          sourceSettlementId: "stl-deferred-a",
          sourceAgentId: "agent-1",
          validTime: now,
          committedTime: now,
        }),
      ).rejects.toThrow("DEFERRED_SOURCE_KIND");

      await expect(
        repo.applyWorldFactCommit({
          sessionId: "sess-deferred-guard",
          factKey: "status:edict",
          valueJson: { active: true },
          sourceKind: "institutional_speech_act",
          exposureScope: "world_public",
          sourceSettlementId: "stl-deferred-w",
          sourceAgentId: "agent-1",
          validTime: now,
          committedTime: now,
        }),
      ).rejects.toThrow("DEFERRED_SOURCE_KIND");

      const areaRows = await pool`
        SELECT COUNT(*)::int AS c
        FROM scene_area_fact_events
        WHERE session_id = 'sess-deferred-guard'
      `;
      const worldRows = await pool`
        SELECT COUNT(*)::int AS c
        FROM scene_world_fact_events
        WHERE session_id = 'sess-deferred-guard'
      `;

      expect(areaRows[0].c).toBe(0);
      expect(worldRows[0].c).toBe(0);
    });
  });

  it("keeps legacy area/world state truth tables present", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);

      const rows = await pool`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('area_state_events', 'world_state_events')
        ORDER BY table_name ASC
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0].table_name).toBe("area_state_events");
      expect(rows[1].table_name).toBe("world_state_events");
    });
  });

  it("lore seed idempotency: applySceneSeedCommits twice keeps one current row per fact key", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const repo = new PgAreaWorldProjectionRepo(pool);
      const service = new SessionService();
      service.configureSceneSeedBootstrap({ areaWorldProjectionRepo: repo });

      const session = {
        sessionId: "sess-seed-idempotent",
        agentId: "rp:seed",
        createdAt: Date.parse("2026-04-20T15:00:00.000Z"),
      };
      const preparedSceneSeeds = [
        {
          scope: "area" as const,
          areaId: 33,
          factKey: "status:gate",
          value: { open: false },
          exposureScope: "area_visible" as const,
        },
      ];

      const applySceneSeedCommits = (
        service as unknown as {
          applySceneSeedCommits: (
            inputSession: {
              sessionId: string;
              agentId: string;
              createdAt: number;
            },
            seeds: Array<{
              scope: "area";
              areaId: number;
              factKey: string;
              value: unknown;
              exposureScope: "area_visible" | "system_only";
            }>,
          ) => Promise<void>;
        }
      ).applySceneSeedCommits.bind(service);

      await applySceneSeedCommits(session, preparedSceneSeeds);
      await applySceneSeedCommits(session, preparedSceneSeeds);

      const currentRows = await pool`
        SELECT COUNT(*)::int AS c
        FROM scene_area_fact_current
        WHERE session_id = ${session.sessionId}
          AND area_id = 33
          AND fact_key = 'status:gate'
      `;
      expect(currentRows[0].c).toBe(1);

      const eventRows = await pool`
        SELECT COUNT(*)::int AS c
        FROM scene_area_fact_events
        WHERE session_id = ${session.sessionId}
          AND area_id = 33
          AND fact_key = 'status:gate'
      `;
      expect(eventRows[0].c).toBe(2);
    });
  });

  it("graphStorage=null + no areaWorldProjectionRepo: sceneFactCommits become a no-op", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);

      const projectionManager = new ProjectionManager(
        { append: async () => 1 },
        { append: async () => 1 },
        { upsertFromEvent: async () => {} },
        null,
        null,
      );

      await projectionManager.commitSettlement({
        settlementId: "stl:scene-fact:no-op",
        sessionId: "sess:scene-fact:no-op",
        agentId: "rp:alice",
        cognitionOps: [],
        privateEpisodes: [],
        publications: [],
        recentCognitionSlotJson: "[]",
        upsertRecentCognitionSlot: async () => {},
        viewerSnapshot: { currentLocationEntityId: 99 },
        sceneFactWritePath: true,
        sceneFactCommits: [
          {
            scope: "area",
            factKey: "status:torch",
            value: { lit: true },
            sourceKind: "action_commitment",
            exposureScope: "area_visible",
          },
        ],
        committedAt: Date.parse("2026-04-20T16:00:00.000Z"),
      });

      const areaRows = await pool`
        SELECT COUNT(*)::int AS c
        FROM scene_area_fact_events
        WHERE session_id = 'sess:scene-fact:no-op'
      `;
      const worldRows = await pool`
        SELECT COUNT(*)::int AS c
        FROM scene_world_fact_events
        WHERE session_id = 'sess:scene-fact:no-op'
      `;
      expect(areaRows[0].c).toBe(0);
      expect(worldRows[0].c).toBe(0);
    });
  });

  it("tie-break: same committed_time chooses higher source_event_id in scene_area_fact_current", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const repo = new PgAreaWorldProjectionRepo(pool);

      const sameTime = new Date("2026-04-20T17:00:00.000Z");

      const first = await repo.applyAreaFactCommit({
        sessionId: "sess-tie-area",
        areaId: 9,
        factKey: "status:alarm",
        valueJson: { state: "armed" },
        sourceKind: "system_event",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-a-1",
        sourceAgentId: "agent-a",
        validTime: sameTime,
        committedTime: sameTime,
      });
      const second = await repo.applyAreaFactCommit({
        sessionId: "sess-tie-area",
        areaId: 9,
        factKey: "status:alarm",
        valueJson: { state: "disarmed" },
        sourceKind: "action_commitment",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-a-2",
        sourceAgentId: "agent-b",
        validTime: sameTime,
        committedTime: sameTime,
      });

      expect(second.eventId > first.eventId).toBeTrue();

      const areaFacts = await repo.getVisibleAreaFacts({
        sessionId: "sess-tie-area",
        areaId: 9,
      });
      expect(areaFacts).toHaveLength(1);
      expect(areaFacts[0].sourceEventId).toBe(second.eventId);
      expect(areaFacts[0].valueJson).toEqual({ state: "disarmed" });
    });
  });

  it("same-session cross-agent sharing: area fact written by agent-A is readable regardless of source agent", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const repo = new PgAreaWorldProjectionRepo(pool);
      const now = new Date("2026-04-20T18:10:00.000Z");

      await repo.applyAreaFactCommit({
        sessionId: "sess-cross-agent",
        areaId: 20,
        factKey: "status:lamp",
        valueJson: { state: "lit" },
        sourceKind: "action_commitment",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-cross-agent-1",
        sourceAgentId: "agent-A",
        validTime: now,
        committedTime: now,
      });

      const rows = await repo.getVisibleAreaFacts({
        sessionId: "sess-cross-agent",
        areaId: 20,
      });
      expect(rows).toHaveLength(1);
    });
  });

  it("ambiguous_action end-to-end: scene-fact write path is never reached when writeEligible=false", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const projectionManager = new ProjectionManager(
        { append: async () => 1 },
        { append: async () => 1 },
        { upsertFromEvent: async () => {} },
        null,
        new PgAreaWorldProjectionRepo(pool),
      );

      await projectionManager.commitSettlement({
        settlementId: "stl:ambiguous-action:guarded",
        sessionId: "sess-ambiguous-action-guarded",
        agentId: "rp:alice",
        cognitionOps: [],
        privateEpisodes: [],
        publications: [],
        recentCognitionSlotJson: "[]",
        upsertRecentCognitionSlot: async () => {},
        viewerSnapshot: { currentLocationEntityId: 20 },
        sceneFactWritePath: false,
        sceneFactCommits: [
          {
            scope: "area",
            factKey: "status:lamp",
            value: { state: "lit" },
            sourceKind: "action_commitment",
            exposureScope: "area_visible",
          },
        ],
        committedAt: Date.parse("2026-04-20T18:10:01.000Z"),
      });

      const areaRows = await pool`
        SELECT COUNT(*)::int AS c
        FROM scene_area_fact_events
        WHERE session_id = 'sess-ambiguous-action-guarded'
      `;
      expect(areaRows[0].c).toBe(0);
    });
  });
});
