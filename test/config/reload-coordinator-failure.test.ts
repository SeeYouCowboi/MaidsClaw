import { describe, expect, it, mock } from "bun:test";
import { createReloadable } from "../../src/config/reloadable.js";

describe("reload coordinator failure path", () => {
	it("returns ok false with error when load throws", async () => {
		const expectedError = new Error("reload failed");
		const reloadable = createReloadable({
			initial: { status: "stable" },
			load: async () => {
				throw expectedError;
			},
			onReloadError: () => {},
		});

		const result = await reloadable.reload();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe(expectedError);
		}
	});

	it("keeps pre-reload snapshot when load throws", async () => {
		const initial = { provider: "stable", version: 1 };
		const reloadable = createReloadable({
			initial,
			load: async () => {
				throw new Error("cannot reload");
			},
			onReloadError: () => {},
		});

		await reloadable.reload();
		expect(reloadable.get()).toBe(initial);
	});

	it("calls onReloadError callback on failure", async () => {
		const onReloadError = mock((_: Error) => {});
		const failure = new Error("boom");
		const reloadable = createReloadable({
			initial: { ok: true },
			load: async () => {
				throw failure;
			},
			onReloadError,
		});

		await reloadable.reload();
		expect(onReloadError).toHaveBeenCalledTimes(1);
		expect(onReloadError).toHaveBeenCalledWith(failure);
	});
});
