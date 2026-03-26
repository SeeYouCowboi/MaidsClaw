import { describe, expect, it } from "bun:test";
import { MaidsClawError } from "../../src/core/errors.js";
import type { AgentRole } from "../../src/agents/profile.js";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import type { WriteTemplate } from "../../src/memory/contracts/write-template.js";
import { CognitionEventRepo } from "../../src/memory/cognition/cognition-event-repo.js";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import { PrivateCognitionProjectionRepo } from "../../src/memory/cognition/private-cognition-current.js";
import { EpisodeRepository } from "../../src/memory/episode/episode-repo.js";
import { ExplicitSettlementProcessor } from "../../src/memory/explicit-settlement-processor.js";
import { AreaWorldProjectionRepo } from "../../src/memory/projection/area-world-projection-repo.js";
import { ProjectionManager } from "../../src/memory/projection/projection-manager.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import type {
	ChatToolDefinition,
	CreatedState,
	IngestionInput,
	MemoryFlushRequest,
} from "../../src/memory/task-agent.js";
import type { CognitionOp } from "../../src/runtime/rp-turn-contract.js";
import {
	cleanupDb,
	createTempDb,
	seedStandardEntities,
	type Db,
} from "../helpers/memory-test-utils.js";

type CurrentProjectionRow = {
	cognition_key: string;
	kind: "assertion" | "evaluation" | "commitment";
	stance: string | null;
	basis: string | null;
	status: "active" | "retracted";
};

type RecentSlotRow = {
	session_id: string;
	agent_id: string;
	last_settlement_id: string | null;
	slot_payload: string;
};

async function withTempMemoryDb(testFn: (ctx: { db: Db; storage: GraphStorageService }) => Promise<void> | void): Promise<void> {
	const { db, dbPath } = createTempDb();
	seedStandardEntities(db);
	const storage = new GraphStorageService(db);
	try {
		await testFn({ db, storage });
	} finally {
		cleanupDb(db, dbPath);
	}
}

function readCurrent(db: Db, agentId: string, cognitionKey: string): CurrentProjectionRow | undefined {
	return db.get<CurrentProjectionRow>(
		`SELECT cognition_key, kind, stance, basis, status
		 FROM private_cognition_current
		 WHERE agent_id = ? AND cognition_key = ?`,
		[agentId, cognitionKey],
	);
}

function makeSettlementPayload(
	params: {
		settlementId: string;
		requestId: string;
		sessionId: string;
		agentId: string;
		ops: CognitionOp[];
	},
): TurnSettlementPayload {
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
	agentRole?: AgentRole;
	writeTemplateOverride?: WriteTemplate;
}): Promise<void> {
	const processor = new ExplicitSettlementProcessor(
		params.db.raw,
		params.storage,
		{
			chat: async () => [],
		},
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

	const explicitMeta = {
		settlementId: params.settlementId,
		requestId: params.requestId,
		ownerAgentId: params.agentId,
		privateCognition: {
			schemaVersion: "rp_private_cognition_v4" as const,
			ops: params.ops,
		},
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

	await processor.process(
		flushRequest,
		ingest,
		created,
		[] satisfies ChatToolDefinition[],
		{
			agentRole: params.agentRole,
			writeTemplateOverride: params.writeTemplateOverride,
		},
	);
}

describe("V2 validation — turn settlement sync visibility", () => {
	it("assertion upsert is synchronously visible in private_cognition_current", () =>
		withTempMemoryDb(({ db }) => {
			const repo = new CognitionRepository(db);
			const projectionRepo = new PrivateCognitionProjectionRepo(db);
			const agentId = "rp:alice";
			const cognitionKey = "validation:turn:settlement:assertion";

			repo.upsertAssertion({
				agentId,
				cognitionKey,
				settlementId: "stl:validation:assertion",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const events = repo.getEventRepo().readByCognitionKey(agentId, cognitionKey);
			expect(events.length).toBeGreaterThan(0);
			projectionRepo.upsertFromEvent(events[events.length - 1]!);

			const row = readCurrent(db, agentId, cognitionKey);
			expect(row).toBeDefined();
			expect(row!.kind).toBe("assertion");
			expect(row!.stance).toBe("accepted");
			expect(row!.basis).toBe("first_hand");
			expect(row!.cognition_key).toBe(cognitionKey);
		}),
	);

	it("evaluation upsert is synchronously visible in private_cognition_current", () =>
		withTempMemoryDb(({ db }) => {
			const repo = new CognitionRepository(db);
			const agentId = "rp:alice";
			const cognitionKey = "validation:turn:settlement:evaluation";

			repo.upsertEvaluation({
				agentId,
				cognitionKey,
				settlementId: "stl:validation:evaluation",
				opIndex: 0,
				targetEntityId: undefined,
				salience: 0.77,
				dimensions: [{ name: "trust", value: 0.62 }],
				emotionTags: ["cautious"],
				notes: "steady but uncertain",
			});

			const row = readCurrent(db, agentId, cognitionKey);
			expect(row).toBeDefined();
			expect(row!.kind).toBe("evaluation");
			expect(row!.status).toBe("active");
			expect(row!.cognition_key).toBe(cognitionKey);
		}),
	);

	it("commitment upsert is synchronously visible in private_cognition_current", () =>
		withTempMemoryDb(({ db }) => {
			const repo = new CognitionRepository(db);
			const agentId = "rp:alice";
			const cognitionKey = "validation:turn:settlement:commitment";

			repo.upsertCommitment({
				agentId,
				cognitionKey,
				settlementId: "stl:validation:commitment",
				opIndex: 0,
				targetEntityId: undefined,
				salience: 0.91,
				mode: "goal",
				target: { action: "protect", target: { kind: "pointer_key", value: "bob" } },
				status: "active",
				priority: 8,
				horizon: "near",
			});

			const row = readCurrent(db, agentId, cognitionKey);
			expect(row).toBeDefined();
			expect(row!.kind).toBe("commitment");
			expect(row!.status).toBe("active");
			expect(row!.cognition_key).toBe(cognitionKey);
		}),
	);

	it("batch settlement process makes assertion/evaluation/commitment visible in current projection synchronously", async () => {
		await withTempMemoryDb(async ({ db, storage }) => {
			const agentId = "rp:alice";
			const sessionId = "sess:validation:batch";
			const settlementId = "stl:validation:batch";
			const requestId = "req:validation:batch";
			const assertionKey = "validation:batch:assertion";
			const evaluationKey = "validation:batch:evaluation";
			const commitmentKey = "validation:batch:commitment";

			const ops: CognitionOp[] = [
				{
					op: "upsert",
					record: {
						kind: "assertion",
						key: assertionKey,
						proposition: {
							subject: { kind: "special", value: "self" },
							predicate: "supports",
							object: {
								kind: "entity",
								ref: { kind: "pointer_key", value: "bob" },
							},
						},
						stance: "accepted",
						basis: "inference",
					},
				},
				{
					op: "upsert",
					record: {
						kind: "evaluation",
						key: evaluationKey,
						target: { kind: "pointer_key", value: "bob" },
						dimensions: [{ name: "trust", value: 0.7 }],
						notes: "trust is rising",
					},
				},
				{
					op: "upsert",
					record: {
						kind: "commitment",
						key: commitmentKey,
						mode: "goal",
						target: { action: "guard", target: { kind: "pointer_key", value: "bob" } },
						status: "active",
						horizon: "immediate",
					},
				},
			];

			await processExplicitSettlement({
				db,
				storage,
				agentId,
				sessionId,
				requestId,
				settlementId,
				ops,
			});

			const eventRepo = new CognitionEventRepo(db);
			const projectionRepo = new PrivateCognitionProjectionRepo(db);
			const settlementEvents = eventRepo
				.readByAgent(agentId)
				.filter((row) => row.settlement_id === settlementId);
			for (const event of settlementEvents) {
				projectionRepo.upsertFromEvent(event);
			}

			const assertion = readCurrent(db, agentId, assertionKey);
			const evaluation = readCurrent(db, agentId, evaluationKey);
			const commitment = readCurrent(db, agentId, commitmentKey);

			expect(assertion).toBeDefined();
			expect(assertion!.kind).toBe("assertion");
			expect(evaluation).toBeDefined();
			expect(evaluation!.kind).toBe("evaluation");
			expect(commitment).toBeDefined();
			expect(commitment!.kind).toBe("commitment");
		});
	});

	it("blocks cognition writes for maiden role with WRITE_TEMPLATE_DENIED", async () => {
		await withTempMemoryDb(async ({ db, storage }) => {
			const run = processExplicitSettlement({
				db,
				storage,
				agentId: "rp:alice",
				sessionId: "sess:validation:deny:maiden",
				requestId: "req:validation:deny:maiden",
				settlementId: "stl:validation:deny:maiden",
				agentRole: "maiden",
				ops: [
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "validation:deny:maiden:assertion",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "supports",
								object: {
									kind: "entity",
									ref: { kind: "pointer_key", value: "bob" },
								},
							},
							stance: "accepted",
							basis: "first_hand",
						},
					},
				],
			});

			let caught: unknown;
			try {
				await run;
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeDefined();
			expect(caught instanceof MaidsClawError).toBe(true);
			expect((caught as MaidsClawError).code).toBe("WRITE_TEMPLATE_DENIED");
		});
	});

	it("allows cognition writes for rp_agent role", async () => {
		await withTempMemoryDb(async ({ db, storage }) => {
			const cognitionKey = "validation:allow:rp:assertion";
			await processExplicitSettlement({
				db,
				storage,
				agentId: "rp:alice",
				sessionId: "sess:validation:allow:rp",
				requestId: "req:validation:allow:rp",
				settlementId: "stl:validation:allow:rp",
				agentRole: "rp_agent",
				ops: [
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: cognitionKey,
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "supports",
								object: {
									kind: "entity",
									ref: { kind: "pointer_key", value: "bob" },
								},
							},
							stance: "accepted",
							basis: "first_hand",
						},
					},
				],
			});

			const row = db.get<{ cognition_key: string }>(
				"SELECT cognition_key FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ?",
				["rp:alice", cognitionKey],
			);
			expect(row?.cognition_key).toBe(cognitionKey);
		});
	});

	it("allows cognition writes for maiden when writeTemplate override enables cognition writes", async () => {
		await withTempMemoryDb(async ({ db, storage }) => {
			const cognitionKey = "validation:allow:override:assertion";
			await processExplicitSettlement({
				db,
				storage,
				agentId: "rp:alice",
				sessionId: "sess:validation:allow:override",
				requestId: "req:validation:allow:override",
				settlementId: "stl:validation:allow:override",
				agentRole: "maiden",
				writeTemplateOverride: { allowCognitionWrites: true },
				ops: [
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: cognitionKey,
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "supports",
								object: {
									kind: "entity",
									ref: { kind: "pointer_key", value: "bob" },
								},
							},
							stance: "accepted",
							basis: "first_hand",
						},
					},
				],
			});

			const row = db.get<{ cognition_key: string }>(
				"SELECT cognition_key FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ?",
				["rp:alice", cognitionKey],
			);
			expect(row?.cognition_key).toBe(cognitionKey);
		});
	});

	it("settlement commit populates recent_cognition_slots for settlement session+agent", () =>
		withTempMemoryDb(({ db, storage }) => {
			runInteractionMigrations(db);

			const projectionManager = new ProjectionManager(
				new EpisodeRepository(db),
				new CognitionEventRepo(db),
				new PrivateCognitionProjectionRepo(db),
				storage,
			);
			const interactionStore = new InteractionStore(db);

			const sessionId = "sess:validation:slot";
			const agentId = "rp:alice";
			const settlementId = "stl:validation:slot";

			const slotEntries = [
				{
					settlementId,
					committedAt: Date.now(),
					kind: "commitment",
					key: "validation:slot:commitment",
					summary: "goal: guard (active)",
					status: "active",
				},
			];

			projectionManager.commitSettlement({
				settlementId,
				sessionId,
				agentId,
				cognitionOps: [
					{
						op: "upsert",
						record: {
							kind: "commitment",
							key: "validation:slot:commitment",
							mode: "goal",
							target: { action: "guard", target: { kind: "pointer_key", value: "bob" } },
							status: "active",
						},
					},
				],
				privateEpisodes: [],
				publications: [],
				upsertRecentCognitionSlot: interactionStore.upsertRecentCognitionSlot.bind(interactionStore),
				recentCognitionSlotJson: JSON.stringify(slotEntries),
			});

			const row = db.get<RecentSlotRow>(
				`SELECT session_id, agent_id, last_settlement_id, slot_payload
				 FROM recent_cognition_slots
				 WHERE session_id = ? AND agent_id = ?`,
				[sessionId, agentId],
			);

			expect(row).toBeDefined();
			expect(row!.session_id).toBe(sessionId);
			expect(row!.agent_id).toBe(agentId);
			expect(row!.last_settlement_id).toBe(settlementId);
			expect(row!.slot_payload).toContain("validation:slot:commitment");
		}),
	);

	it("settlement commit can project latent area state without narrative event", () =>
		withTempMemoryDb(({ db, storage }) => {
			runInteractionMigrations(db);
			const { locationId } = seedStandardEntities(db);
			const areaProjectionRepo = new AreaWorldProjectionRepo(db.raw);
			const projectionManager = new ProjectionManager(
				new EpisodeRepository(db),
				new CognitionEventRepo(db),
				new PrivateCognitionProjectionRepo(db),
				storage,
				areaProjectionRepo,
			);
			const interactionStore = new InteractionStore(db);

			projectionManager.commitSettlement({
				settlementId: "stl:validation:latent-area",
				sessionId: "sess:validation:latent-area",
				agentId: "rp:alice",
				cognitionOps: [],
				privateEpisodes: [],
				publications: [],
				viewerSnapshot: { currentLocationEntityId: locationId },
				areaStateArtifacts: [
					{
						key: "env.temperature",
						value: { celsius: 18 },
						surfacingClassification: "latent_state_update",
						sourceType: "simulation",
					},
				],
				upsertRecentCognitionSlot: interactionStore.upsertRecentCognitionSlot.bind(interactionStore),
				recentCognitionSlotJson: "[]",
			});

			const areaState = db.get<{ surfacing_classification: string; source_type: string }>(
				`SELECT surfacing_classification, source_type
				 FROM area_state_current
				 WHERE agent_id = ? AND area_id = ? AND key = ?`,
				["rp:alice", locationId, "env.temperature"],
			);
			expect(areaState).toBeDefined();
			expect(areaState?.surfacing_classification).toBe("latent_state_update");
			expect(areaState?.source_type).toBe("simulation");

			const areaNarrative = db.get<{ summary_text: string }>(
				"SELECT summary_text FROM area_narrative_current WHERE agent_id = ? AND area_id = ?",
				["rp:alice", locationId],
			);
			expect(areaNarrative).toBeUndefined();
		}),
	);

	it("settlement commit silently skips publication materialization when graphStorage is null", () =>
		withTempMemoryDb(({ db }) => {
			runInteractionMigrations(db);
			const { locationId } = seedStandardEntities(db);
			const projectionManager = new ProjectionManager(
				new EpisodeRepository(db),
				new CognitionEventRepo(db),
				new PrivateCognitionProjectionRepo(db),
				null,
			);
			const interactionStore = new InteractionStore(db);

			projectionManager.commitSettlement({
				settlementId: "stl:validation:null-graph",
				sessionId: "sess:validation:null-graph",
				agentId: "rp:alice",
				cognitionOps: [],
				privateEpisodes: [],
				publications: [{ kind: "spoken", targetScope: "current_area", summary: "Should be skipped." }],
				viewerSnapshot: { currentLocationEntityId: locationId },
				upsertRecentCognitionSlot: interactionStore.upsertRecentCognitionSlot.bind(interactionStore),
				recentCognitionSlotJson: "[]",
			});

			const published = db.get<{ count: number }>(
				"SELECT COUNT(*) AS count FROM event_nodes WHERE source_settlement_id = ?",
				["stl:validation:null-graph"],
			);
			expect(published?.count ?? 0).toBe(0);

			const slot = db.get<RecentSlotRow>(
				`SELECT session_id, agent_id, last_settlement_id, slot_payload
				 FROM recent_cognition_slots
				 WHERE session_id = ? AND agent_id = ?`,
				["sess:validation:null-graph", "rp:alice"],
			);
			expect(slot).toBeDefined();
			expect(slot?.last_settlement_id).toBe("stl:validation:null-graph");
		}),
	);
});
