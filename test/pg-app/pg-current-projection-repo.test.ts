import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { CognitionEventRow } from "../../src/memory/cognition/cognition-event-repo.js";
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
  "pg-current-projection-repos",
  () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
      await ensureTestPgAppDb();
      sql = createTestPgAppPool();
    });

    afterAll(async () => {
      await teardownAppPool(sql);
    });

    it("upserts cognition current from assertion event and reads back", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        const repo = new PgCognitionProjectionRepo(pool);
        const event: CognitionEventRow = {
          id: 1,
          agent_id: "agent-1",
          cognition_key: "user:trusts_us",
          kind: "assertion",
          op: "upsert",
          record_json: JSON.stringify({
            predicate: "trusts",
            sourcePointerKey: "user:alice",
            targetPointerKey: "self",
            stance: "tentative",
            basis: "observed behavior",
          }),
          settlement_id: "settle-1",
          committed_time: 1000,
          created_at: 1000,
        };

        await repo.upsertFromEvent(event);
        const row = await repo.getCurrent("agent-1", "user:trusts_us");

        expect(row).not.toBeNull();
        expect(row!.agent_id).toBe("agent-1");
        expect(row!.cognition_key).toBe("user:trusts_us");
        expect(row!.kind).toBe("assertion");
        expect(row!.stance).toBe("tentative");
        expect(row!.basis).toBe("observed behavior");
        expect(row!.status).toBe("active");
        expect(row!.updated_at).toBe(1000);
        expect(row!.source_event_id).toBe(1);
      });
    });

    it("upsert replaces on conflict for same cognition_key", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        const repo = new PgCognitionProjectionRepo(pool);

        const event1: CognitionEventRow = {
          id: 1,
          agent_id: "agent-1",
          cognition_key: "mood:cheerful",
          kind: "evaluation",
          op: "upsert",
          record_json: JSON.stringify({ notes: "seems happy" }),
          settlement_id: "settle-1",
          committed_time: 1000,
          created_at: 1000,
        };

        const event2: CognitionEventRow = {
          id: 2,
          agent_id: "agent-1",
          cognition_key: "mood:cheerful",
          kind: "evaluation",
          op: "upsert",
          record_json: JSON.stringify({ notes: "still cheerful" }),
          settlement_id: "settle-2",
          committed_time: 2000,
          created_at: 2000,
        };

        await repo.upsertFromEvent(event1);
        await repo.upsertFromEvent(event2);

        const row = await repo.getCurrent("agent-1", "mood:cheerful");
        expect(row).not.toBeNull();
        expect(row!.summary_text).toBe("evaluation: still cheerful");
        expect(row!.updated_at).toBe(2000);
        expect(row!.source_event_id).toBe(2);

        const all = await repo.getAllCurrent("agent-1");
        expect(all.length).toBe(1);
      });
    });

    it("upserts area state and queries by agent and area", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        const repo = new PgAreaWorldProjectionRepo(pool);

        await repo.upsertAreaStateCurrent({
          agentId: "agent-1",
          areaId: 42,
          key: "weather",
          value: { condition: "sunny" },
          surfacingClassification: "public_manifestation",
          sourceType: "system",
          updatedAt: 5000,
          validTime: 5000,
          committedTime: 5000,
          settlementId: "settle-area-1",
        });

        const row = await repo.getAreaStateCurrent("agent-1", 42, "weather");
        expect(row).not.toBeNull();
        expect(row!.agent_id).toBe("agent-1");
        expect(row!.area_id).toBe(42);
        expect(row!.key).toBe("weather");
        expect(JSON.parse(row!.value_json)).toEqual({ condition: "sunny" });
        expect(row!.surfacing_classification).toBe("public_manifestation");
        expect(row!.source_type).toBe("system");
        expect(row!.updated_at).toBe(5000);

        const none = await repo.getAreaStateCurrent("agent-1", 99, "weather");
        expect(none).toBeNull();
      });
    });

    it("upsert area state replaces on conflict", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        const repo = new PgAreaWorldProjectionRepo(pool);

        await repo.upsertAreaStateCurrent({
          agentId: "agent-1",
          areaId: 1,
          key: "temperature",
          value: { degrees: 20 },
          surfacingClassification: "latent_state_update",
          updatedAt: 1000,
          committedTime: 1000,
        });

        await repo.upsertAreaStateCurrent({
          agentId: "agent-1",
          areaId: 1,
          key: "temperature",
          value: { degrees: 25 },
          surfacingClassification: "latent_state_update",
          updatedAt: 2000,
          committedTime: 2000,
        });

        const row = await repo.getAreaStateCurrent("agent-1", 1, "temperature");
        expect(row).not.toBeNull();
        expect(JSON.parse(row!.value_json)).toEqual({ degrees: 25 });
        expect(row!.updated_at).toBe(2000);
      });
    });

    it("upserts world state and queries global state", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        const repo = new PgAreaWorldProjectionRepo(pool);

        await repo.upsertWorldStateCurrent({
          key: "time_of_day",
          value: { period: "afternoon" },
          surfacingClassification: "public_manifestation",
          updatedAt: 3000,
          committedTime: 3000,
        });

        const row = await repo.getWorldStateCurrent("time_of_day");
        expect(row).not.toBeNull();
        expect(row!.key).toBe("time_of_day");
        expect(JSON.parse(row!.value_json)).toEqual({ period: "afternoon" });
        expect(row!.surfacing_classification).toBe("public_manifestation");
        expect(row!.updated_at).toBe(3000);

        const none = await repo.getWorldStateCurrent("nonexistent");
        expect(none).toBeNull();
      });
    });

    it("upserts world state replaces on conflict", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapAll(pool);

        const repo = new PgAreaWorldProjectionRepo(pool);

        await repo.upsertWorldStateCurrent({
          key: "season",
          value: { name: "spring" },
          surfacingClassification: "public_manifestation",
          updatedAt: 1000,
          committedTime: 1000,
        });

        await repo.upsertWorldStateCurrent({
          key: "season",
          value: { name: "summer" },
          surfacingClassification: "public_manifestation",
          updatedAt: 2000,
          committedTime: 2000,
        });

        const row = await repo.getWorldStateCurrent("season");
        expect(row).not.toBeNull();
        expect(JSON.parse(row!.value_json)).toEqual({ name: "summer" });
        expect(row!.updated_at).toBe(2000);
      });
    });
  },
);
