import { afterEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";
import type { GatewayContext, LoreAdminService } from "../../src/gateway/context.js";
import { MaidsClawError } from "../../src/core/errors.js";

type LoreDto = {
	id: string;
	title: string;
	keywords: string[];
	content: string;
	scope: string;
	priority: number;
	enabled: boolean;
	tags: string[];
};

function makeLoreEntry(overrides: Partial<LoreDto> = {}): LoreDto {
	return {
		id: overrides.id ?? "lore-001",
		title: overrides.title ?? "World Rules",
		keywords: overrides.keywords ?? ["world"],
		content: overrides.content ?? "This is a test lore entry.",
		scope: overrides.scope ?? "world",
		priority: overrides.priority ?? 10,
		enabled: overrides.enabled ?? true,
		tags: overrides.tags ?? ["core"],
	};
}

function stubLoreAdmin(entries: LoreDto[] = []): LoreAdminService {
	const store = [...entries];

	return {
		async listLore(filters?: { scope?: string; keyword?: string }) {
			let result = [...store];
			if (filters?.scope) {
				result = result.filter((e) => e.scope === filters.scope);
			}
			if (filters?.keyword) {
				const needle = filters.keyword.toLowerCase();
				result = result.filter(
					(e) =>
						e.keywords.some((k) => k.toLowerCase().includes(needle)) ||
						e.title.toLowerCase().includes(needle),
				);
			}
			return result.sort((a, b) => {
				const p = b.priority - a.priority;
				if (p !== 0) return p;
				return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
			});
		},

		async getLore(loreId: string) {
			return store.find((e) => e.id === loreId) ?? null;
		},

		async createLore(input: unknown) {
			const entry = input as LoreDto;
			if (store.some((e) => e.id === entry.id)) {
				throw new MaidsClawError({
					code: "CONFLICT",
					message: `Lore entry already exists: ${entry.id}`,
					retriable: false,
				});
			}
			store.push(entry);
			return entry;
		},

		async updateLore(loreId: string, input: unknown) {
			const entry = input as LoreDto;
			const idx = store.findIndex((e) => e.id === loreId);
			if (idx < 0) {
				throw new MaidsClawError({
					code: "BAD_REQUEST",
					message: `Lore entry not found: ${loreId}`,
					retriable: false,
				});
			}
			store[idx] = entry;
			return entry;
		},

		async deleteLore(loreId: string) {
			const idx = store.findIndex((e) => e.id === loreId);
			if (idx < 0) {
				throw new MaidsClawError({
					code: "BAD_REQUEST",
					message: `Lore entry not found: ${loreId}`,
					retriable: false,
				});
			}
			store.splice(idx, 1);
		},
	};
}

describe("lore CRUD routes", () => {
	let server: GatewayServer;
	let baseUrl: string;

	function startServer(ctx: GatewayContext) {
		server = new GatewayServer({ port: 0, host: "localhost", context: ctx });
		server.start();
		baseUrl = `http://localhost:${server.getPort()}`;
	}

	afterEach(() => {
		server?.stop();
	});

	describe("GET /v1/lore", () => {
		it("returns empty list when no entries exist", async () => {
			startServer({ loreAdmin: stubLoreAdmin() });

			const res = await fetch(`${baseUrl}/v1/lore`);
			expect(res.status).toBe(200);

			const body = (await res.json()) as { items: LoreDto[] };
			expect(body.items).toEqual([]);
		});

		it("returns all entries sorted by priority DESC then id ASC", async () => {
			const entries = [
				makeLoreEntry({ id: "b-low", priority: 1 }),
				makeLoreEntry({ id: "a-high", priority: 10 }),
				makeLoreEntry({ id: "c-high", priority: 10 }),
			];
			startServer({ loreAdmin: stubLoreAdmin(entries) });

			const res = await fetch(`${baseUrl}/v1/lore`);
			expect(res.status).toBe(200);

			const body = (await res.json()) as { items: LoreDto[] };
			expect(body.items).toHaveLength(3);
			expect(body.items[0].id).toBe("a-high");
			expect(body.items[1].id).toBe("c-high");
			expect(body.items[2].id).toBe("b-low");
		});

		it("filters by scope query param", async () => {
			const entries = [
				makeLoreEntry({ id: "world-1", scope: "world" }),
				makeLoreEntry({ id: "area-1", scope: "area" }),
			];
			startServer({ loreAdmin: stubLoreAdmin(entries) });

			const res = await fetch(`${baseUrl}/v1/lore?scope=area`);
			expect(res.status).toBe(200);

			const body = (await res.json()) as { items: LoreDto[] };
			expect(body.items).toHaveLength(1);
			expect(body.items[0].id).toBe("area-1");
		});

		it("filters by keyword query param", async () => {
			const entries = [
				makeLoreEntry({ id: "match", keywords: ["magic", "lore"] }),
				makeLoreEntry({ id: "no-match", keywords: ["tech"] }),
			];
			startServer({ loreAdmin: stubLoreAdmin(entries) });

			const res = await fetch(`${baseUrl}/v1/lore?keyword=magic`);
			expect(res.status).toBe(200);

			const body = (await res.json()) as { items: LoreDto[] };
			expect(body.items).toHaveLength(1);
			expect(body.items[0].id).toBe("match");
		});
	});

	describe("GET /v1/lore/{lore_id}", () => {
		it("returns a single lore entry", async () => {
			const entry = makeLoreEntry({ id: "lore-42" });
			startServer({ loreAdmin: stubLoreAdmin([entry]) });

			const res = await fetch(`${baseUrl}/v1/lore/lore-42`);
			expect(res.status).toBe(200);

			const body = (await res.json()) as LoreDto;
			expect(body.id).toBe("lore-42");
			expect(body.title).toBe("World Rules");
		});

		it("returns 404 when lore entry not found", async () => {
			startServer({ loreAdmin: stubLoreAdmin() });

			const res = await fetch(`${baseUrl}/v1/lore/nonexistent`);
			expect(res.status).toBe(404);
		});
	});

	describe("POST /v1/lore", () => {
		it("creates a new lore entry and returns 201", async () => {
			startServer({ loreAdmin: stubLoreAdmin() });

			const payload = makeLoreEntry({ id: "new-lore" });
			const res = await fetch(`${baseUrl}/v1/lore`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(201);

			const body = (await res.json()) as LoreDto;
			expect(body.id).toBe("new-lore");
		});

		it("returns 409 on duplicate id", async () => {
			const existing = makeLoreEntry({ id: "dup" });
			startServer({ loreAdmin: stubLoreAdmin([existing]) });

			const res = await fetch(`${baseUrl}/v1/lore`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(makeLoreEntry({ id: "dup" })),
			});
			expect(res.status).toBe(409);

			const body = (await res.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("CONFLICT");
		});

		it("returns 400 on invalid JSON body", async () => {
			startServer({ loreAdmin: stubLoreAdmin() });

			const res = await fetch(`${baseUrl}/v1/lore`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not json",
			});
			expect(res.status).toBe(400);
		});
	});

	describe("PUT /v1/lore/{lore_id}", () => {
		it("updates an existing entry", async () => {
			const entry = makeLoreEntry({ id: "upd-1", title: "Old Title" });
			startServer({ loreAdmin: stubLoreAdmin([entry]) });

			const updated = { ...entry, title: "New Title" };
			const res = await fetch(`${baseUrl}/v1/lore/upd-1`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(updated),
			});
			expect(res.status).toBe(200);

			const body = (await res.json()) as LoreDto;
			expect(body.title).toBe("New Title");
		});

		it("returns 400 on not found", async () => {
			startServer({ loreAdmin: stubLoreAdmin() });

			const payload = makeLoreEntry({ id: "missing" });
			const res = await fetch(`${baseUrl}/v1/lore/missing`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(400);
		});
	});

	describe("DELETE /v1/lore/{lore_id}", () => {
		it("deletes an existing entry", async () => {
			const entry = makeLoreEntry({ id: "del-1" });
			startServer({ loreAdmin: stubLoreAdmin([entry]) });

			const res = await fetch(`${baseUrl}/v1/lore/del-1`, {
				method: "DELETE",
			});
			expect(res.status).toBe(200);

			const body = (await res.json()) as { deleted: boolean };
			expect(body.deleted).toBe(true);
		});

		it("returns 404 when entry not found for delete", async () => {
			startServer({ loreAdmin: stubLoreAdmin() });

			const res = await fetch(`${baseUrl}/v1/lore/nonexistent`, {
				method: "DELETE",
			});
			expect(res.status).toBe(404);
		});
	});

	describe("snake_case wire format", () => {
		it("all lore DTO fields use snake_case (no camelCase keys)", async () => {
			const entry = makeLoreEntry({ id: "case-check" });
			startServer({ loreAdmin: stubLoreAdmin([entry]) });

			const res = await fetch(`${baseUrl}/v1/lore/case-check`);
			expect(res.status).toBe(200);

			const raw = (await res.text());
			expect(raw).not.toContain("camelCase");
			expect(raw).not.toContain("loreId");
			expect(raw).not.toContain("loreScope");

			const body = JSON.parse(raw) as Record<string, unknown>;
			const keys = Object.keys(body);
			for (const key of keys) {
				expect(key).toBe(key.toLowerCase());
			}
		});
	});
});
