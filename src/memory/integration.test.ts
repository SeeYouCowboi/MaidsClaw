import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AliasService } from "./alias.js";
import { CoreMemoryService } from "./core-memory.js";
import { EmbeddingService } from "./embeddings.js";
import { MaterializationService } from "./materialization.js";
import { GraphNavigator } from "./navigator.js";
import { PromotionService } from "./promotion.js";
import { getMemoryHints } from "./prompt-data.js";
import { RetrievalService } from "./retrieval.js";
import { createMemorySchema, MAX_INTEGER, makeNodeRef } from "./schema.js";
import { GraphStorageService } from "./storage.js";
import { type MemoryFlushRequest, MemoryTaskAgent } from "./task-agent.js";
import { buildMemoryTools } from "./tools.js";
import { TransactionBatcher } from "./transaction-batcher.js";
import type { NodeRef, ViewerContext } from "./types.js";

type ToolCallResult = {
	name: string;
	arguments: Record<string, unknown>;
};

class MockModelProvider {
	private readonly chatResponses: ToolCallResult[][];
	private readonly vectors: Float32Array[];

	constructor(chatResponses: ToolCallResult[][], vectors?: Float32Array[]) {
		this.chatResponses = [...chatResponses];
		this.vectors = vectors ?? [
			new Float32Array([1, 0]),
			new Float32Array([0.99, 0.01]),
			new Float32Array([0.98, 0.02]),
			new Float32Array([0.97, 0.03]),
		];
	}

	async chat(): Promise<ToolCallResult[]> {
		return this.chatResponses.shift() ?? [];
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		return texts.map((_, index) => this.vectors[index % this.vectors.length]);
	}
}

function freshDb(): Database {
	const db = new Database(":memory:");
	createMemorySchema(db);
	return db;
}

function makeViewer(overrides?: Partial<ViewerContext>): ViewerContext {
	return {
		viewer_agent_id: "agent-1",
		viewer_role: "rp_agent",
		current_area_id: 1,
		session_id: "session-rp-1",
		...overrides,
	};
}

describe("Memory integration", () => {
	it("runs end-to-end 10-turn pipeline with visibility-safe retrieval", async () => {
		const db = freshDb();
		const storage = new GraphStorageService(db);
		const coreMemory = new CoreMemoryService(db);
		const embeddings = new EmbeddingService(db, new TransactionBatcher(db));
		const materialization = new MaterializationService(db, storage);
		const retrieval = new RetrievalService(db);
		const alias = new AliasService(db);
		const promotion = new PromotionService(db, storage);

		coreMemory.initializeBlocks("agent-1");

		const areaId = storage.upsertEntity({
			pointerKey: "area:tea-room",
			displayName: "Tea Room",
			entityType: "area",
			memoryScope: "shared_public",
		});
		const locketId = storage.upsertEntity({
			pointerKey: "item:locket",
			displayName: "Silver Locket",
			entityType: "item",
			memoryScope: "shared_public",
		});

		const runtimeEventId = storage.createProjectedEvent({
			sessionId: "session-rp-1",
			summary: "Alice owns a silver locket",
			timestamp: 1000,
			participants: JSON.stringify([makeNodeRef("entity", areaId)]),
			locationEntityId: areaId,
			eventCategory: "observation",
			sourceRecordId: "r4",
			origin: "runtime_projection",
		});
		storage.createLogicEdge(runtimeEventId, runtimeEventId, "same_episode");

		const dialogueRecords = Array.from({ length: 10 }, (_, index) => {
			const role = index % 2 === 0 ? "user" : "assistant";
			return {
				role,
				content: `turn ${index + 1}: roleplay line ${index + 1}`,
				timestamp: 1000 + index * 100,
				recordId: `r${index + 1}`,
				recordIndex: index + 1,
			} as const;
		});

		const provider = new MockModelProvider([
			[
				{
					name: "create_entity",
					arguments: {
						pointer_key: "person:alice",
						display_name: "Alice",
						entity_type: "person",
						memory_scope: "private_overlay",
					},
				},
				{
					name: "create_entity",
					arguments: {
						pointer_key: "person:bob",
						display_name: "Bob",
						entity_type: "person",
						memory_scope: "private_overlay",
					},
				},
				{
					name: "create_alias",
					arguments: {
						canonical_id: "person:alice",
						alias: "Lady Alice",
						alias_type: "nickname",
					},
				},
				{
					name: "create_private_event",
					arguments: {
						role: "assistant",
						private_notes:
							"Alice privately confirms she keeps the silver locket hidden.",
						salience: 0.92,
						emotion: "focused",
						event_category: "observation",
						primary_actor_entity_id: "person:alice",
						projection_class: "area_candidate",
						location_entity_id: areaId,
						projectable_summary: "Alice owns a silver locket",
						source_record_id: "r4",
					},
				},
				{
					name: "create_private_event",
					arguments: {
						role: "assistant",
						private_notes: "Alice shows the keepsake to Bob in confidence.",
						salience: 0.95,
						emotion: "trust",
						event_category: "action",
						primary_actor_entity_id: "person:alice",
						projection_class: "area_candidate",
						location_entity_id: areaId,
						projectable_summary: "Alice shows Bob her keepsake",
						source_record_id: "r9",
					},
				},
				{
					name: "create_private_belief",
					arguments: {
						source: "person:alice",
						target: "person:bob",
						predicate: "trusts",
						belief_type: "inference",
						confidence: 0.84,
						epistemic_status: "confirmed",
						provenance: "dialogue_inference",
						source_event_ref: makeNodeRef("event", runtimeEventId),
					},
				},
			],
			[
				{
					name: "update_index_block",
					arguments: {
						new_text: "@person:alice @person:bob e:1 f:1 #keepsake",
					},
				},
			],
		]);

		const taskAgent = new MemoryTaskAgent(
			db,
			storage,
			coreMemory,
			embeddings,
			materialization,
			provider,
		);
		const flushRequest: MemoryFlushRequest = {
			sessionId: "session-rp-1",
			agentId: "agent-1",
			rangeStart: 1,
			rangeEnd: 10,
			flushMode: "dialogue_slice",
			idempotencyKey: "queue:integration-1",
			queueOwnerAgentId: "agent-1",
			dialogueRecords,
		};

		const migration = await taskAgent.runMigrate(flushRequest);
		await taskAgent.runOrganize({
			agentId: "agent-1",
			sessionId: "session-rp-1",
			batchId: "manual-organize-1",
			changedNodeRefs: [
				...migration.entity_ids.map((id) => makeNodeRef("entity", id)),
				...migration.private_event_ids.map((id) =>
					makeNodeRef("private_event", id),
				),
				...migration.private_belief_ids.map((id) =>
					makeNodeRef("private_belief", id),
				),
			],
			embeddingModelId: "memory-task-organizer-v1",
		});

		const privateRows = db
			.prepare(
				`SELECT id, event_category, projection_class, projectable_summary, source_record_id
         FROM agent_event_overlay
         WHERE agent_id = ?
         ORDER BY id ASC`,
			)
			.all("agent-1") as Array<{
			id: number;
			event_category: string;
			projection_class: string;
			projectable_summary: string;
			source_record_id: string;
		}>;

		const materializedEvent = db
			.prepare(
				`SELECT id, summary, raw_text, participants
         FROM event_nodes
         WHERE source_record_id = ?`,
			)
			.get("r9") as {
			id: number;
			summary: string;
			raw_text: string | null;
			participants: string;
		};

		const alicePrivate = db
			.prepare(
				`SELECT id, memory_scope FROM entity_nodes
         WHERE pointer_key = 'person:alice' AND owner_agent_id = 'agent-1'`,
			)
			.get() as { id: number; memory_scope: string };

		const belief = db
			.prepare(
				`SELECT epistemic_status, provenance, source_event_ref
         FROM agent_fact_overlay
         WHERE agent_id = 'agent-1' AND predicate = 'trusts'`,
			)
			.get() as {
			epistemic_status: string;
			provenance: string;
			source_event_ref: string;
		};

		const factCandidate = {
			source_ref: makeNodeRef("private_event", migration.private_event_ids[0]),
			target_scope: "world_public" as const,
			summary: "Alice owns locket",
			entity_refs: [
				makeNodeRef("entity", alicePrivate.id),
				makeNodeRef("entity", locketId),
			],
		};
		const resolutions = promotion.resolveReferences(factCandidate);
		const promotedFact = promotion.executeProjectedWrite(
			factCandidate,
			resolutions,
			"world_public",
		);
		expect(promotedFact?.created_ref.startsWith("fact:")).toBe(true);

		const firstFactId = storage.createFact(areaId, alicePrivate.id, "visited");
		const secondFactId = storage.createFact(areaId, alicePrivate.id, "visited");

		const firstFact = db
			.prepare(`SELECT t_invalid FROM fact_edges WHERE id = ?`)
			.get(firstFactId) as { t_invalid: number };
		const secondFact = db
			.prepare(`SELECT t_invalid FROM fact_edges WHERE id = ?`)
			.get(secondFactId) as { t_invalid: number };

		const index = coreMemory.getBlock("agent-1", "index");
		const aliasRead = retrieval.readByEntity("Lady Alice", makeViewer());
		const hiddenFromOtherAgent = retrieval.readByEntity(
			"person:alice",
			makeViewer({ viewer_agent_id: "agent-2" }),
		);

		const rpSearch = await retrieval.searchVisibleNarrative(
			"keepsake",
			makeViewer(),
		);
		const maidenSearch = await retrieval.searchVisibleNarrative(
			"keepsake",
			makeViewer({ viewer_role: "maiden", viewer_agent_id: "maiden-1" }),
		);

		const navigator = new GraphNavigator(db, retrieval, alias);
		const tools = buildMemoryTools({ coreMemory, retrieval, navigator });
		const exploreTool = tools.find((tool) => tool.name === "memory_explore");
		expect(exploreTool).toBeDefined();
		const whyResult = (await exploreTool?.handler(
			{ query: "why did alice reveal the keepsake" },
			makeViewer(),
		)) as {
			query_type: string;
			evidence_paths: unknown[];
		};
		const relationshipResult = (await exploreTool?.handler(
			{ query: "relationship between alice and bob" },
			makeViewer(),
		)) as {
			query_type: string;
			evidence_paths: unknown[];
		};
		const timelineResult = (await exploreTool?.handler(
			{ query: "timeline of keepsake events" },
			makeViewer(),
		)) as {
			query_type: string;
			evidence_paths: unknown[];
		};

		const hintText = await getMemoryHints("keepsake", makeViewer(), db, 5);
		const semanticRows = db
			.prepare(`SELECT source_node_ref, target_node_ref FROM semantic_edges`)
			.all() as Array<{ source_node_ref: NodeRef; target_node_ref: NodeRef }>;

		const crossAgentPrivateEdgeCount = semanticRows.filter((row) => {
			const pair = [row.source_node_ref, row.target_node_ref];
			const owners = pair
				.map((ref) => {
					if (ref.startsWith("private_event:")) {
						const id = Number(ref.split(":")[1]);
						const owner = db
							.prepare(`SELECT agent_id FROM agent_event_overlay WHERE id = ?`)
							.get(id) as { agent_id: string } | null;
						return owner?.agent_id ?? null;
					}
					if (ref.startsWith("private_belief:")) {
						const id = Number(ref.split(":")[1]);
						const owner = db
							.prepare(`SELECT agent_id FROM agent_fact_overlay WHERE id = ?`)
							.get(id) as { agent_id: string } | null;
						return owner?.agent_id ?? null;
					}
					return null;
				})
				.filter((owner): owner is string => owner !== null);

			if (owners.length < 2) {
				return false;
			}
			return owners[0] !== owners[1];
		}).length;

		const embeddingCount = db
			.prepare(
				`SELECT count(*) as cnt FROM node_embeddings WHERE model_id = 'memory-task-organizer-v1'`,
			)
			.get() as { cnt: number };

		let passed = 0;
		const total = 14;

		expect(dialogueRecords).toHaveLength(10);
		passed += 1;

		expect(privateRows.length).toBeGreaterThanOrEqual(2);
		expect(
			privateRows.some((row) => row.projection_class === "area_candidate"),
		).toBe(true);
		expect(privateRows.every((row) => row.event_category.length > 0)).toBe(
			true,
		);
		expect(privateRows.every((row) => row.projectable_summary.length > 0)).toBe(
			true,
		);
		expect(
			privateRows.every((row) => row.source_record_id.startsWith("r")),
		).toBe(true);
		passed += 1;

		expect(materializedEvent.summary).toBe("Alice shows Bob her keepsake");
		expect(materializedEvent.raw_text).toBeNull();
		expect(Array.isArray(JSON.parse(materializedEvent.participants))).toBe(
			true,
		);
		passed += 1;

		expect(alicePrivate.memory_scope).toBe("private_overlay");
		passed += 1;

		const promotedFactId = Number(
			(promotedFact?.created_ref ?? "fact:0").split(":")[1],
		);
		const promotedFactRow = db
			.prepare(`SELECT t_invalid FROM fact_edges WHERE id = ?`)
			.get(promotedFactId) as { t_invalid: number };
		expect(promotedFactRow.t_invalid).toBe(MAX_INTEGER);
		expect(belief.epistemic_status).toBe("confirmed");
		expect(belief.provenance).toBe("dialogue_inference");
		expect(belief.source_event_ref).toBe(makeNodeRef("event", runtimeEventId));
		passed += 1;

		expect(embeddingCount.cnt).toBeGreaterThan(0);
		expect(semanticRows.length).toBeGreaterThan(0);
		expect(crossAgentPrivateEdgeCount).toBe(0);
		passed += 1;

		expect(index.value).toContain("@person:alice");
		expect(index.value).toContain("e:1");
		passed += 1;

		expect(aliasRead.entity?.pointer_key).toBe("person:alice");
		expect(hiddenFromOtherAgent.entity?.memory_scope).toBe("shared_public");
		expect(hiddenFromOtherAgent.overlays).toHaveLength(0);
		passed += 1;

		expect(rpSearch.some((row) => row.scope === "private")).toBe(true);
		expect(maidenSearch.some((row) => row.scope === "private")).toBe(false);
		passed += 1;

		expect(firstFact.t_invalid).not.toBe(MAX_INTEGER);
		expect(secondFact.t_invalid).toBe(MAX_INTEGER);
		passed += 1;

		expect(whyResult.query_type).toBe("why");
		expect(relationshipResult.query_type).toBe("relationship");
		expect(timelineResult.query_type).toBe("timeline");
		expect(whyResult.evidence_paths.length).toBeGreaterThan(0);
		passed += 1;

		expect(hintText.length).toBeGreaterThan(0);
		expect(hintText.includes("keepsake") || hintText.includes("Alice")).toBe(
			true,
		);
		passed += 1;

		const r4EventCount = db
			.prepare(
				`SELECT count(*) as cnt FROM event_nodes WHERE source_record_id = 'r4'`,
			)
			.get() as { cnt: number };
		expect(r4EventCount.cnt).toBe(1);
		passed += 1;

		expect(migration.private_event_ids.length).toBeGreaterThan(0);
		expect(migration.private_belief_ids.length).toBeGreaterThan(0);
		passed += 1;

		const verdict = passed === total ? "APPROVE" : "REJECT";
		expect(verdict).toBe("APPROVE");
		console.info(`Main [${passed}/${total} pass] | VERDICT: ${verdict}`);
	});
});
