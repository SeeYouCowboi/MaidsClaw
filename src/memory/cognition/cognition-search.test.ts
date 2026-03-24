import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryMigrations } from "../schema.js";
import { GraphStorageService } from "../storage.js";
import { openDatabase } from "../../storage/database.js";
import { CognitionRepository } from "./cognition-repo.js";
import { CognitionSearchService } from "./cognition-search.js";
import { RelationBuilder, CONFLICTS_WITH } from "./relation-builder.js";

function createTempDb() {
	const dbPath = join(tmpdir(), `maidsclaw-cognition-search-${randomUUID()}.db`);
	const db = openDatabase({ path: dbPath });
	runMemoryMigrations(db);
	return { dbPath, db };
}

function cleanupDb(dbPath: string): void {
	try {
		rmSync(dbPath, { force: true });
		rmSync(`${dbPath}-shm`, { force: true });
		rmSync(`${dbPath}-wal`, { force: true });
	} catch {}
}

function seedEntities(storage: GraphStorageService) {
	storage.upsertEntity({
		pointerKey: "__self__",
		displayName: "Alice",
		entityType: "person",
		memoryScope: "shared_public",
	});
	storage.upsertEntity({
		pointerKey: "__user__",
		displayName: "User",
		entityType: "person",
		memoryScope: "shared_public",
	});
	storage.upsertEntity({
		pointerKey: "bob",
		displayName: "Bob",
		entityType: "person",
		memoryScope: "shared_public",
	});
}

const AGENT_ID = "rp:alice";

describe("CognitionSearchService — conflictEvidence", () => {
	it("contested assertion with conflicts_with relations returns structured conflictEvidence objects", () => {
		const { dbPath, db } = createTempDb();
		const storage = new GraphStorageService(db);
		seedEntities(storage);

		try {
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "test:factor-assertion",
				settlementId: "stl:ce-factor",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "knows",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const factorAssertion = db
				.prepare(`SELECT id FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ? LIMIT 1`)
				.get(AGENT_ID, "test:factor-assertion") as { id: number };

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "test:conflict-evidence",
				settlementId: "stl:ce-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "test:conflict-evidence",
				settlementId: "stl:ce-2",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "contested",
				basis: "first_hand",
				preContestedStance: "accepted",
			});

			const searchBefore = new CognitionSearchService(db);
			const hitsBefore = searchBefore.searchCognition({
				agentId: AGENT_ID,
				kind: "assertion",
				stance: "contested",
			});
			expect(hitsBefore.length).toBe(1);
			const sourceRef = String(hitsBefore[0].source_ref);

			const relationBuilder = new RelationBuilder(db);
			relationBuilder.writeContestRelations(
				sourceRef,
				["cognition_key:test:factor-assertion", "private_belief:42"],
				"stl:ce-2",
				0.9,
			);

			const search = new CognitionSearchService(db);
			const hits = search.searchCognition({
				agentId: AGENT_ID,
				kind: "assertion",
				stance: "contested",
			});

			expect(hits.length).toBe(1);
			const hit = hits[0];
			expect(hit.stance).toBe("contested");
			expect(hit.conflictEvidence).toBeDefined();
			expect(Array.isArray(hit.conflictEvidence)).toBe(true);
			expect(hit.conflictEvidence!.length).toBe(2);

			const first = hit.conflictEvidence![0];
			expect(typeof first).toBe("object");
			expect("targetRef" in first).toBe(true);
			expect("strength" in first).toBe(true);
			expect("sourceKind" in first).toBe(true);
			expect("sourceRef" in first).toBe(true);

			expect(hit.conflictEvidence!.every((e) => typeof e === "object" && e !== null)).toBe(true);
			expect(first.strength).toBe(0.9);
			expect(first.sourceRef).toBe("stl:ce-2");
			expect(hit.conflictEvidence!.every((e) => !e.targetRef.startsWith("cognition_key:"))).toBe(true);
			expect(hit.conflictEvidence!.some((e) => e.targetRef === `assertion:${factorAssertion.id}`)).toBe(true);
		} finally {
			try { db.close(); } catch {}
			cleanupDb(dbPath);
		}
	});

	it("contested assertion without conflicts_with relations returns empty conflictEvidence", () => {
		const { dbPath, db } = createTempDb();
		const storage = new GraphStorageService(db);
		seedEntities(storage);

		try {
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "test:no-evidence",
				settlementId: "stl:ne-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "test:no-evidence",
				settlementId: "stl:ne-2",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "contested",
				basis: "first_hand",
				preContestedStance: "accepted",
			});

			const search = new CognitionSearchService(db);
			const hits = search.searchCognition({
				agentId: AGENT_ID,
				kind: "assertion",
				stance: "contested",
			});

			expect(hits.length).toBe(1);
			const hit = hits[0];
			expect(hit.stance).toBe("contested");
			// No relations → empty array
			expect(hit.conflictEvidence).toEqual([]);
		} finally {
			try { db.close(); } catch {}
			cleanupDb(dbPath);
		}
	});

	it("non-contested assertions have no conflictEvidence", () => {
		const { dbPath, db } = createTempDb();
		const storage = new GraphStorageService(db);
		seedEntities(storage);

		try {
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "test:accepted-only",
				settlementId: "stl:ao-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const search = new CognitionSearchService(db);
			const hits = search.searchCognition({
				agentId: AGENT_ID,
				kind: "assertion",
				stance: "accepted",
			});

			expect(hits.length).toBe(1);
			expect(hits[0].conflictEvidence).toBeUndefined();
		} finally {
			try { db.close(); } catch {}
			cleanupDb(dbPath);
		}
	});

	it("conflictEvidence is capped at 3 items, strongest-first", () => {
		const { dbPath, db } = createTempDb();
		const storage = new GraphStorageService(db);
		seedEntities(storage);

		try {
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "test:capped",
				settlementId: "stl:cap-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "test:capped",
				settlementId: "stl:cap-2",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "contested",
				basis: "first_hand",
				preContestedStance: "accepted",
			});

			const searchTemp = new CognitionSearchService(db);
			const hitsTemp = searchTemp.searchCognition({
				agentId: AGENT_ID,
				kind: "assertion",
				stance: "contested",
			});
			const sourceRef = String(hitsTemp[0].source_ref);

			// Write 5 relations with different strengths
			const relationBuilder = new RelationBuilder(db);
			const targets = ["assertion:10", "assertion:20", "assertion:30", "assertion:40", "assertion:50"];
			const strengths = [0.5, 0.9, 0.3, 1.0, 0.7];
			for (let i = 0; i < targets.length; i++) {
				relationBuilder.writeContestRelations(sourceRef, [targets[i]], `stl:cap-${i}`, strengths[i]);
			}

			const search = new CognitionSearchService(db);
			const hits = search.searchCognition({
				agentId: AGENT_ID,
				kind: "assertion",
				stance: "contested",
			});

			expect(hits.length).toBe(1);
			const evidence = hits[0].conflictEvidence!;
			expect(evidence.length).toBe(3); // capped at 3

			// Strongest-first: 1.0, 0.9, 0.7
			expect(evidence[0].strength).toBe(1.0);
			expect(evidence[1].strength).toBe(0.9);
			expect(evidence[2].strength).toBe(0.7);
		} finally {
			try { db.close(); } catch {}
			cleanupDb(dbPath);
		}
	});
});
