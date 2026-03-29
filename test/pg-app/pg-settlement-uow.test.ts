import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { ProjectionManager } from "../../src/memory/projection/projection-manager.js";
import { PgAreaWorldProjectionRepo } from "../../src/storage/domain-repos/pg/area-world-projection-repo.js";
import { PgCognitionEventRepo } from "../../src/storage/domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../../src/storage/domain-repos/pg/cognition-projection-repo.js";
import { PgEpisodeRepo } from "../../src/storage/domain-repos/pg/episode-repo.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import { PgSettlementUnitOfWork } from "../../src/storage/pg-settlement-uow.js";
import {
	createTestPgAppPool,
	ensureTestPgAppDb,
	teardownAppPool,
	withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";

const describeWithSkipIf = describe as typeof describe & {
	skipIf: (condition: boolean) => (name: string, fn: () => void) => void;
};

async function bootstrapSettlementProjectionTables(
	sql: postgres.Sql,
): Promise<void> {
	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS private_cognition_current (
			id                         BIGSERIAL PRIMARY KEY,
			agent_id                   TEXT NOT NULL,
			cognition_key              TEXT NOT NULL,
			kind                       TEXT NOT NULL,
			stance                     TEXT,
			basis                      TEXT,
			status                     TEXT DEFAULT 'active',
			pre_contested_stance       TEXT,
			conflict_summary           TEXT,
			conflict_factor_refs_json  JSONB,
			summary_text               TEXT,
			record_json                JSONB NOT NULL,
			source_event_id            BIGINT NOT NULL,
			updated_at                 BIGINT NOT NULL,
			UNIQUE(agent_id, cognition_key)
		)
	`);

	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS area_state_current (
			agent_id                  TEXT NOT NULL,
			area_id                   INTEGER NOT NULL,
			key                       TEXT NOT NULL,
			value_json                JSONB NOT NULL,
			surfacing_classification  TEXT NOT NULL,
			source_type               TEXT NOT NULL DEFAULT 'system',
			updated_at                BIGINT NOT NULL,
			valid_time                BIGINT,
			committed_time            BIGINT,
			PRIMARY KEY (agent_id, area_id, key)
		)
	`);
}

describeWithSkipIf.skipIf(!process.env.PG_APP_TEST_URL)(
	"PgSettlementUnitOfWork",
	() => {
		let pool: postgres.Sql;

		beforeAll(async () => {
			await ensureTestPgAppDb();
			pool = createTestPgAppPool();
		});

		afterAll(async () => {
			await teardownAppPool(pool);
		});

		it(
			"atomic commit: all writes visible after commit, reads within tx see writes",
			async () => {
			await withTestAppSchema(pool, async (sql) => {
				await bootstrapTruthSchema(sql);
				await bootstrapOpsSchema(sql);
				await bootstrapSettlementProjectionTables(sql);

				const uow = new PgSettlementUnitOfWork(sql);
				const projectionManager = new ProjectionManager(
					new PgEpisodeRepo(sql),
					new PgCognitionEventRepo(sql),
					new PgCognitionProjectionRepo(sql),
					null,
					new PgAreaWorldProjectionRepo(sql),
				);

				const settlementId = "stl:uow:atomic";
				const agentId = "rp:alice";
				let sessionId = "";

				await uow.run(async (repos) => {
					const session = await repos.sessionRepo.createSession(agentId);
					sessionId = session.sessionId;

					await repos.settlementLedger.markApplying(
						settlementId,
						agentId,
						"hash:atomic",
					);
					await repos.interactionRepo.commit({
						sessionId,
						recordId: settlementId,
						recordIndex: 0,
						actorType: "rp_agent",
						recordType: "turn_settlement",
						payload: { settlementId, sessionId, ownerAgentId: agentId },
						committedAt: 1_700_000_000_000,
					});

					await projectionManager.commitSettlement(
						{
							settlementId,
							sessionId,
							agentId,
							cognitionOps: [
								{
									op: "upsert",
									record: {
										kind: "assertion",
										key: "uow:atomic:belief",
										proposition: {
											subject: { kind: "special", value: "self" },
											predicate: "trusts",
											object: {
												kind: "entity",
												ref: { kind: "special", value: "user" },
											},
										},
										stance: "accepted",
										basis: "first_hand",
									},
								},
							],
							privateEpisodes: [
								{
									category: "observation",
									summary: "atomic episode",
									localRef: "ep:uow:atomic",
								},
							],
							publications: [],
							viewerSnapshot: { currentLocationEntityId: 42 },
							recentCognitionSlotJson: JSON.stringify([
								{
									settlementId,
									committedAt: 1_700_000_000_000,
									kind: "assertion",
									key: "uow:atomic:belief",
									summary: "self trusts user",
									status: "active",
								},
							]),
							areaStateArtifacts: [
								{
									key: "env.light",
									value: { state: "warm" },
									surfacingClassification: "latent_state_update",
								},
							],
							committedAt: 1_700_000_000_000,
						},
						{
							episodeRepo: repos.episodeRepo,
							cognitionEventRepo: repos.cognitionEventRepo,
							cognitionProjectionRepo: repos.cognitionProjectionRepo,
							areaWorldProjectionRepo: repos.areaWorldProjectionRepo,
							recentCognitionSlotRepo: repos.recentCognitionSlotRepo,
						},
					);

					const ledger =
						await repos.settlementLedger.getBySettlementId(settlementId);
					expect(ledger?.status).toBe("applying");

					const interactions =
						await repos.interactionRepo.getBySession(sessionId);
					expect(interactions).toHaveLength(1);

					const episodes = await repos.episodeRepo.readBySettlement(
						settlementId,
						agentId,
					);
					expect(episodes).toHaveLength(1);

					const cognitionEvents =
						await repos.cognitionEventRepo.readByCognitionKey(
							agentId,
							"uow:atomic:belief",
						);
					expect(cognitionEvents).toHaveLength(1);

					const cognitionCurrent =
						await repos.cognitionProjectionRepo.getCurrent(
							agentId,
							"uow:atomic:belief",
						);
					expect(cognitionCurrent).not.toBeNull();

					const areaState =
						await repos.areaWorldProjectionRepo.getAreaStateCurrent(
							agentId,
							42,
							"env.light",
						);
					expect(areaState).not.toBeNull();
				});

				expect(sessionId.length).toBeGreaterThan(0);

				const ledgerRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM settlement_processing_ledger
				WHERE settlement_id = ${settlementId}
			`;
				expect(ledgerRows[0].c).toBe(1);

				const interactionRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM interaction_records
				WHERE record_id = ${settlementId}
			`;
				expect(interactionRows[0].c).toBe(1);

				const episodeRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM private_episode_events
				WHERE settlement_id = ${settlementId}
			`;
				expect(episodeRows[0].c).toBe(1);

				const cognitionEventRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM private_cognition_events
				WHERE settlement_id = ${settlementId}
			`;
				expect(cognitionEventRows[0].c).toBe(1);

				const cognitionCurrentRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM private_cognition_current
				WHERE agent_id = ${agentId} AND cognition_key = 'uow:atomic:belief'
			`;
				expect(cognitionCurrentRows[0].c).toBe(1);

				const areaStateRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM area_state_current
				WHERE agent_id = ${agentId} AND area_id = 42 AND key = 'env.light'
			`;
				expect(areaStateRows[0].c).toBe(1);

				const slotRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM recent_cognition_slots
				WHERE session_id = ${sessionId} AND agent_id = ${agentId}
			`;
				expect(slotRows[0].c).toBe(1);
			});
			},
			20_000,
		);

		it(
			"rollback: injected error rolls back ALL writes atomically",
			async () => {
			await withTestAppSchema(pool, async (sql) => {
				await bootstrapTruthSchema(sql);
				await bootstrapOpsSchema(sql);
				await bootstrapSettlementProjectionTables(sql);

				const uow = new PgSettlementUnitOfWork(sql);
				const projectionManager = new ProjectionManager(
					new PgEpisodeRepo(sql),
					new PgCognitionEventRepo(sql),
					new PgCognitionProjectionRepo(sql),
					null,
					new PgAreaWorldProjectionRepo(sql),
				);

				const settlementId = "stl:uow:rollback";
				const agentId = "rp:alice";
				let sessionId = "";

				await expect(
					uow.run(async (repos) => {
						const session = await repos.sessionRepo.createSession(agentId);
						sessionId = session.sessionId;

						await repos.settlementLedger.markApplying(
							settlementId,
							agentId,
							"hash:rollback",
						);
						await repos.interactionRepo.commit({
							sessionId,
							recordId: settlementId,
							recordIndex: 0,
							actorType: "rp_agent",
							recordType: "turn_settlement",
							payload: { settlementId, sessionId, ownerAgentId: agentId },
							committedAt: 1_700_000_000_123,
						});

						await projectionManager.commitSettlement(
							{
								settlementId,
								sessionId,
								agentId,
								cognitionOps: [
									{
										op: "upsert",
										record: {
											kind: "assertion",
											key: "uow:rollback:belief",
											proposition: {
												subject: { kind: "special", value: "self" },
												predicate: "trusts",
												object: {
													kind: "entity",
													ref: { kind: "special", value: "user" },
												},
											},
											stance: "accepted",
											basis: "first_hand",
										},
									},
								],
								privateEpisodes: [
									{
										category: "observation",
										summary: "rollback episode",
										localRef: "ep:uow:rollback",
									},
								],
								publications: [],
								viewerSnapshot: { currentLocationEntityId: 42 },
								recentCognitionSlotJson: JSON.stringify([
									{
										settlementId,
										committedAt: 1_700_000_000_123,
										kind: "assertion",
										key: "uow:rollback:belief",
										summary: "self trusts user",
										status: "active",
									},
								]),
								areaStateArtifacts: [
									{
										key: "env.light",
										value: { state: "warm" },
										surfacingClassification: "latent_state_update",
									},
								],
								committedAt: 1_700_000_000_123,
							},
							{
								episodeRepo: repos.episodeRepo,
								cognitionEventRepo: repos.cognitionEventRepo,
								cognitionProjectionRepo: repos.cognitionProjectionRepo,
								areaWorldProjectionRepo: repos.areaWorldProjectionRepo,
								recentCognitionSlotRepo: repos.recentCognitionSlotRepo,
							},
						);

						throw new Error("injected rollback");
					}),
				).rejects.toThrow("injected rollback");

				expect(sessionId.length).toBeGreaterThan(0);

				const sessionRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM sessions
				WHERE session_id = ${sessionId}
			`;
				expect(sessionRows[0].c).toBe(0);

				const ledgerRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM settlement_processing_ledger
				WHERE settlement_id = ${settlementId}
			`;
				expect(ledgerRows[0].c).toBe(0);

				const interactionRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM interaction_records
				WHERE record_id = ${settlementId}
			`;
				expect(interactionRows[0].c).toBe(0);

				const episodeRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM private_episode_events
				WHERE settlement_id = ${settlementId}
			`;
				expect(episodeRows[0].c).toBe(0);

				const cognitionEventRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM private_cognition_events
				WHERE settlement_id = ${settlementId}
			`;
				expect(cognitionEventRows[0].c).toBe(0);

				const cognitionCurrentRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM private_cognition_current
				WHERE agent_id = ${agentId} AND cognition_key = 'uow:rollback:belief'
			`;
				expect(cognitionCurrentRows[0].c).toBe(0);

				const areaStateRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM area_state_current
				WHERE agent_id = ${agentId} AND area_id = 42 AND key = 'env.light'
			`;
				expect(areaStateRows[0].c).toBe(0);

				const slotRows = await sql`
				SELECT COUNT(*)::int AS c
				FROM recent_cognition_slots
				WHERE session_id = ${sessionId} AND agent_id = ${agentId}
			`;
				expect(slotRows[0].c).toBe(0);
			});
			},
			20_000,
		);
	},
);
