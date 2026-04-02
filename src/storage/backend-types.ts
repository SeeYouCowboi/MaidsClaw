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

export type BackendType = "pg";

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
}

export function resolveBackendType(): BackendType {
	return "pg";
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
