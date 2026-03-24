import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createMemorySchema } from "./schema";

function freshDb(): Database {
	const db = new Database(":memory:");
	createMemorySchema(db);
	return db;
}

const AGENT = "agent-rp-1";
const NOW = Date.now();

function insertOverlay(
	db: Database,
	overrides: Partial<{
		agent_id: string;
		cognition_key: string;
		stance: string;
		basis: string;
		pre_contested_stance: string | null;
	}> = {},
) {
	const vals = {
		agent_id: AGENT,
		cognition_key: `fact-${Math.random().toString(36).slice(2, 8)}`,
		stance: "accepted",
		basis: "first_hand",
		pre_contested_stance: null,
		...overrides,
	};
	db.prepare(
		`INSERT INTO agent_fact_overlay (agent_id, source_entity_id, target_entity_id, predicate, basis, stance, pre_contested_stance, cognition_key, created_at, updated_at)
     VALUES (?, 1, 2, 'knows', ?, ?, ?, ?, ?, ?)`,
	).run(
		vals.agent_id,
		vals.basis,
		vals.stance,
		vals.pre_contested_stance,
		vals.cognition_key,
		NOW,
		NOW,
	);
	return vals.cognition_key;
}

describe("contested chain lifecycle — agent_fact_overlay", () => {
	it("assertion → contested transition stores pre_contested_stance", () => {
		const db = freshDb();
		const key = insertOverlay(db, { stance: "accepted" });

		db.prepare(
			`UPDATE agent_fact_overlay SET stance = 'contested', pre_contested_stance = 'accepted', updated_at = ? WHERE agent_id = ? AND cognition_key = ?`,
		).run(NOW + 1, AGENT, key);

		const row = db
			.prepare(
				`SELECT stance, pre_contested_stance FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?`,
			)
			.get(AGENT, key) as { stance: string; pre_contested_stance: string | null };

		expect(row.stance).toBe("contested");
		expect(row.pre_contested_stance).toBe("accepted");
		db.close();
	});

	it("contested → rejected resolution clears pre_contested_stance", () => {
		const db = freshDb();
		const key = insertOverlay(db, { stance: "contested", pre_contested_stance: "tentative" });

		db.prepare(
			`UPDATE agent_fact_overlay SET stance = 'rejected', pre_contested_stance = NULL, updated_at = ? WHERE agent_id = ? AND cognition_key = ?`,
		).run(NOW + 1, AGENT, key);

		const row = db
			.prepare(
				`SELECT stance, pre_contested_stance FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?`,
			)
			.get(AGENT, key) as { stance: string; pre_contested_stance: string | null };

		expect(row.stance).toBe("rejected");
		expect(row.pre_contested_stance).toBeNull();
		db.close();
	});

	it("CHECK rejects pre_contested_stance when stance is not contested", () => {
		const db = freshDb();

		expect(() => {
			db.prepare(
				`INSERT INTO agent_fact_overlay (agent_id, source_entity_id, target_entity_id, predicate, stance, pre_contested_stance, cognition_key, created_at, updated_at)
         VALUES (?, 1, 2, 'knows', 'accepted', 'tentative', ?, ?, ?)`,
			).run(AGENT, "bad-key", NOW, NOW);
		}).toThrow();
		db.close();
	});

	it("demotion path: contested → preContestedStance-1 restores original stance", () => {
		const db = freshDb();
		const key = insertOverlay(db, { stance: "confirmed" });

		db.prepare(
			`UPDATE agent_fact_overlay SET stance = 'contested', pre_contested_stance = 'confirmed', updated_at = ? WHERE agent_id = ? AND cognition_key = ?`,
		).run(NOW + 1, AGENT, key);

		const contested = db
			.prepare(`SELECT pre_contested_stance FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?`)
			.get(AGENT, key) as { pre_contested_stance: string };
		const restoreStance = contested.pre_contested_stance;

		db.prepare(
			`UPDATE agent_fact_overlay SET stance = ?, pre_contested_stance = NULL, updated_at = ? WHERE agent_id = ? AND cognition_key = ?`,
		).run(restoreStance, NOW + 2, AGENT, key);

		const row = db
			.prepare(`SELECT stance, pre_contested_stance FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?`)
			.get(AGENT, key) as { stance: string; pre_contested_stance: string | null };

		expect(row.stance).toBe("confirmed");
		expect(row.pre_contested_stance).toBeNull();
		db.close();
	});
});
