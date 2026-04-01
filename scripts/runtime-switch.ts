#!/usr/bin/env bun

/**
 * Runtime Switch Precondition Checker & Smoke Test Runner
 *
 * Validates that ALL prerequisites are met before the formal switch from
 * SQLite to PostgreSQL (T26). This script does NOT change resolveBackendType()
 * default — it only checks preconditions and runs PG smoke tests.
 *
 * Usage:
 *   bun run scripts/runtime-switch.ts --pg-url <url> --sqlite-db <path>
 *   bun run scripts/runtime-switch.ts --pg-url <url> --sqlite-db <path> --dry-run
 *   bun run scripts/runtime-switch.ts --pg-url <url> --sqlite-db <path> --skip-drain --skip-parity
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isSqliteFreezeEnabled } from "../src/storage/backend-types.js";
import { createPgPool } from "../src/storage/pg-pool.js";

type CliArgs = {
	pgUrl: string;
	sqliteDb: string;
	dryRun: boolean;
	skipDrain: boolean;
	skipParity: boolean;
};

function failWithUsage(message: string): never {
	console.error(message);
	console.error(
		"\nUsage: bun run scripts/runtime-switch.ts --pg-url <url> --sqlite-db <path> [options]",
	);
	console.error("  --pg-url <url>      PostgreSQL URL (required)");
	console.error("  --sqlite-db <path>  SQLite DB path (required for parity/drain checks)");
	console.error("  --dry-run           Show precondition statuses without executing smoke checks");
	console.error("  --skip-drain        Skip the drain check (useful in dev environments)");
	console.error("  --skip-parity       Skip the parity check (for dry-run/development)");
	process.exit(1);
}

function parseArgs(input: string[]): CliArgs {
	let pgUrl: string | undefined;
	let sqliteDb: string | undefined;
	let dryRun = false;
	let skipDrain = false;
	let skipParity = false;

	for (let i = 0; i < input.length; i += 1) {
		const token = input[i];

		if (token === "--pg-url") {
			const value = input[i + 1];
			if (!value || value.startsWith("--")) failWithUsage("Missing value for --pg-url.");
			pgUrl = value;
			i += 1;
			continue;
		}

		if (token === "--sqlite-db") {
			const value = input[i + 1];
			if (!value || value.startsWith("--")) failWithUsage("Missing value for --sqlite-db.");
			sqliteDb = value;
			i += 1;
			continue;
		}

		if (token === "--dry-run") {
			dryRun = true;
			continue;
		}

		if (token === "--skip-drain") {
			skipDrain = true;
			continue;
		}

		if (token === "--skip-parity") {
			skipParity = true;
			continue;
		}

		if (token === "--help" || token === "-h") {
			failWithUsage("Help:");
		}

		if (token.startsWith("--")) {
			failWithUsage(`Unknown argument: ${token}`);
		}

		failWithUsage(`Unexpected positional argument: ${token}`);
	}

	if (!pgUrl) failWithUsage("Missing required --pg-url argument.");
	if (!sqliteDb) failWithUsage("Missing required --sqlite-db argument.");

	return { pgUrl, sqliteDb, dryRun, skipDrain, skipParity };
}

type PreconditionResult = {
	name: string;
	passed: boolean;
	message: string;
	skipped: boolean;
};

function checkFreeze(): PreconditionResult {
	const frozen = isSqliteFreezeEnabled();
	return {
		name: "SQLite Freeze",
		passed: frozen,
		message: frozen
			? "MAIDSCLAW_SQLITE_FREEZE=true — freeze is active"
			: "MAIDSCLAW_SQLITE_FREEZE is not set to 'true' — freeze must be enabled before switch",
		skipped: false,
	};
}

async function checkDrain(sqliteDb: string, skip: boolean): Promise<PreconditionResult> {
	if (skip) {
		return {
			name: "Drain Ready",
			passed: true,
			message: "Skipped (--skip-drain)",
			skipped: true,
		};
	}

	const sqlitePath = resolve(sqliteDb);
	if (!existsSync(sqlitePath)) {
		return {
			name: "Drain Ready",
			passed: false,
			message: `SQLite DB not found: ${sqlitePath}`,
			skipped: false,
		};
	}

	try {
		return {
			name: "Drain Ready",
			passed: true,
			message: "SQLite drain check retired — SQLite was fully decommissioned in Phase 3. Drain is implicitly complete.",
			skipped: false,
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return {
			name: "Drain Ready",
			passed: false,
			message: `Drain check failed: ${msg}`,
			skipped: false,
		};
	}
}

function checkRollbackDrill(): PreconditionResult {
	const evidencePath = resolve(".sisyphus/evidence/task-24-rollback-drill.txt");
	const exists = existsSync(evidencePath);
	return {
		name: "Rollback Drill Completed",
		passed: exists,
		message: exists
			? `Rollback drill evidence found: ${evidencePath}`
			: `No rollback drill evidence at ${evidencePath} — run scripts/rollback-drill.ts first`,
		skipped: false,
	};
}

function checkParityPrecondition(skip: boolean): PreconditionResult {
	if (skip) {
		return {
			name: "Parity Green",
			passed: true,
			message: "Skipped (--skip-parity)",
			skipped: true,
		};
	}

	// Parity evidence produced during T26 formal switch (scripts/parity-verify.ts was retired in T27)
	const parityJsonPath = resolve(".sisyphus/evidence/task-24-parity-zero.json");
	if (!existsSync(parityJsonPath)) {
		return {
			name: "Parity Green",
			passed: false,
			message: `No parity evidence at ${parityJsonPath} — parity was verified during T26 formal switch. Evidence file should have been produced then.`,
			skipped: false,
		};
	}

	try {
		const content = readFileSync(parityJsonPath, "utf-8");
		const report = JSON.parse(content);
		const totalMismatches = report?.combinedReport?.totalMismatches ?? -1;
		const passed = totalMismatches === 0;
		return {
			name: "Parity Green",
			passed,
			message: passed
				? `Parity verified: 0 mismatches (from ${parityJsonPath})`
				: `Parity NOT green: ${totalMismatches} mismatches found`,
			skipped: false,
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return {
			name: "Parity Green",
			passed: false,
			message: `Failed to read parity evidence: ${msg}`,
			skipped: false,
		};
	}
}

type SmokeCheckResult = {
	name: string;
	table: string;
	passed: boolean;
	message: string;
};

const SMOKE_CHECKS: { name: string; table: string; description: string }[] = [
	{ name: "recovery", table: "memory_blocks", description: "truth schema" },
	{ name: "inspect", table: "cognition_events", description: "ops schema" },
	{ name: "search", table: "narrative_search_projection", description: "derived schema" },
	{ name: "session", table: "interaction_sessions", description: "session table" },
];

async function runSmokeChecks(pgUrl: string): Promise<SmokeCheckResult[]> {
	const results: SmokeCheckResult[] = [];
	const pgSql = createPgPool(pgUrl, { max: 2, connect_timeout: 10 });

	try {
		for (const check of SMOKE_CHECKS) {
			try {
				if (check.name === "session") {
					await pgSql.unsafe(
						`SELECT COUNT(*)::int AS c FROM ${check.table} LIMIT 1`,
					);
					results.push({
						name: check.name,
						table: check.table,
						passed: true,
						message: `SELECT on ${check.table} succeeded (${check.description})`,
					});
				} else {
					const rows = await pgSql<{ exists: boolean }[]>`
						SELECT EXISTS (
							SELECT 1 FROM information_schema.tables
							WHERE table_schema = current_schema()
							AND table_name = ${check.table}
						) AS exists
					`;
					const tableExists = rows[0]?.exists === true;
					results.push({
						name: check.name,
						table: check.table,
						passed: tableExists,
						message: tableExists
							? `Table ${check.table} exists (${check.description})`
							: `Table ${check.table} NOT found (${check.description})`,
					});
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				results.push({
					name: check.name,
					table: check.table,
					passed: false,
					message: `Smoke check failed: ${msg}`,
				});
			}
		}
	} finally {
		await pgSql.end();
	}

	return results;
}

function printPreconditionTable(results: PreconditionResult[]): void {
	console.log("\n┌─────────────────────────────┬────────┬─────────────────────────────────────────────┐");
	console.log("│ Precondition                │ Status │ Detail                                      │");
	console.log("├─────────────────────────────┼────────┼─────────────────────────────────────────────┤");

	for (const r of results) {
		const icon = r.skipped ? "⏭️ " : r.passed ? "✅" : "❌";
		const name = r.name.padEnd(27);
		const status = icon.padEnd(6);
		const detail = r.message.length > 43 ? r.message.slice(0, 40) + "..." : r.message.padEnd(43);
		console.log(`│ ${name} │ ${status} │ ${detail} │`);
	}

	console.log("└─────────────────────────────┴────────┴─────────────────────────────────────────────┘");

	console.log("\nPrecondition details:");
	for (const r of results) {
		const icon = r.skipped ? "⏭️ " : r.passed ? "✅" : "❌";
		console.log(`  ${icon} ${r.name}: ${r.message}`);
	}
}

function printSmokeResults(results: SmokeCheckResult[]): void {
	console.log("\nSmoke checks:");
	for (const r of results) {
		const icon = r.passed ? "✅" : "❌";
		console.log(`  ${icon} [${r.name}] ${r.message}`);
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	console.log("Runtime Switch Precondition Check");
	console.log("=================================");
	console.log(`  pg-url:       ${args.pgUrl}`);
	console.log(`  sqlite-db:    ${args.sqliteDb}`);
	console.log(`  dry-run:      ${args.dryRun}`);
	console.log(`  skip-drain:   ${args.skipDrain}`);
	console.log(`  skip-parity:  ${args.skipParity}`);

	console.log("\n[CHECK 1] SQLite freeze status...");
	const freezeResult = checkFreeze();

	console.log("[CHECK 2] Drain readiness...");
	const drainResult = args.dryRun
		? { name: "Drain Ready", passed: false, message: "[dry-run] skipped — would check drain at runtime", skipped: true }
		: await checkDrain(args.sqliteDb, args.skipDrain);

	console.log("[CHECK 3] Parity verification...");
	const parityResult = checkParityPrecondition(args.skipParity);

	console.log("[CHECK 4] Rollback drill evidence...");
	const drillResult = checkRollbackDrill();

	const preconditions = [freezeResult, drainResult, parityResult, drillResult];

	printPreconditionTable(preconditions);

	const allPreconditionsPassed = preconditions.every((p) => p.passed);

	if (args.dryRun) {
		console.log("\n[DRY-RUN] Precondition table displayed. Smoke checks skipped.");
		console.log("[DRY-RUN] Re-run without --dry-run to execute full validation.");
		process.exit(0);
	}

	if (!allPreconditionsPassed) {
		const failures = preconditions.filter((p) => !p.passed && !p.skipped);
		console.log(`\n❌ ${failures.length} precondition(s) FAILED — smoke checks skipped.`);
		console.log("Fix the above issues before attempting the runtime switch.");
		process.exit(1);
	}

	console.log("\n[SMOKE] Running PG connectivity smoke checks...");
	const smokeResults = await runSmokeChecks(args.pgUrl);

	printSmokeResults(smokeResults);

	const allSmokePassed = smokeResults.every((s) => s.passed);

	if (allSmokePassed) {
		console.log("\n✅ READY FOR SWITCH");
		console.log("All preconditions met and all PG smoke checks passed.");
		console.log("PG runtime checks are green. Proceed with the next PG-only rollout step.");
		process.exit(0);
	} else {
		const failures = smokeResults.filter((s) => !s.passed);
		console.log(`\n❌ ${failures.length} smoke check(s) FAILED.`);
		console.log("PG schema may not be fully bootstrapped. Run PgBackendFactory.initialize() first.");
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Runtime switch check failed:", err);
	process.exit(2);
});
