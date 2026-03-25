import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AliasService } from "../../src/memory/alias.js";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { EmbeddingService } from "../../src/memory/embeddings.js";
import { MaterializationService } from "../../src/memory/materialization.js";
import { GraphNavigator } from "../../src/memory/navigator.js";
import { PromotionService } from "../../src/memory/promotion.js";

import { RetrievalService } from "../../src/memory/retrieval.js";
import { createMemorySchema, MAX_INTEGER, makeNodeRef } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { type MemoryFlushRequest, MemoryTaskAgent } from "../../src/memory/task-agent.js";
import { buildMemoryTools } from "../../src/memory/tools.js";
import { TransactionBatcher } from "../../src/memory/transaction-batcher.js";
import type { NodeRef, ViewerContext } from "../../src/memory/types.js";

type ToolCallResult = {
	name: string;
	arguments: Record<string, unknown>;
};

class MockModelProvider {
	readonly defaultEmbeddingModelId: string = "test-embedding-model";
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
		const storage = new GraphStorageService(db as any);
		const coreMemory = new CoreMemoryService(db as any);
		const embeddings = new EmbeddingService(db as any, new TransactionBatcher(db as any));
		const materialization = new MaterializationService(db, storage);
		const retrieval = new RetrievalService(db as any);
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
						basis: "inference",
						stance: "confirmed",
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
				makeNodeRef("event", id),
			),
				...migration.private_belief_ids.map((id) =>
					makeNodeRef("assertion", id),
				),
			],
			embeddingModelId: "memory-task-organizer-v1",
		});

		const privateRows = db
			.prepare(
				`SELECT id, category, summary, source_local_ref
         FROM private_episode_events
         WHERE agent_id = ?
         ORDER BY id ASC`,
			)
			.all("agent-1") as Array<{
			id: number;
			category: string;
			summary: string;
			source_local_ref: string;
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
				`SELECT stance, provenance, source_event_ref
         FROM agent_fact_overlay
         WHERE agent_id = 'agent-1' AND predicate = 'trusts'`,
			)
			.get() as {
			stance: string;
			provenance: string;
			source_event_ref: string;
		};

		const factCandidate = {
			source_ref: makeNodeRef("event", migration.private_event_ids[0]),
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

		const semanticRows = db
			.prepare(`SELECT source_node_ref, target_node_ref FROM semantic_edges`)
			.all() as Array<{ source_node_ref: NodeRef; target_node_ref: NodeRef }>;

		const crossAgentPrivateEdgeCount = semanticRows.filter((row) => {
			const pair = [row.source_node_ref, row.target_node_ref];
			const owners = pair
				.map((ref) => {
					if (ref.startsWith("private_event:")) {
						const id = Number(ref.split(":")[1]);
						const episodeOwner = db
							.prepare(`SELECT agent_id FROM private_episode_events WHERE id = ?`)
							.get(id) as { agent_id: string } | null;
						if (episodeOwner?.agent_id) return episodeOwner.agent_id;
						const cognitionOwner = db
							.prepare(`SELECT agent_id FROM private_cognition_current WHERE id = ?`)
							.get(id) as { agent_id: string } | null;
						return cognitionOwner?.agent_id ?? null;
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
		const total = 13;

		expect(dialogueRecords).toHaveLength(10);
		passed += 1;

		expect(privateRows.length).toBeGreaterThanOrEqual(2);
		expect(
			privateRows.some((row) => row.category === "action" || row.category === "observation"),
		).toBe(true);
		expect(privateRows.every((row) => row.category.length > 0)).toBe(
			true,
		);
		expect(privateRows.every((row) => row.summary.length > 0)).toBe(
			true,
		);
		expect(
			privateRows.every((row) => row.source_local_ref.startsWith("r")),
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
		expect(belief.stance).toBe("confirmed");
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
		expect(hiddenFromOtherAgent.episodes).toHaveLength(0);
		passed += 1;

		expect(rpSearch.some((row) => row.scope === "private")).toBe(false);
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

	it("explicit cognition becomes searchable after flush organize", async () => {
		const db = freshDb();
		const storage = new GraphStorageService(db as any);
		const coreMemory = new CoreMemoryService(db as any);
		const embeddings = new EmbeddingService(db as any, new TransactionBatcher(db as any));
		const materialization = new MaterializationService(db, storage);
		const retrieval = new RetrievalService(db as any);

		coreMemory.initializeBlocks("agent-1");

		storage.upsertEntity({
			pointerKey: "__self__",
			displayName: "Maid",
			entityType: "person",
			memoryScope: "private_overlay",
			ownerAgentId: "agent-1",
		});
		storage.upsertEntity({
			pointerKey: "__user__",
			displayName: "Master",
			entityType: "person",
			memoryScope: "private_overlay",
			ownerAgentId: "agent-1",
		});

		const provider = new MockModelProvider(
			[
				[],
				[],
				[{ name: "update_index_block", arguments: { new_text: "" } }],
			],
			[
				new Float32Array([1, 0]),
				new Float32Array([0.99, 0.01]),
				new Float32Array([0.98, 0.02]),
			],
		);

		const flushRequest: MemoryFlushRequest = {
			sessionId: "session-rp-1",
			agentId: "agent-1",
			rangeStart: 1,
			rangeEnd: 3,
			flushMode: "dialogue_slice",
			idempotencyKey: "queue:explicit-search-1",
			queueOwnerAgentId: "agent-1",
			dialogueRecords: [
				{ role: "user", content: "I trust you", timestamp: 1000, recordId: "u-trust", recordIndex: 1 },
				{ role: "assistant", content: "Thank you master", timestamp: 1100, recordId: "a-trust", recordIndex: 2 },
			],
			interactionRecords: [
				{
					sessionId: "session-rp-1",
					recordId: "u-trust",
					recordIndex: 1,
					actorType: "user",
					recordType: "message",
					payload: { role: "user", content: "I trust you" },
					correlatedTurnId: "req-trust",
					committedAt: 1000,
				},
				{
					sessionId: "session-rp-1",
					recordId: "a-trust",
					recordIndex: 2,
					actorType: "rp_agent",
					recordType: "message",
					payload: { role: "assistant", content: "Thank you master" },
					correlatedTurnId: "req-trust",
					committedAt: 1100,
				},
				{
					sessionId: "session-rp-1",
					recordId: "stl:req-trust",
					recordIndex: 3,
					actorType: "rp_agent",
					recordType: "turn_settlement",
					payload: {
						settlementId: "stl:req-trust",
						requestId: "req-trust",
						sessionId: "session-rp-1",
						ownerAgentId: "agent-1",
						publicReply: "Thank you master",
						hasPublicReply: true,
						viewerSnapshot: {
							selfPointerKey: "__self__",
							userPointerKey: "__user__",
						},
						privateCognition: {
							schemaVersion: "rp_private_cognition_v4",
							ops: [
								{
									op: "upsert",
									record: {
										kind: "assertion",
										key: "assert:master-trusts-me",
										proposition: {
											subject: { kind: "special", value: "user" },
											predicate: "trusts",
											object: { kind: "entity", ref: { kind: "special", value: "self" } },
										},
										stance: "accepted",
									},
								},
							],
						},
					},
					correlatedTurnId: "req-trust",
					committedAt: 1150,
				},
			],
		};

		const taskAgent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);
		const migration = await taskAgent.runMigrate(flushRequest);

		const beliefRow = db
			.prepare(`SELECT id FROM agent_fact_overlay WHERE cognition_key = 'assert:master-trusts-me'`)
			.get() as { id: number } | null;
		expect(beliefRow).not.toBeNull();
		const beliefRef = makeNodeRef("assertion", beliefRow!.id);

		await taskAgent.runOrganize({
			agentId: "agent-1",
			sessionId: "session-rp-1",
			batchId: "explicit-organize-1",
			changedNodeRefs: [beliefRef],
			embeddingModelId: "memory-task-organizer-v1",
		});

		const privateSearchDocs = db
			.prepare(
				`SELECT content FROM search_docs_private WHERE agent_id = 'agent-1' AND source_ref = ?`,
			)
			.all(beliefRef) as Array<{ content: string }>;
		expect(privateSearchDocs.length).toBeGreaterThanOrEqual(1);
		expect(privateSearchDocs.some((doc) => doc.content.includes("trusts"))).toBe(true);

		const searchResults = await retrieval.searchVisibleNarrative("trusts", makeViewer());
		expect(searchResults.some((row) => row.scope === "private")).toBe(false);
	});

	it("retracted explicit cognition is removed from private search docs after organizer", async () => {
		const db = freshDb();
		const storage = new GraphStorageService(db as any);
		const coreMemory = new CoreMemoryService(db as any);
		const embeddings = new EmbeddingService(db as any, new TransactionBatcher(db as any));
		const materialization = new MaterializationService(db, storage);
		const retrieval = new RetrievalService(db as any);

		coreMemory.initializeBlocks("agent-1");

		storage.upsertEntity({
			pointerKey: "__self__",
			displayName: "Maid",
			entityType: "person",
			memoryScope: "private_overlay",
			ownerAgentId: "agent-1",
		});
		storage.upsertEntity({
			pointerKey: "__user__",
			displayName: "Master",
			entityType: "person",
			memoryScope: "private_overlay",
			ownerAgentId: "agent-1",
		});

		const provider = new MockModelProvider(
			[
				[],
				[],
				[{ name: "update_index_block", arguments: { new_text: "" } }],
				[{ name: "update_index_block", arguments: { new_text: "" } }],
			],
			[
				new Float32Array([1, 0]),
				new Float32Array([0.99, 0.01]),
				new Float32Array([0.98, 0.02]),
				new Float32Array([0.97, 0.03]),
			],
		);

		// Step 1: Create an explicit assertion via flush pipeline
		const flushRequest: MemoryFlushRequest = {
			sessionId: "session-rp-1",
			agentId: "agent-1",
			rangeStart: 1,
			rangeEnd: 3,
			flushMode: "dialogue_slice",
			idempotencyKey: "queue:retract-search-1",
			queueOwnerAgentId: "agent-1",
			dialogueRecords: [
				{ role: "user", content: "I trust you completely", timestamp: 2000, recordId: "u-retract", recordIndex: 1 },
				{ role: "assistant", content: "Thank you master", timestamp: 2100, recordId: "a-retract", recordIndex: 2 },
			],
			interactionRecords: [
				{
					sessionId: "session-rp-1",
					recordId: "u-retract",
					recordIndex: 1,
					actorType: "user",
					recordType: "message",
					payload: { role: "user", content: "I trust you completely" },
					correlatedTurnId: "req-retract",
					committedAt: 2000,
				},
				{
					sessionId: "session-rp-1",
					recordId: "a-retract",
					recordIndex: 2,
					actorType: "rp_agent",
					recordType: "message",
					payload: { role: "assistant", content: "Thank you master" },
					correlatedTurnId: "req-retract",
					committedAt: 2100,
				},
				{
					sessionId: "session-rp-1",
					recordId: "stl:req-retract",
					recordIndex: 3,
					actorType: "rp_agent",
					recordType: "turn_settlement",
					payload: {
						settlementId: "stl:req-retract",
						requestId: "req-retract",
						sessionId: "session-rp-1",
						ownerAgentId: "agent-1",
						publicReply: "Thank you master",
						hasPublicReply: true,
						viewerSnapshot: {
							selfPointerKey: "__self__",
							userPointerKey: "__user__",
						},
						privateCognition: {
							schemaVersion: "rp_private_cognition_v4",
							ops: [
								{
									op: "upsert",
									record: {
										kind: "assertion",
										key: "assert:master-loyalty",
										proposition: {
											subject: { kind: "special", value: "user" },
											predicate: "is loyal to",
											object: { kind: "entity", ref: { kind: "special", value: "self" } },
										},
										stance: "accepted",
									},
								},
							],
						},
					},
					correlatedTurnId: "req-retract",
					committedAt: 2150,
				},
			],
		};

		const taskAgent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);
		const migration = await taskAgent.runMigrate(flushRequest);

		const beliefRow = db
			.prepare(`SELECT id FROM agent_fact_overlay WHERE cognition_key = 'assert:master-loyalty'`)
			.get() as { id: number } | null;
		expect(beliefRow).not.toBeNull();
		const beliefRef = makeNodeRef("assertion", beliefRow!.id);

		// Step 2: Run organizer — verify search_docs_private has the entry
		await taskAgent.runOrganize({
			agentId: "agent-1",
			sessionId: "session-rp-1",
			batchId: "retract-organize-1",
			changedNodeRefs: [beliefRef],
			embeddingModelId: "memory-task-organizer-v1",
		});

		const docsBeforeRetract = db
			.prepare(`SELECT content FROM search_docs_private WHERE source_ref = ?`)
			.all(beliefRef) as Array<{ content: string }>;
		expect(docsBeforeRetract.length).toBeGreaterThanOrEqual(1);
		expect(docsBeforeRetract.some((doc) => doc.content.includes("loyal"))).toBe(true);

		// Step 3: Retract the assertion
		storage.retractExplicitCognition("agent-1", "assert:master-loyalty", "assertion");

		// Verify the row is now retracted
		const retractedRow = db
			.prepare(`SELECT stance FROM agent_fact_overlay WHERE id = ?`)
			.get(beliefRow!.id) as { stance: string };
		expect(retractedRow.stance).toBe("rejected");

		// Step 4: Run organizer again with the retracted ref in changedNodeRefs
		await taskAgent.runOrganize({
			agentId: "agent-1",
			sessionId: "session-rp-1",
			batchId: "retract-organize-2",
			changedNodeRefs: [beliefRef],
			embeddingModelId: "memory-task-organizer-v1",
		});

		// Step 5: Verify search_docs_private entry is DELETED
		const docsAfterRetract = db
			.prepare(`SELECT content FROM search_docs_private WHERE source_ref = ?`)
			.all(beliefRef) as Array<{ content: string }>;
		expect(docsAfterRetract.length).toBe(0);

		// Also verify it no longer appears in search results
		const searchResults = await retrieval.searchVisibleNarrative("loyal", makeViewer());
		expect(searchResults.some((row) => row.scope === "private")).toBe(false);
	});
});
