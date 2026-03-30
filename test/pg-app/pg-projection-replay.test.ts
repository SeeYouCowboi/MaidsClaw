import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgProjectionRebuilder } from "../../src/migration/pg-projection-rebuild.js";
import { PgAreaWorldProjectionRepo } from "../../src/storage/domain-repos/pg/area-world-projection-repo.js";
import { PgCognitionProjectionRepo } from "../../src/storage/domain-repos/pg/cognition-projection-repo.js";
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

describe.skipIf(skipPgTests)(
  "pg-projection-replay",
  () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
      await ensureTestPgAppDb();
      sql = createTestPgAppPool();
    });

    afterAll(async () => {
      await teardownAppPool(sql);
    });

    it("rebuilds cognition current from assertion events (latest stance wins)", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        await pool`
          INSERT INTO private_cognition_events
            (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
          VALUES
            ('agent-1', 'belief:sky', 'assertion', 'upsert',
             ${pool.json({ predicate: "color_of", sourcePointerKey: "sky", targetPointerKey: "blue", stance: "tentative", basis: "first_hand" } as never)},
             'settle-1', 1000, 1000)
        `;
        await pool`
          INSERT INTO private_cognition_events
            (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
          VALUES
            ('agent-1', 'belief:sky', 'assertion', 'upsert',
             ${pool.json({ predicate: "color_of", sourcePointerKey: "sky", targetPointerKey: "blue", stance: "confirmed", basis: "first_hand" } as never)},
             'settle-2', 2000, 2000)
        `;

        const rebuilder = new PgProjectionRebuilder(pool);
        await rebuilder.rebuildCognitionCurrent("agent-1");

        const repo = new PgCognitionProjectionRepo(pool);
        const row = await repo.getCurrent("agent-1", "belief:sky");
        expect(row).not.toBeNull();
        expect(row!.stance).toBe("confirmed");
        expect(row!.kind).toBe("assertion");
        expect(row!.status).toBe("active");
      });
    });

    it("cognition rebuild handles retract events", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        await pool`
          INSERT INTO private_cognition_events
            (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
          VALUES
            ('agent-1', 'mood:happy', 'evaluation', 'upsert',
             ${pool.json({ notes: "feeling great" } as never)},
             'settle-1', 1000, 1000)
        `;
        await pool`
          INSERT INTO private_cognition_events
            (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
          VALUES
            ('agent-1', 'mood:happy', 'evaluation', 'retract', ${null},
             'settle-2', 2000, 2000)
        `;

        const rebuilder = new PgProjectionRebuilder(pool);
        await rebuilder.rebuildCognitionCurrent("agent-1");

        const repo = new PgCognitionProjectionRepo(pool);
        const row = await repo.getCurrent("agent-1", "mood:happy");
        expect(row).not.toBeNull();
        expect(row!.status).toBe("retracted");
      });
    });

    it("cognition rebuild without agentId rebuilds all agents", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        await pool`
          INSERT INTO private_cognition_events
            (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
          VALUES
            ('agent-a', 'fact:1', 'assertion', 'upsert',
             ${pool.json({ predicate: "knows", sourcePointerKey: "a", targetPointerKey: "b", stance: "tentative" } as never)},
             'settle-1', 1000, 1000)
        `;
        await pool`
          INSERT INTO private_cognition_events
            (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
          VALUES
            ('agent-b', 'fact:2', 'commitment', 'upsert',
             ${pool.json({ mode: "goal", target: "clean room", status: "active" } as never)},
             'settle-2', 2000, 2000)
        `;

        const rebuilder = new PgProjectionRebuilder(pool);
        await rebuilder.rebuildCognitionCurrent();

        const repo = new PgCognitionProjectionRepo(pool);
        const rowA = await repo.getCurrent("agent-a", "fact:1");
        const rowB = await repo.getCurrent("agent-b", "fact:2");
        expect(rowA).not.toBeNull();
        expect(rowA!.kind).toBe("assertion");
        expect(rowB).not.toBeNull();
        expect(rowB!.kind).toBe("commitment");
      });
    });

    it("rebuilds area state current from events (latest per key)", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        await pool`
          INSERT INTO area_state_events
            (agent_id, area_id, key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
          VALUES
            ('agent-1', 1, 'weather', ${pool.json({ condition: "cloudy" } as never)},
             'public_manifestation', 'system', 1000, 1000, 'settle-1', 1000)
        `;
        await pool`
          INSERT INTO area_state_events
            (agent_id, area_id, key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
          VALUES
            ('agent-1', 1, 'weather', ${pool.json({ condition: "sunny" } as never)},
             'public_manifestation', 'system', 2000, 2000, 'settle-2', 2000)
        `;
        await pool`
          INSERT INTO area_state_events
            (agent_id, area_id, key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
          VALUES
            ('agent-1', 1, 'temperature', ${pool.json({ degrees: 25 } as never)},
             'latent_state_update', 'system', 3000, 3000, 'settle-3', 3000)
        `;

        const rebuilder = new PgProjectionRebuilder(pool);
        await rebuilder.rebuildAreaStateCurrent("agent-1", 1);

        const repo = new PgAreaWorldProjectionRepo(pool);
        const weather = await repo.getAreaStateCurrent("agent-1", 1, "weather");
        expect(weather).not.toBeNull();
        expect(JSON.parse(weather!.value_json)).toEqual({ condition: "sunny" });
        expect(weather!.updated_at).toBe(2000);

        const temp = await repo.getAreaStateCurrent("agent-1", 1, "temperature");
        expect(temp).not.toBeNull();
        expect(JSON.parse(temp!.value_json)).toEqual({ degrees: 25 });
      });
    });

    it("area rebuild without filters rebuilds all agents and areas", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        await pool`
          INSERT INTO area_state_events
            (agent_id, area_id, key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
          VALUES
            ('agent-1', 1, 'k1', ${pool.json({ v: 1 } as never)},
             'public_manifestation', 'system', 1000, 1000, 'settle-1', 1000),
            ('agent-2', 2, 'k2', ${pool.json({ v: 2 } as never)},
             'public_manifestation', 'system', 2000, 2000, 'settle-2', 2000)
        `;

        const rebuilder = new PgProjectionRebuilder(pool);
        await rebuilder.rebuildAreaStateCurrent();

        const repo = new PgAreaWorldProjectionRepo(pool);
        expect(await repo.getAreaStateCurrent("agent-1", 1, "k1")).not.toBeNull();
        expect(await repo.getAreaStateCurrent("agent-2", 2, "k2")).not.toBeNull();
      });
    });

    it("rebuilds world state current from events (latest per key)", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        await pool`
          INSERT INTO world_state_events
            (key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
          VALUES
            ('time_of_day', ${pool.json({ period: "morning" } as never)},
             'public_manifestation', 'system', 1000, 1000, 'settle-1', 1000)
        `;
        await pool`
          INSERT INTO world_state_events
            (key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
          VALUES
            ('time_of_day', ${pool.json({ period: "afternoon" } as never)},
             'public_manifestation', 'system', 2000, 2000, 'settle-2', 2000)
        `;
        await pool`
          INSERT INTO world_state_events
            (key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
          VALUES
            ('season', ${pool.json({ name: "summer" } as never)},
             'public_manifestation', 'system', 1500, 1500, 'settle-3', 1500)
        `;

        const rebuilder = new PgProjectionRebuilder(pool);
        await rebuilder.rebuildWorldStateCurrent();

        const repo = new PgAreaWorldProjectionRepo(pool);
        const time = await repo.getWorldStateCurrent("time_of_day");
        expect(time).not.toBeNull();
        expect(JSON.parse(time!.value_json)).toEqual({ period: "afternoon" });
        expect(time!.updated_at).toBe(2000);

        const season = await repo.getWorldStateCurrent("season");
        expect(season).not.toBeNull();
        expect(JSON.parse(season!.value_json)).toEqual({ name: "summer" });
      });
    });

    it("rebuildAll rebuilds all three projection surfaces", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        await pool`
          INSERT INTO private_cognition_events
            (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
          VALUES
            ('agent-1', 'key:1', 'assertion', 'upsert',
             ${pool.json({ predicate: "p", sourcePointerKey: "s", targetPointerKey: "t", stance: "tentative" } as never)},
             'settle-1', 1000, 1000)
        `;
        await pool`
          INSERT INTO area_state_events
            (agent_id, area_id, key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
          VALUES
            ('agent-1', 1, 'area-k', ${pool.json({ a: 1 } as never)},
             'public_manifestation', 'system', 1000, 1000, 'settle-1', 1000)
        `;
        await pool`
          INSERT INTO world_state_events
            (key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
          VALUES
            ('world-k', ${pool.json({ w: 1 } as never)},
             'public_manifestation', 'system', 1000, 1000, 'settle-1', 1000)
        `;

        const rebuilder = new PgProjectionRebuilder(pool);
        await rebuilder.rebuildAll();

        const cogRepo = new PgCognitionProjectionRepo(pool);
        expect(await cogRepo.getCurrent("agent-1", "key:1")).not.toBeNull();

        const awRepo = new PgAreaWorldProjectionRepo(pool);
        expect(await awRepo.getAreaStateCurrent("agent-1", 1, "area-k")).not.toBeNull();
        expect(await awRepo.getWorldStateCurrent("world-k")).not.toBeNull();
      });
    });

    it("rebuild produces same state as direct repo upserts (parity)", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        const awRepo = new PgAreaWorldProjectionRepo(pool);
        await awRepo.upsertAreaStateCurrent({
          agentId: "agent-1",
          areaId: 1,
          key: "color",
          value: { hue: "red" },
          surfacingClassification: "public_manifestation",
          updatedAt: 1000,
          validTime: 1000,
          committedTime: 1000,
          settlementId: "settle-1",
        });
        await awRepo.upsertAreaStateCurrent({
          agentId: "agent-1",
          areaId: 1,
          key: "color",
          value: { hue: "green" },
          surfacingClassification: "public_manifestation",
          updatedAt: 2000,
          validTime: 2000,
          committedTime: 2000,
          settlementId: "settle-2",
        });

        await awRepo.upsertWorldStateCurrent({
          key: "epoch",
          value: { era: "bronze" },
          surfacingClassification: "public_manifestation",
          updatedAt: 1000,
          committedTime: 1000,
          settlementId: "settle-w1",
        });
        await awRepo.upsertWorldStateCurrent({
          key: "epoch",
          value: { era: "iron" },
          surfacingClassification: "public_manifestation",
          updatedAt: 2000,
          committedTime: 2000,
          settlementId: "settle-w2",
        });

        const directArea = await awRepo.getAreaStateCurrent("agent-1", 1, "color");
        const directWorld = await awRepo.getWorldStateCurrent("epoch");

        const rebuilder = new PgProjectionRebuilder(pool);
        await rebuilder.rebuildAreaStateCurrent("agent-1", 1);
        await rebuilder.rebuildWorldStateCurrent();

        const rebuiltArea = await awRepo.getAreaStateCurrent("agent-1", 1, "color");
        const rebuiltWorld = await awRepo.getWorldStateCurrent("epoch");

        expect(JSON.parse(rebuiltArea!.value_json)).toEqual(JSON.parse(directArea!.value_json));
        expect(rebuiltArea!.surfacing_classification).toBe(directArea!.surfacing_classification);
        expect(rebuiltArea!.committed_time).toBe(directArea!.committed_time);

        expect(JSON.parse(rebuiltWorld!.value_json)).toEqual(JSON.parse(directWorld!.value_json));
        expect(rebuiltWorld!.surfacing_classification).toBe(directWorld!.surfacing_classification);
        expect(rebuiltWorld!.committed_time).toBe(directWorld!.committed_time);
      });
    });
  },
);
