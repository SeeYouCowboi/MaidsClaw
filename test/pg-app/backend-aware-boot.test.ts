import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	PgBackendFactory,
	resolveBackendType,
} from "../../src/storage/backend-types.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("backend-aware-boot", () => {
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

	it("resolveBackendType returns 'sqlite' when MAIDSCLAW_BACKEND is unset", () => {
		delete process.env.MAIDSCLAW_BACKEND;
		expect(resolveBackendType()).toBe("sqlite");
	});

	it("resolveBackendType returns 'pg' when MAIDSCLAW_BACKEND='pg'", () => {
		process.env.MAIDSCLAW_BACKEND = "pg";
		expect(resolveBackendType()).toBe("pg");
	});

	it("PgBackendFactory has type === 'pg'", () => {
		const factory = new PgBackendFactory();
		expect(factory.type).toBe("pg");
	});

	it("PgBackendFactory.getPool throws when not initialized", () => {
		const factory = new PgBackendFactory();
		expect(() => factory.getPool()).toThrow("PgBackendFactory not initialized");
	});

	it("PgBackendFactory.initialize rejects without pg config", async () => {
		const factory = new PgBackendFactory();
		await expect(factory.initialize({ type: "pg" })).rejects.toThrow(
			"PgBackendFactory requires config.pg",
		);
	});
});
