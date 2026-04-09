#!/usr/bin/env bun
/**
 * GAP-4 §10 — Shadow log analyzer
 *
 * Parses JSONL shadow log captures (the structured `LogEntry` shape
 * emitted by `src/core/logger.ts` after the §9 migration) and produces
 * a markdown report with the metrics doc §10 calls out:
 *
 *   - Disagreement rate: router primary_intent vs legacy query_type
 *   - Multi-intent hit rate
 *   - Entity resolution hit rate
 *   - Per-surface plan weight distribution
 *   - Failure rate (failed events / route_shadow events)
 *   - Phase 4 / EPISODE deletion gate readiness markers
 *
 * Usage:
 *   bun scripts/analyze-shadow.ts --input <file.jsonl> --output <report.md>
 *
 * Sink strategy (per the GAP-4 §10 plan, option B):
 * The script consumes a JSONL file already on disk; capturing logger
 * stdout into that file is the caller's responsibility (typically a test
 * helper that wraps `console.log` during a scenario run, or a
 * `bun test 2>&1 | tee shadow.jsonl` invocation). Upgrading to a logger
 * file transport later (option A) requires no changes here — only the
 * source of the JSONL file changes.
 */

import { readFileSync, writeFileSync } from "node:fs";

// ----- Types --------------------------------------------------------------

type LogEntry = {
	level: string;
	message: string;
	context: Record<string, unknown>;
	timestamp: number;
};

type RouteShadowPayload = {
	event: "query_route_shadow";
	classifier: string;
	primary_intent: string;
	legacy_query_type: string;
	agreed_with_legacy: boolean;
	intents: Array<{ type: string; confidence: number; evidence_count: number }>;
	intent_count: number;
	matched_rules: string[];
	resolved_entity_count: number;
	time_signals: unknown;
	signals: Record<string, number>;
	rationale: string;
};

type PlanShadowPayload = {
	event: "query_plan_shadow";
	builder: string;
	primary_intent: string;
	secondary_intents: string[];
	surface_weights: { narrative: number; cognition: number; episode: number; conflict_notes: number };
	surface_enabled: { narrative: boolean; cognition: boolean; episode: boolean; conflict_notes: boolean };
	cognition_kind: string | null;
	cognition_stance: string | null;
	seed_bias: Record<string, number>;
	edge_bias: Record<string, number>;
	time_slice: unknown;
	matched_rules: string[];
	rationale: string;
};

type FailurePayload = {
	event: string;
	error: string;
};

type ParsedShadow = {
	routeEvents: RouteShadowPayload[];
	planEvents: PlanShadowPayload[];
	failureEvents: { event: string; payload: FailurePayload }[];
	totalLines: number;
	skippedLines: number;
};

// ----- Parsing ------------------------------------------------------------

const KNOWN_FAILURE_EVENTS = new Set([
	"private_alias_scan_failed",
	"retrieval_plan_build_failed",
	"cjk_segmenter_init_failed",
	"cjk_segmenter_load_dict_failed",
	"cjk_segmenter_sync_failed",
	"supplemental_narrative_search_unavailable",
	"supplemental_cognition_search_unavailable",
]);

function parseShadowJsonl(content: string): ParsedShadow {
	const result: ParsedShadow = {
		routeEvents: [],
		planEvents: [],
		failureEvents: [],
		totalLines: 0,
		skippedLines: 0,
	};

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		result.totalLines += 1;

		let entry: LogEntry;
		try {
			entry = JSON.parse(line) as LogEntry;
		} catch {
			result.skippedLines += 1;
			continue;
		}
		// Logger emits {level, message, context, timestamp}. Older raw
		// `console.debug(JSON.stringify(...))` lines may emit the payload
		// directly without the LogEntry envelope; tolerate both shapes by
		// looking for `event` in either context or top-level.
		const ctx =
			entry && typeof entry === "object" && "context" in entry
				? (entry.context as Record<string, unknown>)
				: (entry as unknown as Record<string, unknown>);
		const event = typeof ctx?.event === "string" ? (ctx.event as string) : null;
		if (event === null) {
			result.skippedLines += 1;
			continue;
		}

		switch (event) {
			case "query_route_shadow":
				result.routeEvents.push(ctx as unknown as RouteShadowPayload);
				break;
			case "query_plan_shadow":
				result.planEvents.push(ctx as unknown as PlanShadowPayload);
				break;
			default:
				if (KNOWN_FAILURE_EVENTS.has(event)) {
					result.failureEvents.push({ event, payload: ctx as unknown as FailurePayload });
				} else {
					result.skippedLines += 1;
				}
		}
	}

	return result;
}

// ----- Metrics ------------------------------------------------------------

type Metrics = {
	totalRoutes: number;
	totalPlans: number;
	totalFailures: number;
	disagreementRate: number;
	multiIntentRate: number;
	entityResolutionRate: number;
	failureRate: number;
	failuresByType: Map<string, number>;
	intentHistogram: Map<string, number>;
	surfaceWeightAvg: { narrative: number; cognition: number; episode: number; conflict_notes: number };
	edgeBiasNonEmptyRate: number;
};

function computeMetrics(parsed: ParsedShadow): Metrics {
	const totalRoutes = parsed.routeEvents.length;
	const totalPlans = parsed.planEvents.length;
	const totalFailures = parsed.failureEvents.length;

	const disagreed = parsed.routeEvents.filter((r) => !r.agreed_with_legacy).length;
	const disagreementRate = totalRoutes > 0 ? disagreed / totalRoutes : 0;

	const multiIntent = parsed.routeEvents.filter((r) => r.intent_count > 1).length;
	const multiIntentRate = totalRoutes > 0 ? multiIntent / totalRoutes : 0;

	const withEntities = parsed.routeEvents.filter((r) => r.resolved_entity_count > 0).length;
	const entityResolutionRate = totalRoutes > 0 ? withEntities / totalRoutes : 0;

	const failureRate = totalRoutes > 0 ? totalFailures / totalRoutes : 0;

	const failuresByType = new Map<string, number>();
	for (const fe of parsed.failureEvents) {
		failuresByType.set(fe.event, (failuresByType.get(fe.event) ?? 0) + 1);
	}

	const intentHistogram = new Map<string, number>();
	for (const r of parsed.routeEvents) {
		intentHistogram.set(r.primary_intent, (intentHistogram.get(r.primary_intent) ?? 0) + 1);
	}

	let narrSum = 0;
	let cogSum = 0;
	let episSum = 0;
	let confSum = 0;
	let edgeBiasNonEmpty = 0;
	for (const p of parsed.planEvents) {
		narrSum += p.surface_weights.narrative;
		cogSum += p.surface_weights.cognition;
		episSum += p.surface_weights.episode;
		confSum += p.surface_weights.conflict_notes;
		if (p.edge_bias && Object.keys(p.edge_bias).length > 0) {
			edgeBiasNonEmpty += 1;
		}
	}
	const surfaceWeightAvg = {
		narrative: totalPlans > 0 ? narrSum / totalPlans : 0,
		cognition: totalPlans > 0 ? cogSum / totalPlans : 0,
		episode: totalPlans > 0 ? episSum / totalPlans : 0,
		conflict_notes: totalPlans > 0 ? confSum / totalPlans : 0,
	};
	const edgeBiasNonEmptyRate = totalPlans > 0 ? edgeBiasNonEmpty / totalPlans : 0;

	return {
		totalRoutes,
		totalPlans,
		totalFailures,
		disagreementRate,
		multiIntentRate,
		entityResolutionRate,
		failureRate,
		failuresByType,
		intentHistogram,
		surfaceWeightAvg,
		edgeBiasNonEmptyRate,
	};
}

// ----- Reporting ----------------------------------------------------------

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function renderReport(parsed: ParsedShadow, metrics: Metrics): string {
	const lines: string[] = [];
	lines.push("# Shadow Log Analysis Report");
	lines.push("");
	lines.push(`Generated: ${new Date().toISOString()}`);
	lines.push("");
	lines.push("## Input summary");
	lines.push(`- Total lines: ${parsed.totalLines}`);
	lines.push(`- Skipped (non-event / unparseable): ${parsed.skippedLines}`);
	lines.push(`- Route shadow events: ${metrics.totalRoutes}`);
	lines.push(`- Plan shadow events: ${metrics.totalPlans}`);
	lines.push(`- Failure events: ${metrics.totalFailures}`);
	lines.push("");

	lines.push("## Router metrics");
	lines.push(`- **Disagreement rate** (router vs legacy query_type): ${formatPercent(metrics.disagreementRate)}`);
	lines.push(`- **Multi-intent hit rate** (intent_count > 1): ${formatPercent(metrics.multiIntentRate)}`);
	lines.push(`- **Entity resolution hit rate**: ${formatPercent(metrics.entityResolutionRate)}`);
	lines.push("");
	lines.push("### Primary intent histogram");
	const sortedIntents = Array.from(metrics.intentHistogram.entries()).sort((a, b) => b[1] - a[1]);
	for (const [intent, count] of sortedIntents) {
		const pct = metrics.totalRoutes > 0 ? formatPercent(count / metrics.totalRoutes) : "0.0%";
		lines.push(`- ${intent}: ${count} (${pct})`);
	}
	lines.push("");

	lines.push("## Plan metrics");
	lines.push(`- **edge_bias non-empty rate**: ${formatPercent(metrics.edgeBiasNonEmptyRate)}`);
	lines.push("");
	lines.push("### Average surface weights");
	lines.push(`- narrative: ${metrics.surfaceWeightAvg.narrative.toFixed(3)}`);
	lines.push(`- cognition: ${metrics.surfaceWeightAvg.cognition.toFixed(3)}`);
	lines.push(`- episode: ${metrics.surfaceWeightAvg.episode.toFixed(3)}`);
	lines.push(`- conflict_notes: ${metrics.surfaceWeightAvg.conflict_notes.toFixed(3)}`);
	lines.push("");

	lines.push("## Failure metrics");
	lines.push(`- **Failure rate**: ${formatPercent(metrics.failureRate)} (${metrics.totalFailures} failures / ${metrics.totalRoutes} routes)`);
	if (metrics.failuresByType.size > 0) {
		lines.push("");
		lines.push("### By event type");
		for (const [event, count] of Array.from(metrics.failuresByType.entries()).sort((a, b) => b[1] - a[1])) {
			lines.push(`- ${event}: ${count}`);
		}
	}
	lines.push("");

	lines.push("## Doc §10 decision gates");
	const phase4MultiIntentGate = metrics.multiIntentRate >= 0.15;
	const phase4EdgeBiasGate = metrics.edgeBiasNonEmptyRate >= 0.10;
	const phase4Ready = phase4MultiIntentGate && phase4EdgeBiasGate && metrics.totalRoutes >= 100;
	lines.push("");
	lines.push("**Phase 4 navigator activation gate**:");
	lines.push(`- multi-intent hit rate ≥ 15%: ${phase4MultiIntentGate ? "✅" : "❌"} (${formatPercent(metrics.multiIntentRate)})`);
	lines.push(`- edge_bias non-empty rate ≥ 10%: ${phase4EdgeBiasGate ? "✅" : "❌"} (${formatPercent(metrics.edgeBiasNonEmptyRate)})`);
	lines.push(`- sample size ≥ 100 routes: ${metrics.totalRoutes >= 100 ? "✅" : "❌"} (${metrics.totalRoutes})`);
	lines.push(`- **Overall**: ${phase4Ready ? "✅ READY" : "❌ NOT READY"}`);
	lines.push("");
	lines.push("**EPISODE_*_TRIGGER deletion gate** (already executed in commit `ef43bc4`):");
	lines.push("- fixture match rate ≥ 95% — verified by `test/memory/episode-signal-parity.test.ts`");
	lines.push("- ✅ Status: COMPLETE (regex path deleted, fixture frozen as regression guard)");
	lines.push("");

	return lines.join("\n");
}

// ----- CLI ----------------------------------------------------------------

function parseArgs(argv: string[]): { input: string; output: string } {
	let input = "";
	let output = "";
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--input" && i + 1 < argv.length) {
			input = argv[i + 1];
			i += 1;
		} else if (arg === "--output" && i + 1 < argv.length) {
			output = argv[i + 1];
			i += 1;
		}
	}
	if (!input || !output) {
		console.error("Usage: bun scripts/analyze-shadow.ts --input <file.jsonl> --output <report.md>");
		process.exit(2);
	}
	return { input, output };
}

function main(): void {
	const { input, output } = parseArgs(process.argv.slice(2));
	const content = readFileSync(input, "utf8");
	const parsed = parseShadowJsonl(content);
	const metrics = computeMetrics(parsed);
	const report = renderReport(parsed, metrics);
	writeFileSync(output, report, "utf8");
	console.log(`✓ Wrote report to ${output}`);
	console.log(`  ${metrics.totalRoutes} route events, ${metrics.totalPlans} plan events, ${metrics.totalFailures} failures`);
}

// Only auto-run when invoked as a script (not when imported by tests).
if (import.meta.main) {
	main();
}

// Export for unit tests.
export {
	parseShadowJsonl,
	computeMetrics,
	renderReport,
	type ParsedShadow,
	type Metrics,
};
