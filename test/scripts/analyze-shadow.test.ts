import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	computeMetrics,
	parseShadowJsonl,
	renderReport,
} from "../../scripts/analyze-shadow";

/**
 * GAP-4 §10 — Shadow log parser unit tests.
 *
 * Validates that `parseShadowJsonl` correctly extracts route, plan, and
 * failure events from a small bilingual fixture, and that
 * `computeMetrics` reports the expected aggregate counts and rates.
 */

const FIXTURE_PATH = join(import.meta.dir, "..", "fixtures", "sample-shadow.jsonl");

describe("analyze-shadow parser", () => {
	const content = readFileSync(FIXTURE_PATH, "utf8");
	const parsed = parseShadowJsonl(content);

	it("extracts every line in the fixture without skipping", () => {
		expect(parsed.totalLines).toBe(10);
		expect(parsed.skippedLines).toBe(0);
	});

	it("counts route shadow events correctly", () => {
		expect(parsed.routeEvents.length).toBe(6);
	});

	it("counts plan shadow events correctly", () => {
		expect(parsed.planEvents.length).toBe(3);
	});

	it("counts failure events correctly", () => {
		expect(parsed.failureEvents.length).toBe(1);
		expect(parsed.failureEvents[0]?.event).toBe("private_alias_scan_failed");
	});

	it("preserves payload field types from the LogEntry envelope", () => {
		const firstRoute = parsed.routeEvents[0];
		expect(firstRoute?.classifier).toBe("rule-v1");
		expect(firstRoute?.primary_intent).toBe("why");
		expect(firstRoute?.agreed_with_legacy).toBe(true);
		expect(firstRoute?.intent_count).toBe(1);

		const firstPlan = parsed.planEvents[0];
		expect(firstPlan?.builder).toBe("deterministic-v1");
		expect(firstPlan?.surface_weights.episode).toBe(0.3);
	});
});

describe("analyze-shadow metrics", () => {
	const content = readFileSync(FIXTURE_PATH, "utf8");
	const parsed = parseShadowJsonl(content);
	const metrics = computeMetrics(parsed);

	it("disagreement rate counts the one disagreed-with-legacy row", () => {
		// 1 of 6 routes disagrees (timeline vs event)
		expect(metrics.totalRoutes).toBe(6);
		expect(metrics.disagreementRate).toBeCloseTo(1 / 6, 5);
	});

	it("multi-intent rate counts only intent_count > 1 routes", () => {
		// 1 of 6 routes has intent_count > 1 (the timeline+why one)
		expect(metrics.multiIntentRate).toBeCloseTo(1 / 6, 5);
	});

	it("entity resolution rate counts routes with at least one resolved entity", () => {
		// 3 of 6 routes have resolved_entity_count > 0 (timeline+why, entity, relationship)
		expect(metrics.entityResolutionRate).toBeCloseTo(3 / 6, 5);
	});

	it("failure rate is failures / routes", () => {
		// 1 failure / 6 routes
		expect(metrics.failureRate).toBeCloseTo(1 / 6, 5);
		expect(metrics.failuresByType.get("private_alias_scan_failed")).toBe(1);
	});

	it("intent histogram covers all distinct primary intents", () => {
		const intents = Array.from(metrics.intentHistogram.keys()).sort();
		expect(intents).toEqual(["conflict", "entity", "event", "relationship", "timeline", "why"]);
	});

	it("edge_bias non-empty rate counts plans with at least one bias key", () => {
		// 2 of 3 plans have non-empty edge_bias (why → causal, timeline → temporal_*)
		// the third (entity) has {} → empty
		expect(metrics.edgeBiasNonEmptyRate).toBeCloseTo(2 / 3, 5);
	});

	it("average surface weights are computed across plan events", () => {
		expect(metrics.surfaceWeightAvg.episode).toBeCloseTo(
			(0.3 + 0.72 + 0.3) / 3,
			5,
		);
	});
});

describe("analyze-shadow report rendering", () => {
	const content = readFileSync(FIXTURE_PATH, "utf8");
	const parsed = parseShadowJsonl(content);
	const metrics = computeMetrics(parsed);
	const report = renderReport(parsed, metrics);

	it("produces a non-empty markdown report", () => {
		expect(report.length).toBeGreaterThan(100);
		expect(report).toContain("# Shadow Log Analysis Report");
	});

	it("includes all major sections", () => {
		expect(report).toContain("## Input summary");
		expect(report).toContain("## Router metrics");
		expect(report).toContain("## Plan metrics");
		expect(report).toContain("## Failure metrics");
		expect(report).toContain("## Doc §10 decision gates");
	});

	it("flags Phase 4 gate as NOT READY for the small fixture (sample size < 100)", () => {
		expect(report).toContain("Phase 4 navigator activation gate");
		expect(report).toContain("❌ NOT READY");
	});

	it("marks EPISODE_*_TRIGGER deletion gate as COMPLETE", () => {
		expect(report).toContain("EPISODE_*_TRIGGER deletion gate");
		expect(report).toContain("✅ Status: COMPLETE");
	});
});

describe("analyze-shadow tolerance", () => {
	it("skips blank lines and unparseable JSON without crashing", () => {
		const messy = [
			"",
			"   ",
			"not json at all",
			'{"level":"debug","message":"query_route_shadow","context":{"event":"query_route_shadow","classifier":"rule-v1","primary_intent":"why","legacy_query_type":"why","agreed_with_legacy":true,"intents":[],"intent_count":0,"matched_rules":[],"resolved_entity_count":0,"time_signals":[],"signals":{"needsEpisode":0,"needsConflict":0,"needsTimeline":0,"needsRelationship":0,"needsCognition":0,"needsEntityFocus":0},"rationale":""},"timestamp":1700000000000}',
			"",
		].join("\n");
		const parsed = parseShadowJsonl(messy);
		expect(parsed.routeEvents.length).toBe(1);
		expect(parsed.skippedLines).toBeGreaterThanOrEqual(1);
	});

	it("tolerates lines without the LogEntry envelope (legacy console.debug shape)", () => {
		const legacy = JSON.stringify({
			event: "query_route_shadow",
			classifier: "rule-v1",
			primary_intent: "state",
			legacy_query_type: "state",
			agreed_with_legacy: true,
			intents: [],
			intent_count: 0,
			matched_rules: [],
			resolved_entity_count: 0,
			time_signals: [],
			signals: {},
			rationale: "",
		});
		const parsed = parseShadowJsonl(legacy);
		expect(parsed.routeEvents.length).toBe(1);
		expect(parsed.routeEvents[0]?.primary_intent).toBe("state");
	});
});
