import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	PgBackendFactory,
	SqliteBackendFactory,
	resolveBackendType,
} from "../../src/storage/backend-types.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("backend-selection", () => {
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalEnv = process.env.MAIDSCLAW_BACKEND;
		delete process.env.MAIDSCLAW_BACKEND;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.MAIDSCLAW_BACKEND;
		} else {
			process.env.MAIDSCLAW_BACKEND = originalEnv;
		}
	});

	describe("resolveBackendType", () => {
		it("returns 'sqlite' when no env var is set", () => {
			delete process.env.MAIDSCLAW_BACKEND;
			const result = resolveBackendType();
			expect(result).toBe("sqlite");
		});

		it("returns 'pg' when MAIDSCLAW_BACKEND=pg", () => {
			process.env.MAIDSCLAW_BACKEND = "pg";
			const result = resolveBackendType();
			expect(result).toBe("pg");
		});

		it("returns 'sqlite' when MAIDSCLAW_BACKEND=sqlite", () => {
			process.env.MAIDSCLAW_BACKEND = "sqlite";
			const result = resolveBackendType();
			expect(result).toBe("sqlite");
		});

		it("defaults to 'sqlite' for invalid values", () => {
			process.env.MAIDSCLAW_BACKEND = "invalid";
			const result = resolveBackendType();
			expect(result).toBe("sqlite");

			process.env.MAIDSCLAW_BACKEND = "postgres";
			expect(resolveBackendType()).toBe("sqlite");

			process.env.MAIDSCLAW_BACKEND = "";
			expect(resolveBackendType()).toBe("sqlite");
		});
	});

	describe("BackendFactory placeholders", () => {
		it("SqliteBackendFactory has correct type", () => {
			const factory = new SqliteBackendFactory();
			expect(factory.type).toBe("sqlite");
		});

		it("PgBackendFactory has correct type", () => {
			const factory = new PgBackendFactory();
			expect(factory.type).toBe("pg");
		});

		it("SqliteBackendFactory.initialize throws not implemented", async () => {
			const factory = new SqliteBackendFactory();
			await expect(factory.initialize({ type: "sqlite" })).rejects.toThrow(
				"SqliteBackendFactory not yet implemented (T7)",
			);
		});

		it("PgBackendFactory.initialize rejects without config.pg", async () => {
			const factory = new PgBackendFactory();
			await expect(
				factory.initialize({ type: "pg" }),
			).rejects.toThrow("PgBackendFactory requires config.pg");
		});
	});
});
