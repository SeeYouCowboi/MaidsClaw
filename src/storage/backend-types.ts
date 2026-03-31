/**
 * Backend type definitions for MaidsClaw storage layer.
 *
 * Phase 2A: Type definitions and backend selection contract.
 * Phase 2B (T7): PgBackendFactory fully implemented.
 */

import type postgres from "postgres";
import { bootstrapDerivedSchema } from "./pg-app-schema-derived.js";
import { bootstrapOpsSchema } from "./pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "./pg-app-schema-truth.js";
import { createPgPool } from "./pg-pool.js";

export type BackendType = "sqlite" | "pg";

export function isSqliteFreezeEnabled(): boolean {
	return process.env.MAIDSCLAW_SQLITE_FREEZE === "true";
}

export interface PgPoolConfig {
	url: string;
	max?: number; // default: 10
	connect_timeout?: number; // seconds, default: 30
	idle_timeout?: number; // seconds, default: 300
	max_lifetime?: number; // seconds, default: 3600
	statement_timeout?: number; // ms, optional
}

export interface BackendConfig {
	type: BackendType;
	pg?: PgPoolConfig; // required when type='pg'
	sqlite?: {
		dbPath: string;
	};
}

/**
 * Resolve the backend type from environment variable.
 * Defaults to 'sqlite' if not set or invalid.
 *
 * Env var: MAIDSCLAW_BACKEND
 * Valid values: 'sqlite', 'pg'
 */
export function resolveBackendType(): BackendType {
	const val = process.env.MAIDSCLAW_BACKEND;
	const resolvedType: BackendType = val === "pg" ? "pg" : "sqlite";

	if (resolvedType === "sqlite" && isSqliteFreezeEnabled()) {
		throw new Error(
			"SQLite writes are frozen (MAIDSCLAW_SQLITE_FREEZE=true). Use MAIDSCLAW_BACKEND=pg to start in PG mode.",
		);
	}

	return resolvedType;
}

/**
 * Backend factory interface.
 */
export interface BackendFactory {
	readonly type: BackendType;
	/** Initialize the backend (open DB connection, create pool, etc.) */
	initialize(config: BackendConfig): Promise<void>;
	/** Gracefully close the backend */
	close(): Promise<void>;
}

/**
 * Placeholder SQLite backend factory.
 * SQLite bootstrap is handled directly in runtime.ts (sync path).
 * This factory exists for interface symmetry — full implementation deferred.
 */
export class SqliteBackendFactory implements BackendFactory {
	readonly type = "sqlite" as const;

	async initialize(_config: BackendConfig): Promise<void> {
		throw new Error("SqliteBackendFactory not yet implemented (T7)");
	}

	async close(): Promise<void> {
		throw new Error("SqliteBackendFactory not yet implemented (T7)");
	}
}

/**
 * PostgreSQL backend factory — creates a PG connection pool and
 * bootstraps all three app schema layers (truth, ops, derived).
 */
export class PgBackendFactory implements BackendFactory {
	readonly type = "pg" as const;
	private pool: postgres.Sql | null = null;

	async initialize(config: BackendConfig): Promise<void> {
		if (!config.pg) throw new Error("PgBackendFactory requires config.pg");
		const { url, ...poolConfig } = config.pg;
		this.pool = createPgPool(url, poolConfig);
		await bootstrapTruthSchema(this.pool);
		await bootstrapOpsSchema(this.pool);
		await bootstrapDerivedSchema(this.pool);
	}

	async close(): Promise<void> {
		if (this.pool) {
			await this.pool.end();
			this.pool = null;
		}
	}

	getPool(): postgres.Sql {
		if (!this.pool) throw new Error("PgBackendFactory not initialized");
		return this.pool;
	}
}
