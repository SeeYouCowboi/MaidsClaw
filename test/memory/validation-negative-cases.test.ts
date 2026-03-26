import { describe, expect, it } from "bun:test";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import { CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import { PrivateCognitionProjectionRepo } from "../../src/memory/cognition/private-cognition-current.js";
import {
	materializeRelationIntents,
	resolveLocalRefs,
	validateRelationIntents,
	type SettledArtifacts,
} from "../../src/memory/cognition/relation-intent-resolver.js";
import { ExplicitSettlementProcessor } from "../../src/memory/explicit-settlement-processor.js";
import { SharedBlockRepo } from "../../src/memory/shared-blocks/shared-block-repo.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import type {
	CognitionOp,
	PrivateCognitionCommitV4,
	RelationIntent,
} from "../../src/runtime/rp-turn-contract.js";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import type {
	ChatToolDefinition,
	CreatedState,
	IngestionInput,
	MemoryFlushRequest,
} from "../../src/memory/task-agent.js";
import {
	cleanupDb,
	createTempDb,
	seedStandardEntities,
	type Db,
} from "../helpers/memory-test-utils.js";

const AGENT_ID = "rp:alice";

type AssertionRow = {
	id: number;
	summary_text: string | null;
	stance: string | null;
	basis: string | null;
	pre_contested_stance: string | null;
	record_json: string;
	updated_at: number;
};

function createTestContext(): { db: Db; dbPath: string; storage: GraphStorageService } {
	const { db, dbPath } = createTempDb();
	seedStandardEntities(db);
	return { db, dbPath, storage: new GraphStorageService(db) };
}

function readAssertion(db: Db, cognitionKey: string): AssertionRow | undefined {
	return db.get<AssertionRow>(
		`SELECT id, summary_text, stance, basis, pre_contested_stance, record_json, updated_at
		 FROM private_cognition_current
		 WHERE agent_id = ? AND cognition_key = ?`,
		[AGENT_ID, cognitionKey],
	);
}

function makeSettlementPayload(params: {
	settlementId: string;
	requestId: string;
	sessionId: string;
	agentId: string;
	ops: CognitionOp[];
	conflictFactors?: Array<{ kind: string; ref: string }>;
}): TurnSettlementPayload {
	return {
		settlementId: params.settlementId,
		requestId: params.requestId,
		sessionId: params.sessionId,
		ownerAgentId: params.agentId,
		publicReply: "",
		hasPublicReply: false,
		viewerSnapshot: {
			selfPointerKey: "__self__",
			userPointerKey: "__user__",
		},
		privateCognition: {
			schemaVersion: "rp_private_cognition_v4",
			ops: params.ops,
		},
		...(params.conflictFactors ? { conflictFactors: params.conflictFactors } : {}),
	};
}

async function processExplicitSettlement(params: {
	db: Db;
	storage: GraphStorageService;
	agentId: string;
	sessionId: string;
	requestId: string;
	settlementId: string;
	ops: CognitionOp[];
	conflictFactors?: Array<{ kind: string; ref: string }>;
}): Promise<void> {
	const processor = new ExplicitSettlementProcessor(
		params.db.raw,
		params.storage,
		{ chat: async () => [] },
		() => ({ entities: [], privateBeliefs: [] }),
		() => {},
	);

	const flushRequest: MemoryFlushRequest = {
		agentId: params.agentId,
		sessionId: params.sessionId,
		rangeStart: 0,
		rangeEnd: 0,
		flushMode: "manual",
		idempotencyKey: `flush:${params.settlementId}`,
	};

	const privateCognition: PrivateCognitionCommitV4 = {
		schemaVersion: "rp_private_cognition_v4",
		ops: params.ops,
	};

	const explicitMeta = {
		settlementId: params.settlementId,
		requestId: params.requestId,
		ownerAgentId: params.agentId,
		privateCognition,
	};

	const ingest: IngestionInput = {
		batchId: `batch:${params.settlementId}`,
		agentId: params.agentId,
		sessionId: params.sessionId,
		dialogue: [],
		attachments: [
			{
				recordType: "turn_settlement",
				payload: makeSettlementPayload({
					settlementId: params.settlementId,
					requestId: params.requestId,
					sessionId: params.sessionId,
					agentId: params.agentId,
					ops: params.ops,
					conflictFactors: params.conflictFactors,
				}),
				committedAt: Date.now(),
				correlatedTurnId: params.requestId,
				explicitMeta,
			},
		],
		explicitSettlements: [explicitMeta],
	};

	const created: CreatedState = {
		episodeEventIds: [],
		assertionIds: [],
		entityIds: [],
		factIds: [],
		changedNodeRefs: [],
	};

	await processor.process(flushRequest, ingest, created, [] satisfies ChatToolDefinition[]);
}

describe("V2 validation — negative/edge-case boundaries", () => {
	it("rejects illegal stance transition hypothetical -> confirmed and preserves row state", () => {
		const { db, dbPath } = createTestContext();
		try {
			const repo = new CognitionRepository(db);
			const cognitionKey = "neg:stance:hypothetical-to-confirmed";

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey,
				settlementId: "stl:neg:1:init",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "hypothetical",
			});

			const before = readAssertion(db, cognitionKey);
			expect(before).toBeDefined();

			expect(() =>
				repo.upsertAssertion({
					agentId: AGENT_ID,
					cognitionKey,
					settlementId: "stl:neg:1:illegal",
					opIndex: 1,
					sourcePointerKey: "__self__",
					predicate: "trusts",
					targetPointerKey: "bob",
					stance: "confirmed",
				}),
			).toThrow();

			const after = readAssertion(db, cognitionKey);
			expect(after).toEqual(before);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("rejects illegal stance transition confirmed -> abandoned and preserves row state", () => {
		const { db, dbPath } = createTestContext();
		try {
			const repo = new CognitionRepository(db);
			const cognitionKey = "neg:stance:confirmed-to-abandoned";

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey,
				settlementId: "stl:neg:2:init",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "confirmed",
			});

			const before = readAssertion(db, cognitionKey);
			expect(before).toBeDefined();

			expect(() =>
				repo.upsertAssertion({
					agentId: AGENT_ID,
					cognitionKey,
					settlementId: "stl:neg:2:illegal",
					opIndex: 1,
					sourcePointerKey: "__self__",
					predicate: "trusts",
					targetPointerKey: "bob",
					stance: "abandoned",
				}),
			).toThrow();

			const after = readAssertion(db, cognitionKey);
			expect(after).toEqual(before);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("rejects terminal-state key reuse rejected -> accepted and preserves row state", () => {
		const { db, dbPath } = createTestContext();
		try {
			const repo = new CognitionRepository(db);
			const cognitionKey = "neg:stance:rejected-to-accepted";

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey,
				settlementId: "stl:neg:3:init",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "rejected",
			});

			const before = readAssertion(db, cognitionKey);
			expect(before).toBeDefined();

			expect(() =>
				repo.upsertAssertion({
					agentId: AGENT_ID,
					cognitionKey,
					settlementId: "stl:neg:3:illegal",
					opIndex: 1,
					sourcePointerKey: "__self__",
					predicate: "trusts",
					targetPointerKey: "bob",
					stance: "accepted",
				}),
			).toThrow();

			const after = readAssertion(db, cognitionKey);
			expect(after).toEqual(before);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("rejects basis downgrade first_hand -> belief and preserves row state", () => {
		const { db, dbPath } = createTestContext();
		try {
			const repo = new CognitionRepository(db);
			const cognitionKey = "neg:basis:first-hand-to-belief";

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey,
				settlementId: "stl:neg:4:init",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const before = readAssertion(db, cognitionKey);
			expect(before).toBeDefined();

			expect(() =>
				repo.upsertAssertion({
					agentId: AGENT_ID,
					cognitionKey,
					settlementId: "stl:neg:4:illegal",
					opIndex: 1,
					sourcePointerKey: "__self__",
					predicate: "trusts",
					targetPointerKey: "bob",
					stance: "accepted",
					basis: "belief",
				}),
			).toThrow();

			const after = readAssertion(db, cognitionKey);
			expect(after).toEqual(before);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("drops bad localRef relation intent and still materializes valid intents", () => {
		const { db, dbPath } = createTestContext();
		try {
			const repo = new CognitionRepository(db);
			const evalResult = repo.upsertEvaluation({
				agentId: AGENT_ID,
				cognitionKey: "neg:relation-intent:eval-ok",
				settlementId: "stl:neg:5:eval",
				opIndex: 0,
				dimensions: [{ name: "trust", value: 0.6 }],
				notes: "stable",
			});

			const episodeInsert = db.run(
				`INSERT INTO private_episode_events
				 (agent_id, session_id, settlement_id, category, summary, committed_time, source_local_ref, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[AGENT_ID, "sess:neg:5", "stl:neg:5", "observation", "witnessed event", Date.now(), "ep:ok", Date.now()],
			);

			const settledArtifacts: SettledArtifacts = {
				settlementId: "stl:neg:5",
				agentId: AGENT_ID,
				localRefIndex: new Map([
					["ep:ok", { kind: "episode", nodeRef: `private_episode:${Number(episodeInsert.lastInsertRowid)}` }],
				]),
				cognitionByKey: new Map([
					["neg:relation-intent:eval-ok", { kind: "evaluation", nodeRef: `evaluation:${evalResult.id}` }],
				]),
			};

			const intents: RelationIntent[] = [
				{ sourceRef: "ep:missing", targetRef: "neg:relation-intent:eval-ok", intent: "supports" },
				{ sourceRef: "ep:ok", targetRef: "neg:relation-intent:eval-ok", intent: "triggered" },
			];

			const resolvedRefs = resolveLocalRefs({ relationIntents: intents }, settledArtifacts);
			const acceptedIntents: RelationIntent[] = [];
			for (const intent of intents) {
				try {
					validateRelationIntents([intent], resolvedRefs);
					acceptedIntents.push(intent);
				} catch {}
			}

			expect(acceptedIntents).toHaveLength(1);
			expect(acceptedIntents[0]!.sourceRef).toBe("ep:ok");

			const written = materializeRelationIntents(acceptedIntents, resolvedRefs, db);
			expect(written).toBe(1);

			const relations = db.query<{ source_node_ref: string; relation_type: string }>(
				`SELECT source_node_ref, relation_type FROM memory_relations WHERE source_ref = ?`,
				["stl:neg:5"],
			);
			expect(relations).toHaveLength(1);
			expect(relations[0]!.source_node_ref).toBe(`private_episode:${Number(episodeInsert.lastInsertRowid)}`);
			expect(relations[0]!.relation_type).toBe("triggered");

			const evalRow = db.get<{ cognition_key: string }>(
				"SELECT cognition_key FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ?",
				[AGENT_ID, "neg:relation-intent:eval-ok"],
			);
			expect(evalRow?.cognition_key).toBe("neg:relation-intent:eval-ok");
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("soft-fails bad conflictFactors cognitionKey and still writes contested assertion", async () => {
		const { db, dbPath, storage } = createTestContext();
		try {
			const repo = new CognitionRepository(db);
			const projection = new PrivateCognitionProjectionRepo(db);
			const cognitionKey = "neg:conflict-factor:assertion";

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey,
				settlementId: "stl:neg:6:seed",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			projection.rebuild(AGENT_ID);

			await processExplicitSettlement({
				db,
				storage,
				agentId: AGENT_ID,
				sessionId: "sess:neg:6",
				requestId: "req:neg:6",
				settlementId: "stl:neg:6",
				ops: [
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: cognitionKey,
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
				conflictFactors: [{ kind: "cognition", ref: "cognition-key-does-not-exist" }],
			});

			const assertion = readAssertion(db, cognitionKey);
			expect(assertion).toBeDefined();
			expect(assertion!.stance).toBe("contested");

			const conflictRelations = db.get<{ count: number }>(
				`SELECT COUNT(*) as count
				 FROM memory_relations
				 WHERE source_ref = ? AND relation_type = 'conflicts_with'`,
				["stl:neg:6"],
			);
			expect(conflictRelations?.count).toBe(0);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("upserts same assertion cognitionKey twice as update (single current row)", () => {
		const { db, dbPath } = createTestContext();
		try {
			const repo = new CognitionRepository(db);
			const projection = new PrivateCognitionProjectionRepo(db);
			const cognitionKey = "test-key-123";

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey,
				settlementId: "stl:neg:7:first",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
			});

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey,
				settlementId: "stl:neg:7:second",
				opIndex: 1,
				sourcePointerKey: "__self__",
				predicate: "distrusts",
				targetPointerKey: "bob",
				stance: "accepted",
			});

			for (const event of repo.getEventRepo().readByCognitionKey(AGENT_ID, cognitionKey)) {
				projection.upsertFromEvent(event);
			}

			const overlayCount = db.get<{ count: number }>(
				"SELECT COUNT(*) as count FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ?",
				[AGENT_ID, cognitionKey],
			);
			expect(overlayCount?.count).toBe(1);

			const overlayRow = readAssertion(db, cognitionKey);
			expect(overlayRow?.summary_text).toContain("distrusts");

			const currentCount = db.get<{ count: number }>(
				"SELECT COUNT(*) as count FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ?",
				[AGENT_ID, cognitionKey],
			);
			expect(currentCount?.count).toBe(1);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("shared blocks smoke: create block, read block, write section, and verify admin table", () => {
		const { db, dbPath } = createTestContext();
		try {
			const repo = new SharedBlockRepo(db);
			const block = repo.createBlock("Negative-case smoke block", AGENT_ID);

			expect(block.id).toBeGreaterThan(0);
			expect(repo.getBlock(block.id)?.title).toBe("Negative-case smoke block");

			// Smoke-level test per consensus §16.7 — not exhaustive permission testing
			repo.upsertSection(block.id, "profile/summary", "Smoke content");
			expect(repo.getSection(block.id, "profile/summary")?.content).toBe("Smoke content");

			db.run(
				`INSERT INTO shared_block_admins (block_id, agent_id, granted_by_agent_id, granted_at) VALUES (?, ?, ?, ?)`,
				[block.id, "rp:admin-smoke", AGENT_ID, Date.now()],
			);

			const adminRow = db.get<{ agent_id: string }>(
				"SELECT agent_id FROM shared_block_admins WHERE block_id = ? AND agent_id = ?",
				[block.id, "rp:admin-smoke"],
			);
			expect(adminRow?.agent_id).toBe("rp:admin-smoke");
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("sanitizes malformed FTS queries without throwing or exposing SQL fragments", () => {
		const { db, dbPath } = createTestContext();
		try {
			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "neg:fts:seed",
				settlementId: "stl:neg:9:seed",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "observes",
				targetPointerKey: "bob",
				stance: "accepted",
			});

			const search = new CognitionSearchService(db);
			const malformedQueries = ["AND OR NOT", '"unclosed', "OR OR OR"];
			const beforeCount = db.get<{ count: number }>(
				"SELECT COUNT(*) as count FROM search_docs_cognition WHERE agent_id = ?",
				[AGENT_ID],
			)?.count;

			for (const query of malformedQueries) {
				let result: ReturnType<CognitionSearchService["searchCognition"]> = [];
				expect(() => {
					result = search.searchCognition({
						agentId: AGENT_ID,
						kind: "assertion",
						query,
					});
				}).not.toThrow();

				expect(Array.isArray(result)).toBe(true);
				const serialized = JSON.stringify(result);
				expect(serialized).not.toContain("SELECT ");
				expect(serialized).not.toContain("DROP TABLE");
			}

			const afterCount = db.get<{ count: number }>(
				"SELECT COUNT(*) as count FROM search_docs_cognition WHERE agent_id = ?",
				[AGENT_ID],
			)?.count;
			expect(afterCount).toBe(beforeCount);
		} finally {
			cleanupDb(db, dbPath);
		}
	});
});
