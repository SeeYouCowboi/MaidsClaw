/**
 * Backend type definitions for MaidsClaw storage layer.
 *
 * Phase 2A: Type definitions and backend selection contract.
 * Full factory implementations deferred to Phase 2B (T7).
 */

export type BackendType = "sqlite" | "pg";

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
	if (val === "pg") return "pg";
	return "sqlite"; // default
}

/**
 * Placeholder interface for backend factories.
 * Full implementation deferred to T7.
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
 * Full implementation deferred to T7.
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
 * Placeholder PostgreSQL backend factory.
 * Full implementation deferred to T7.
 */
export class PgBackendFactory implements BackendFactory {
	readonly type = "pg" as const;

	async initialize(_config: BackendConfig): Promise<void> {
		throw new Error("PgBackendFactory not yet implemented (T7)");
	}

	async close(): Promise<void> {
		throw new Error("PgBackendFactory not yet implemented (T7)");
	}
}
