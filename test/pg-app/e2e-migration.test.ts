import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { PgSearchRebuilder } from "../../src/memory/search-rebuild-pg.js";
import { TruthParityVerifier } from "../../src/migration/parity/truth-parity.js";
import { PgImporter } from "../../src/migration/pg-importer.js";
import { SqliteExporter } from "../../src/migration/sqlite-exporter.js";
import { runSessionMigrations } from "../../src/session/migrations.js";
import { PgBackendFactory } from "../../src/storage/backend-types.js";
import { openDatabase } from "../../src/storage/database.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import { PgSettlementUnitOfWork } from "../../src/storage/pg-settlement-uow.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

const describeWithSkipIf = describe as typeof describe & {
  skipIf: (condition: boolean) => typeof describe;
};

async function bootstrapAllSchemas(sql: postgres.Sql): Promise<void> {
  await bootstrapTruthSchema(sql);
  await bootstrapOpsSchema(sql);
  await bootstrapDerivedSchema(sql, { embeddingDim: 3 });
}

function seedSqliteSource(dbPath: string): void {
  const db = openDatabase({ path: dbPath });
  try {
    runInteractionMigrations(db);
    runMemoryMigrations(db);
    runSessionMigrations(db);

    const now = Date.now();

    db.run(
      `INSERT INTO sessions (session_id, agent_id, created_at, closed_at, recovery_required)
       VALUES (?, ?, ?, ?, ?)`,
      ["sess-seed", "agent-seed", now - 5000, null, 0],
    );

    db.run(
      `INSERT INTO interaction_records
         (session_id, record_id, record_index, actor_type, record_type, payload, correlated_turn_id, committed_at, is_processed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "sess-seed",
        "rec-seed-1",
        0,
        "user",
        "message",
        JSON.stringify({ text: "hello from sqlite seed" }),
        "req-seed-1",
        now - 4800,
        0,
      ],
    );

    db.run(
      `INSERT INTO recent_cognition_slots
         (session_id, agent_id, last_settlement_id, slot_payload, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        "sess-seed",
        "agent-seed",
        "stl-seed-1",
        JSON.stringify([
          {
            settlementId: "stl-seed-1",
            committedAt: now - 4200,
            kind: "evaluation",
            key: "cog:seed:mood",
            summary: "seed mood",
            status: "active",
          },
        ]),
        now - 4100,
      ],
    );

    db.run(
      `INSERT INTO settlement_processing_ledger
         (settlement_id, agent_id, payload_hash, status, attempt_count, max_attempts, claimed_by, claimed_at, applied_at, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "stl-seed-1",
        "agent-seed",
        "hash-seed-1",
        "applied",
        1,
        4,
        "agent-seed",
        now - 4500,
        now - 4400,
        null,
        now - 4600,
        now - 4300,
      ],
    );

    db.run(
      `INSERT INTO private_episode_events
         (agent_id, session_id, settlement_id, category, summary, private_notes, location_entity_id, location_text, valid_time, committed_time, source_local_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "agent-seed",
        "sess-seed",
        "stl-seed-1",
        "observation",
        "seed observation episode",
        "seed private notes",
        101,
        "Atrium",
        now - 4300,
        now - 4300,
        "seed-ep-1",
        now - 4300,
      ],
    );

    db.run(
      `INSERT INTO private_cognition_events
         (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "agent-seed",
        "cog:seed:mood",
        "evaluation",
        "upsert",
        JSON.stringify({ notes: "seed mood stable", meta: { a: 1, z: 2 } }),
        "stl-seed-1",
        now - 4200,
        now - 4200,
      ],
    );

    db.run(
      `INSERT INTO private_cognition_current
         (agent_id, cognition_key, kind, stance, basis, status, pre_contested_stance, conflict_summary, conflict_factor_refs_json, summary_text, record_json, source_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "agent-seed",
        "cog:seed:mood",
        "evaluation",
        null,
        null,
        "active",
        null,
        null,
        null,
        "evaluation: seed mood stable",
        JSON.stringify({ notes: "seed mood stable", meta: { z: 2, a: 1 } }),
        1,
        now - 4200,
      ],
    );

    db.run(
      `INSERT INTO area_state_events
         (agent_id, area_id, key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "agent-seed",
        101,
        "weather",
        JSON.stringify({ state: "sunny", wind: "light" }),
        "public_manifestation",
        "system",
        now - 4100,
        now - 4100,
        "stl-seed-1",
        now - 4100,
      ],
    );

    db.run(
      `INSERT INTO world_state_events
         (key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "season",
        JSON.stringify({ name: "spring", year: 3024 }),
        "public_manifestation",
        "system",
        now - 4050,
        now - 4050,
        "stl-seed-1",
        now - 4050,
      ],
    );

    db.run(
      `INSERT INTO area_state_current
         (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "agent-seed",
        101,
        "weather",
        JSON.stringify({ wind: "light", state: "sunny" }),
        "public_manifestation",
        "system",
        now - 4100,
        now - 4100,
        now - 4100,
      ],
    );

    db.run(
      `INSERT INTO world_state_current
         (key, value_json, surfacing_classification, updated_at, valid_time, committed_time)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "season",
        JSON.stringify({ year: 3024, name: "spring" }),
        "public_manifestation",
        now - 4050,
        now - 4050,
        now - 4050,
      ],
    );

    db.run(
      `INSERT INTO event_nodes
         (session_id, raw_text, summary, timestamp, created_at, participants, emotion, topic_id, visibility_scope, location_entity_id, event_category, primary_actor_entity_id, promotion_class, source_record_id, source_settlement_id, source_pub_index, event_origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "sess-seed",
        "seed raw event",
        "seed area event summary",
        now - 4300,
        now - 4300,
        "agent-seed,user",
        "calm",
        null,
        "area_visible",
        101,
        "observation",
        null,
        "none",
        "source-seed-1",
        "stl-seed-1",
        0,
        "runtime_projection",
      ],
    );

    db.run(
      `INSERT INTO event_nodes
         (session_id, raw_text, summary, timestamp, created_at, participants, emotion, topic_id, visibility_scope, location_entity_id, event_category, primary_actor_entity_id, promotion_class, source_record_id, source_settlement_id, source_pub_index, event_origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "sess-seed",
        "seed world event",
        "seed world event summary",
        now - 4250,
        now - 4250,
        "agent-seed",
        "focused",
        null,
        "world_public",
        101,
        "observation",
        null,
        "world_candidate",
        null,
        null,
        null,
        "promotion",
      ],
    );

    db.run(
      `INSERT INTO entity_nodes
         (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "seed:alice",
        "Alice Seed",
        "person",
        "private_overlay",
        "agent-seed",
        null,
        "Seed private entity",
        now - 4400,
        now - 4400,
      ],
    );

    db.run(
      `INSERT INTO entity_nodes
         (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "seed:garden",
        "Garden",
        "location",
        "shared_public",
        null,
        null,
        "Shared garden location",
        now - 4390,
        now - 4390,
      ],
    );

    db.run(
      `INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
       VALUES (?, ?, ?, ?)`,
      [1, "Alice", "name", "agent-seed"],
    );

    db.run(
      `INSERT INTO fact_edges
         (source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, 2, "located_at", now - 4300, Number.MAX_SAFE_INTEGER, now - 4300, Number.MAX_SAFE_INTEGER, 1],
    );

    db.run(
      `INSERT INTO memory_relations
         (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "event:1",
        "entity:1",
        "supports",
        0.8,
        "direct",
        "turn",
        "turn-seed-1",
        now - 4300,
        now - 4300,
      ],
    );

    db.run(
      `INSERT INTO core_memory_blocks
         (agent_id, label, description, value, char_limit, read_only, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["agent-seed", "user", null, "seed user memory", 2000, 0, now - 4200],
    );

  } finally {
    db.close();
  }
}

function seedSecondAgentSqliteSource(dbPath: string): void {
  const db = openDatabase({ path: dbPath });
  try {
    const now = Date.now();
    const agentId = "agent-seed-2";
    const sessionId = "sess-seed-2";
    const settlementId = "stl-seed-2";
    const cognitionKey = "cog:seed2:mood";

    db.run(
      `INSERT INTO sessions (session_id, agent_id, created_at, closed_at, recovery_required)
       VALUES (?, ?, ?, ?, ?)`,
      [sessionId, agentId, now - 3200, null, 0],
    );

    db.run(
      `INSERT INTO interaction_records
         (session_id, record_id, record_index, actor_type, record_type, payload, correlated_turn_id, committed_at, is_processed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        "rec-seed-2-1",
        0,
        "user",
        "message",
        JSON.stringify({ text: "hello from second seed agent" }),
        "req-seed-2-1",
        now - 3150,
        0,
      ],
    );

    db.run(
      `INSERT INTO recent_cognition_slots
         (session_id, agent_id, last_settlement_id, slot_payload, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        sessionId,
        agentId,
        settlementId,
        JSON.stringify([
          {
            settlementId,
            committedAt: now - 3000,
            kind: "evaluation",
            key: cognitionKey,
            summary: "second seed mood",
            status: "active",
          },
        ]),
        now - 2950,
      ],
    );

    db.run(
      `INSERT INTO settlement_processing_ledger
         (settlement_id, agent_id, payload_hash, status, attempt_count, max_attempts, claimed_by, claimed_at, applied_at, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        settlementId,
        agentId,
        "hash-seed-2",
        "applied",
        1,
        4,
        agentId,
        now - 3100,
        now - 3050,
        null,
        now - 3125,
        now - 3025,
      ],
    );

    db.run(
      `INSERT INTO private_episode_events
         (agent_id, session_id, settlement_id, category, summary, private_notes, location_entity_id, location_text, valid_time, committed_time, source_local_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId,
        sessionId,
        settlementId,
        "observation",
        "second seed observation episode",
        "second seed private notes",
        202,
        "Library",
        now - 3050,
        now - 3050,
        "seed-ep-2",
        now - 3050,
      ],
    );

    db.run(
      `INSERT INTO private_cognition_events
         (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId,
        cognitionKey,
        "evaluation",
        "upsert",
        JSON.stringify({ notes: "second seed mood stable", meta: { b: 2, y: 1 } }),
        settlementId,
        now - 3000,
        now - 3000,
      ],
    );

    db.run(
      `INSERT INTO private_cognition_current
         (agent_id, cognition_key, kind, stance, basis, status, pre_contested_stance, conflict_summary, conflict_factor_refs_json, summary_text, record_json, source_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId,
        cognitionKey,
        "evaluation",
        null,
        null,
        "active",
        null,
        null,
        null,
        "evaluation: second seed mood stable",
        JSON.stringify({ notes: "second seed mood stable", meta: { y: 1, b: 2 } }),
        2,
        now - 3000,
      ],
    );

    db.run(
      `INSERT INTO area_state_events
         (agent_id, area_id, key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId,
        202,
        "weather",
        JSON.stringify({ state: "cloudy", wind: "gentle" }),
        "public_manifestation",
        "system",
        now - 2950,
        now - 2950,
        settlementId,
        now - 2950,
      ],
    );

    db.run(
      `INSERT INTO area_state_current
         (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId,
        202,
        "weather",
        JSON.stringify({ wind: "gentle", state: "cloudy" }),
        "public_manifestation",
        "system",
        now - 2950,
        now - 2950,
        now - 2950,
      ],
    );

    db.run(
      `INSERT INTO world_state_events
         (key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "festival",
        JSON.stringify({ name: "lantern-night", day: 3 }),
        "public_manifestation",
        "system",
        now - 2900,
        now - 2900,
        settlementId,
        now - 2900,
      ],
    );

    db.run(
      `INSERT INTO world_state_current
         (key, value_json, surfacing_classification, updated_at, valid_time, committed_time)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "festival",
        JSON.stringify({ day: 3, name: "lantern-night" }),
        "public_manifestation",
        now - 2900,
        now - 2900,
        now - 2900,
      ],
    );

    db.run(
      `INSERT INTO event_nodes
         (session_id, raw_text, summary, timestamp, created_at, participants, emotion, topic_id, visibility_scope, location_entity_id, event_category, primary_actor_entity_id, promotion_class, source_record_id, source_settlement_id, source_pub_index, event_origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        "second seed raw event",
        "second seed area event summary",
        now - 3050,
        now - 3050,
        `${agentId},user`,
        "curious",
        null,
        "area_visible",
        202,
        "observation",
        null,
        "none",
        "source-seed-2-1",
        settlementId,
        0,
        "runtime_projection",
      ],
    );

    db.run(
      `INSERT INTO entity_nodes
         (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "seed:bob",
        "Bob Seed",
        "person",
        "private_overlay",
        agentId,
        null,
        "Second seed private entity",
        now - 3100,
        now - 3100,
      ],
    );

    const bobId = db.get<{ id: number }>(
      "SELECT id FROM entity_nodes WHERE pointer_key = ?",
      ["seed:bob"],
    )?.id;
    if (bobId == null) {
      throw new Error("seed:bob entity row was not created");
    }

    const gardenId =
      db.get<{ id: number }>("SELECT id FROM entity_nodes WHERE pointer_key = ?", ["seed:garden"])
        ?.id ?? null;
    const bobEventId =
      db.get<{ id: number }>(
        "SELECT id FROM event_nodes WHERE session_id = ? AND source_record_id = ?",
        [sessionId, "source-seed-2-1"],
      )?.id ?? null;

    db.run(
      `INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
       VALUES (?, ?, ?, ?)`,
      [bobId, "Bob", "name", agentId],
    );

    if (gardenId !== null && bobEventId !== null) {
      db.run(
        `INSERT INTO fact_edges
           (source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          bobId,
          gardenId,
          "located_at",
          now - 3050,
          Number.MAX_SAFE_INTEGER,
          now - 3050,
          Number.MAX_SAFE_INTEGER,
          bobEventId,
        ],
      );

      db.run(
        `INSERT INTO memory_relations
           (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `event:${bobEventId}`,
          `entity:${bobId}`,
          "supports",
          0.7,
          "direct",
          "turn",
          "turn-seed-2-1",
          now - 3050,
          now - 3050,
        ],
      );
    }

    db.run(
      `INSERT INTO core_memory_blocks
         (agent_id, label, description, value, char_limit, read_only, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [agentId, "user", null, "second seed user memory", 2000, 0, now - 3000],
    );
  } finally {
    db.close();
  }
}

function exportSqliteArtifact(sqlitePath: string, outDir: string): void {
  const exporter = new SqliteExporter({ dbPath: sqlitePath, outDir }, () => {});
  try {
    exporter.export();
  } finally {
    exporter.close();
  }
}

function withSearchPathPgUrl(baseUrl: string, schemaName: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("options", `-c search_path=${schemaName},public`);
  return url.toString();
}

describeWithSkipIf.skipIf(skipPgTests)(
  "e2e migration: export -> import -> parity -> boot -> turn",
  () => {
    let tempRoot = "";
    let sqlitePath = "";
    let exportDir = "";
    let pool: postgres.Sql;

    beforeAll(async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "maidsclaw-e2e-migration-"));
      sqlitePath = join(tempRoot, "source.sqlite");
      exportDir = join(tempRoot, "artifact");
      mkdirSync(exportDir, { recursive: true });

      seedSqliteSource(sqlitePath);
      exportSqliteArtifact(sqlitePath, exportDir);

      await ensureTestPgAppDb();
      pool = createTestPgAppPool();
    });

    afterAll(async () => {
      if (pool) {
        await teardownAppPool(pool);
      }
      if (tempRoot) {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    test(
      "seeds SQLite, migrates to PG, validates parity, boots PG backend, commits turn, and rebuilds search",
      async () => {
        await withTestAppSchema(pool, async (sql) => {
          await bootstrapAllSchemas(sql);

          const importer = new PgImporter(
            {
              manifestPath: join(exportDir, "manifest.json"),
              sql,
            },
            () => {},
          );
          await importer.import();

          const sqliteReadonly = new Database(sqlitePath, { readonly: true });
          try {
            const verifier = new TruthParityVerifier(sqliteReadonly, sql);
            const truthSurfaceResults = await verifier.verifyTruthPlane();
            expect(truthSurfaceResults.length).toBeGreaterThan(0);
            for (const surfaceResult of truthSurfaceResults) {
              expect(surfaceResult.mismatchCount).toBe(0);
              expect(surfaceResult.mismatches).toHaveLength(0);
            }
            const totalTruthMismatches = truthSurfaceResults.reduce(
              (sum, surface) => sum + surface.mismatchCount,
              0,
            );
            expect(totalTruthMismatches).toBe(0);
          } finally {
            sqliteReadonly.close();
          }

          const currentSchemaRows = await sql<{ schema_name: string }[]>`
            SELECT current_schema() AS schema_name
          `;
          const currentSchema = currentSchemaRows[0]?.schema_name;
          if (!currentSchema) {
            throw new Error("Unable to determine current PG schema for e2e migration test");
          }

          const basePgAppTestUrl = process.env.PG_APP_TEST_URL;
          if (!basePgAppTestUrl) {
            throw new Error("PG_APP_TEST_URL is required for bootFactory test");
          }

          const schemaScopedPgAppTestUrl = withSearchPathPgUrl(basePgAppTestUrl, currentSchema);

          const bootFactory = new PgBackendFactory();
          try {
            await bootFactory.initialize({
              type: "pg",
              pg: { url: schemaScopedPgAppTestUrl },
            });
            const bootPing = await bootFactory
              .getPool()
              .unsafe("SELECT 1::int AS ok") as Array<{ ok: number }>;
            expect(bootPing[0]?.ok).toBe(1);
          } finally {
            await bootFactory.close();
          }

          const uow = new PgSettlementUnitOfWork(sql);
          const settlementId = "stl-e2e-turn-1";
          const agentId = "agent-turn";
          let sessionId = "";
          const committedAt = Date.now();

          await uow.run(async (repos) => {
            const session = await repos.sessionRepo.createSession(agentId);
            sessionId = session.sessionId;

            await repos.settlementLedger.markApplying(
              settlementId,
              agentId,
              "hash-e2e-turn-1",
            );

            await repos.interactionRepo.commit({
              sessionId,
              recordId: settlementId,
              recordIndex: 0,
              actorType: "rp_agent",
              recordType: "turn_settlement",
              payload: {
                settlementId,
                requestId: "req-e2e-turn-1",
                sessionId,
                ownerAgentId: agentId,
                publicReply: "Turn committed in PG integration test",
                hasPublicReply: true,
                viewerSnapshot: {
                  selfPointerKey: "self",
                  userPointerKey: "user",
                  currentLocationEntityId: 101,
                },
              },
              correlatedTurnId: "req-e2e-turn-1",
              committedAt,
            });

            await repos.episodeRepo.append({
              agentId,
              sessionId,
              settlementId,
              category: "observation",
              summary: "integration turn episode",
              privateNotes: "turn-private-note",
              locationEntityId: 101,
              locationText: "Atrium",
              validTime: committedAt,
              committedTime: committedAt,
              sourceLocalRef: "turn-ep-1",
            });

            const cognitionRecordJson = JSON.stringify({
              notes: "integration turn cognition",
            });
            const cognitionEventId = await repos.cognitionEventRepo.append({
              agentId,
              cognitionKey: "cog:turn:1",
              kind: "evaluation",
              op: "upsert",
              recordJson: cognitionRecordJson,
              settlementId,
              committedTime: committedAt,
            });

            await repos.cognitionProjectionRepo.upsertFromEvent({
              id: cognitionEventId,
              agent_id: agentId,
              cognition_key: "cog:turn:1",
              kind: "evaluation",
              op: "upsert",
              record_json: cognitionRecordJson,
              settlement_id: settlementId,
              committed_time: committedAt,
              created_at: committedAt,
            });

            await repos.settlementLedger.markApplied(settlementId);
          });

          expect(sessionId.length).toBeGreaterThan(0);

          const settlementRows = await sql<{ status: string; attempt_count: number }[]>`
            SELECT status, attempt_count
            FROM settlement_processing_ledger
            WHERE settlement_id = ${settlementId}
          `;
          expect(settlementRows).toHaveLength(1);
          expect(settlementRows[0]?.status).toBe("applied");
          expect(settlementRows[0]?.attempt_count).toBe(1);

          const episodeRows = await sql<{ c: number }[]>`
            SELECT COUNT(*)::int AS c
            FROM private_episode_events
            WHERE settlement_id = ${settlementId}
          `;
          expect(episodeRows[0]?.c).toBe(1);

          const cognitionRows = await sql<{ c: number }[]>`
            SELECT COUNT(*)::int AS c
            FROM private_cognition_events
            WHERE settlement_id = ${settlementId}
          `;
          expect(cognitionRows[0]?.c).toBe(1);

          const interactionRows = await sql<{ c: number }[]>`
            SELECT COUNT(*)::int AS c
            FROM interaction_records
            WHERE session_id = ${sessionId}
              AND record_type = 'turn_settlement'
          `;
          expect(interactionRows[0]?.c).toBe(1);

          const searchRebuilder = new PgSearchRebuilder(sql);
          await searchRebuilder.rebuild({ scope: "all", agentId: "_all_agents" });

          const privateDocCount = await sql<{ c: number }[]>`
            SELECT COUNT(*)::int AS c FROM search_docs_private
          `;
          expect(privateDocCount[0]?.c).toBeGreaterThan(0);

          const queryableRows = await sql<{ c: number }[]>`
            SELECT COUNT(*)::int AS c
            FROM search_docs_private
            WHERE content ILIKE '%integration turn cognition%'
          `;
          expect(queryableRows[0]?.c).toBeGreaterThan(0);
        });
      },
      30_000,
    );

    test(
      "seeds multi-agent SQLite data and verifies export/import truth parity is zero mismatch",
      async () => {
        await withTestAppSchema(pool, async (sql) => {
          const multiRoot = mkdtempSync(join(tmpdir(), "maidsclaw-e2e-migration-multi-agent-"));
          const multiSqlitePath = join(multiRoot, "source.sqlite");
          const multiExportDir = join(multiRoot, "artifact");

          try {
            mkdirSync(multiExportDir, { recursive: true });
            seedSqliteSource(multiSqlitePath);
            seedSecondAgentSqliteSource(multiSqlitePath);
            exportSqliteArtifact(multiSqlitePath, multiExportDir);

            await bootstrapAllSchemas(sql);

            const importer = new PgImporter(
              {
                manifestPath: join(multiExportDir, "manifest.json"),
                sql,
              },
              () => {},
            );
            await importer.import();

            const sqliteReadonly = new Database(multiSqlitePath, { readonly: true });
            let truthSurfaceResults: Awaited<ReturnType<TruthParityVerifier["verifyTruthPlane"]>>;
            try {
              const verifier = new TruthParityVerifier(sqliteReadonly, sql);
              truthSurfaceResults = await verifier.verifyTruthPlane();
            } finally {
              sqliteReadonly.close();
            }

            expect(truthSurfaceResults.length).toBeGreaterThan(0);
            for (const surfaceResult of truthSurfaceResults) {
              expect(surfaceResult.mismatchCount).toBe(0);
              expect(surfaceResult.mismatches).toHaveLength(0);
            }

            const totalTruthMismatches = truthSurfaceResults.reduce(
              (sum, surface) => sum + surface.mismatchCount,
              0,
            );
            expect(totalTruthMismatches).toBe(0);

            const importedAgents = await sql<{ agent_id: string }[]>`
              SELECT DISTINCT agent_id
              FROM settlement_processing_ledger
              ORDER BY agent_id
            `;
            expect(importedAgents.map((row) => row.agent_id)).toEqual([
              "agent-seed",
              "agent-seed-2",
            ]);

            console.log(
              `[multi-agent truth parity] surfaces=${truthSurfaceResults.length}, mismatches=${totalTruthMismatches}`,
            );
          } finally {
            try {
              rmSync(multiRoot, { recursive: true, force: true });
            } catch {}
          }
        });
      },
      30_000,
    );
  },
);
