import { describe, expect, it } from "bun:test";
import { createReloadable } from "../../src/config/reloadable.js";

describe("reload coordinator success path", () => {
	it("returns initial snapshot before any reload", () => {
		const initial = { version: 1, personas: ["alpha"] };
		const reloadable = createReloadable({
			initial,
			load: async () => ({ version: 2, personas: ["beta"] }),
		});

		expect(reloadable.get()).toBe(initial);
	});

	it("reload swaps snapshot and subsequent get returns new snapshot", async () => {
		const initial = { version: 1, personas: ["alpha"] };
		const next = { version: 2, personas: ["beta"] };
		const reloadable = createReloadable({
			initial,
			load: async () => next,
		});

		const result = await reloadable.reload();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.snapshot).toBe(next);
		}
		expect(reloadable.get()).toBe(next);
	});

	it("captured pre-reload snapshot remains old reference", async () => {
		const initial = { version: 1, entries: [{ id: "old" }] };
		const next = { version: 2, entries: [{ id: "new" }] };
		const reloadable = createReloadable({
			initial,
			load: async () => next,
		});

		const snap1 = reloadable.get();
		await reloadable.reload();
		const snap2 = reloadable.get();

		expect(snap1).toBe(initial);
		expect(snap2).toBe(next);
		expect(snap1).not.toBe(snap2);
		expect(snap1.entries[0]?.id).toBe("old");
	});

	it("reload returns ok true on success", async () => {
		const reloadable = createReloadable({
			initial: { ready: false },
			load: async () => ({ ready: true }),
		});

		const result = await reloadable.reload();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.snapshot).toEqual({ ready: true });
		}
	});
});
