import { describe, expect, it } from "bun:test";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { getRecentCognition } from "../../src/memory/prompt-data.js";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import { CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import { PrivateCognitionProjectionRepo } from "../../src/memory/cognition/private-cognition-current.js";
import { ExplicitSettlementProcessor } from "../../src/memory/explicit-settlement-processor.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import type { IngestionInput, CreatedState, MemoryFlushRequest } from "../../src/memory/task-agent.js";
import type { PrivateCognitionCommitV4 } from "../../src/runtime/rp-turn-contract.js";
import {
	cleanupDb,
	createTempDb,
	seedStandardEntities,
} from "../helpers/memory-test-utils.js";

const AGENT_ID = "rp:alice";

function upsertAcceptedThenContested(repo: CognitionRepository, cognitionKey: string): void {
	repo.upsertAssertion({
		agentId: AGENT_ID,
		cognitionKey,
		settlementId: `${cognitionKey}:accepted`,
		opIndex: 0,
		sourcePointerKey: "__self__",
		predicate: "trusts",
		targetPointerKey: "bob",
		stance: "accepted",
		basis: "first_hand",
	});

	repo.upsertAssertion({
		agentId: AGENT_ID,
		cognitionKey,
		settlementId: `${cognitionKey}:contested`,
		opIndex: 0,
		sourcePointerKey: "__self__",
		predicate: "trusts",
		targetPointerKey: "bob",
		stance: "contested",
		basis: "first_hand",
		preContestedStance: "accepted",
	});
}

function insertRecentCognitionSlot(
	db: { run: (sql: string, params?: unknown[]) => unknown },
	sessionId: string,
	agentId: string,
	entries: unknown[],
): void {
	db.run(
		"INSERT OR REPLACE INTO recent_cognition_slots (session_id, agent_id, last_settlement_id, slot_payload, updated_at) VALUES (?, ?, ?, ?, ?)",
		[sessionId, agentId, "stl:contested-slot", JSON.stringify(entries), Date.now()],
	);
}

describe("V2 validation: contested cognition", () => {
	it("contested summary display stores contested stance and previous stance", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		try {
			const repo = new CognitionRepository(db);
			const projection = new PrivateCognitionProjectionRepo(db);
			const cognitionKey = "v2:contest:summary-display";

			upsertAcceptedThenContested(repo, cognitionKey);
			projection.rebuild(AGENT_ID);

			const current = projection.getCurrent(AGENT_ID, cognitionKey);
			expect(current).not.toBeNull();
			expect(current!.stance).toBe("contested");
			expect(current!.pre_contested_stance).toBe("accepted");
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("pre_contested_stance remains traceable to the previous accepted stance", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		try {
			const repo = new CognitionRepository(db);
			const projection = new PrivateCognitionProjectionRepo(db);
			const cognitionKey = "v2:contest:pre-stance";

			upsertAcceptedThenContested(repo, cognitionKey);
			projection.rebuild(AGENT_ID);

			const row = db.get<{ pre_contested_stance: string | null }>(
				"SELECT pre_contested_stance FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ?",
				[AGENT_ID, cognitionKey],
			);

			expect(row).toBeDefined();
			expect(row!.pre_contested_stance).toBe("accepted");
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("direct contested upsert falls back to contested cognition evidence (known bug path)", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		try {
			const repo = new CognitionRepository(db);
			const search = new CognitionSearchService(db);
			const cognitionKey = "v2:contest:direct-fallback";

			upsertAcceptedThenContested(repo, cognitionKey);

			const currentRow = db.get<{ conflict_factor_refs_json: string | null }>(
				"SELECT conflict_factor_refs_json FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ?",
				[AGENT_ID, cognitionKey],
			);

			const hits = search.searchCognition({
				agentId: AGENT_ID,
				kind: "assertion",
				stance: "contested",
			});

			const contestedHit = hits.find((hit) => hit.cognitionKey === cognitionKey) ?? hits[0];

			// Known limitation: direct contested path lacks factor refs — see V2 Batch 1 validation report
			expect(currentRow?.conflict_factor_refs_json ?? null).toBeNull();
			expect(contestedHit).toBeDefined();
			expect(Array.isArray(contestedHit!.conflictEvidence)).toBe(true);
			expect(contestedHit!.conflictEvidence).toEqual([]);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("CognitionSearch enriches contested hits with stance and conflict evidence array", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		try {
			const repo = new CognitionRepository(db);
			const search = new CognitionSearchService(db);
			const cognitionKey = "v2:contest:search-enrich";

			upsertAcceptedThenContested(repo, cognitionKey);

			const hits = search.searchCognition({
				agentId: AGENT_ID,
				kind: "assertion",
			});

			const contestedHit = hits.find((hit) => hit.cognitionKey === cognitionKey);
			expect(contestedHit).toBeDefined();
			expect(contestedHit!.stance).toBe("contested");
			expect(Array.isArray(contestedHit!.conflictEvidence)).toBe(true);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("default retrieval output keeps contested summary concise without full conflict chain", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);
		runInteractionMigrations(db);

		try {
			const repo = new CognitionRepository(db);
			const projection = new PrivateCognitionProjectionRepo(db);
			const cognitionKey = "v2:contest:retrieval-compact";
			const sessionId = "sess:contest:compact";

			upsertAcceptedThenContested(repo, cognitionKey);
			projection.rebuild(AGENT_ID);

			const current = projection.getCurrent(AGENT_ID, cognitionKey);
			expect(current).not.toBeNull();

			insertRecentCognitionSlot(db, sessionId, AGENT_ID, [
				{
					settlementId: "stl:contest:compact",
					committedAt: Date.now(),
					kind: "assertion",
					key: cognitionKey,
					summary: current!.summary_text ?? "trusts: __self__ → bob",
					status: "active",
					stance: "contested",
					preContestedStance: current!.pre_contested_stance ?? "accepted",
					conflictSummary: current!.conflict_summary ?? "contested cognition",
					conflictFactorRefs: current!.conflict_factor_refs_json
						? JSON.parse(current!.conflict_factor_refs_json)
						: [],
				},
			]);

			const output = getRecentCognition(AGENT_ID, sessionId, db);
			expect(output).toContain("[CONTESTED: was accepted]");
			expect(output).not.toMatch(/memory_relations|evidence_path.*conflicts_with/);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("settlement conflict-factors path populates conflict_summary in private_cognition_current", async () => {
		const { db, dbPath } = createTempDb();
		const { locationId } = seedStandardEntities(db);
		runInteractionMigrations(db);

		try {
			const storage = new GraphStorageService(db);
			const repo = new CognitionRepository(db);
			const projection = new PrivateCognitionProjectionRepo(db);

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "v2:contest:settlement",
				settlementId: "stl:settlement:seed",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			projection.rebuild(AGENT_ID);

			repo.upsertCommitment({
				agentId: AGENT_ID,
				cognitionKey: "v2:contest:factor-commit",
				settlementId: "stl:settlement:factor",
				opIndex: 0,
				mode: "goal",
				target: { action: "observe bob" },
				status: "active",
			});

			const processor = new ExplicitSettlementProcessor(
				db.raw,
				storage,
				{ chat: async () => [] },
				() => ({ entities: [], privateBeliefs: [] }),
				() => {},
			);

			const requestId = "req:v2:contest:settlement";
			const settlementId = "stl:v2:contest:settlement";
			const privateCognition: PrivateCognitionCommitV4 = {
				schemaVersion: "rp_private_cognition_v4",
				ops: [
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "v2:contest:settlement",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "trusts",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "contested",
							basis: "first_hand",
							preContestedStance: "accepted",
						},
					},
				],
			};

			const payload: TurnSettlementPayload = {
				settlementId,
				requestId,
				sessionId: "sess:v2:contest:settlement",
				ownerAgentId: AGENT_ID,
				publicReply: "",
				hasPublicReply: false,
				viewerSnapshot: {
					selfPointerKey: "__self__",
					userPointerKey: "__user__",
					currentLocationEntityId: locationId,
				},
				privateCognition,
				conflictFactors: [{ kind: "cognition", ref: "v2:contest:factor-commit" }],
			};

			const explicitMeta = {
				settlementId,
				requestId,
				ownerAgentId: AGENT_ID,
				privateCognition,
			};

			const ingestion: IngestionInput = {
				batchId: "batch:v2:contest:settlement",
				agentId: AGENT_ID,
				sessionId: "sess:v2:contest:settlement",
				dialogue: [],
				attachments: [{
					recordType: "turn_settlement",
					payload,
					committedAt: Date.now(),
					correlatedTurnId: requestId,
					explicitMeta,
				}],
				explicitSettlements: [explicitMeta],
			};

			const flushRequest: MemoryFlushRequest = {
				sessionId: "sess:v2:contest:settlement",
				agentId: AGENT_ID,
				rangeStart: 1,
				rangeEnd: 1,
				flushMode: "manual",
				idempotencyKey: "idem:v2:contest:settlement",
			};

			const created: CreatedState = {
				episodeEventIds: [],
				assertionIds: [],
				entityIds: [],
				factIds: [],
				changedNodeRefs: [],
			};

			await processor.process(flushRequest, ingestion, created, []);

			const row = db.get<{ conflict_summary: string | null }>(
				"SELECT conflict_summary FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ?",
				[AGENT_ID, "v2:contest:settlement"],
			);

			expect(row).toBeDefined();
			expect(row!.conflict_summary).toBeTruthy();
			expect((row!.conflict_summary ?? "").length).toBeGreaterThan(0);
		} finally {
			cleanupDb(db, dbPath);
		}
	});
});
