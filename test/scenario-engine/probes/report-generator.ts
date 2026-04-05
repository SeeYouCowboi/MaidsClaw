import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ProbeResult } from "./probe-types.js";
import type { ScenarioRunResult, ScenarioInfra } from "../runner/infra.js";
import type { Story } from "../dsl/story-types.js";
import { SCENARIO_DEFAULT_AGENT_ID } from "../constants.js";

export type AlignedComparison = {
  probeId: string;
  query: string;
  scriptedScore: number;
  settlementScore: number;
  delta: number;
  scriptedPassed: boolean;
  settlementPassed: boolean;
};

export type CognitionAlignment = {
  pointerKeyPair: string;
  predicate: string;
  inSettlement: boolean;
  inScripted: boolean;
  status: "match" | "gap" | "surprise";
};

/**
 * Generate a markdown report from probe results and scenario run result.
 */
export function generateReport(
  probeResults: ProbeResult[],
  runResult: ScenarioRunResult,
  storyTitle?: string,
): string {
  const title = storyTitle ?? "Untitled Scenario";
  const totalProbes = probeResults.length;
  const passedProbes = probeResults.filter((r) => r.passed).length;

  const lines: string[] = [];

  lines.push(`# Scenario Report: ${title}`);
  lines.push(`WritePath: ${runResult.writePath}`);
  lines.push(`Duration: ${runResult.elapsedMs}ms`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(
    `- Beats: ${runResult.settlementCount} processed, ${runResult.errors.length} errors`,
  );
  lines.push(`- Probes: ${passedProbes}/${totalProbes} passed`);
  lines.push("");
  lines.push("## Per-Beat Memory Write Summary");
  lines.push("| Beat ID | Entities | Episodes | Assertions | Evaluations | Errors |");
  lines.push("|---------|----------|----------|------------|-------------|--------|");

  const errorsByBeat = new Map<string, number>();
  for (const err of runResult.errors) {
    errorsByBeat.set(err.beatId, (errorsByBeat.get(err.beatId) ?? 0) + 1);
  }

  const stats = runResult.projectionStats;
  const entities = stats["entities_created"] ?? "?";
  const episodes = stats["episodes_created"] ?? "?";
  const assertions = stats["assertions_created"] ?? "?";
  const evaluations = stats["evaluations_created"] ?? "?";

  if (runResult.settlementCount === 0 && runResult.errors.length === 0) {
    lines.push("| (none) | - | - | - | - | 0 |");
  } else {
    lines.push(
      `| (all) | ${entities} | ${episodes} | ${assertions} | ${evaluations} | ${runResult.errors.length} |`,
    );
    for (const [beatId, count] of errorsByBeat) {
      lines.push(`| ${beatId} | - | - | - | - | ${count} |`);
    }
  }
  lines.push("");
  lines.push("## Probe Results");
  for (const r of probeResults) {
    const icon = r.passed ? "\u2705" : "\u274C";
    lines.push(
      `### ${icon} ${r.probe.retrievalMethod}: "${r.probe.query}" \u2014 Score: ${r.score.toFixed(2)}`,
    );
    lines.push(`- Matched: ${r.matched.length > 0 ? r.matched.join(", ") : "none"}`);
    lines.push(`- Missed: ${r.missed.length > 0 ? r.missed.join(", ") : "none"}`);
    if (r.unexpectedPresent.length > 0) {
      lines.push(`- Unexpected: ${r.unexpectedPresent.join(", ")}`);
    }
    if (!r.passed) {
      lines.push("- Status: FAILED");
    }
  }

  return lines.join("\n");
}

/**
 * Save a report string to disk under test/scenario-engine/reports/.
 */
export function saveReport(
  content: string,
  storyId: string,
  suffix: string,
): void {
  const reportsDir = join(
    dirname(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"))),
    "reports",
  );
  mkdirSync(reportsDir, { recursive: true });
  const filePath = join(reportsDir, `${storyId}-${suffix}-report.md`);
  writeFileSync(filePath, content, "utf-8");
}

/**
 * Generate a comparison report between scripted (thinker actual) and settlement (DSL expected) probe results.
 */
export function generateComparisonReport(
  scriptedResults: ProbeResult[],
  settlementResults: ProbeResult[],
  story: Story,
): string {
  const settlementMap = new Map<string, ProbeResult>();
  for (const r of settlementResults) {
    settlementMap.set(r.probe.id, r);
  }

  const lines: string[] = [];
  lines.push(`# Comparison Report: ${story.title}`);
  lines.push("");
  lines.push("## Scripted (Thinker Actual) vs Settlement (DSL Expected)");
  lines.push("");
  lines.push("### Probe Score Comparison");
  lines.push("| Probe ID | Scripted Score | Settlement Score | Delta |");
  lines.push("|----------|---------------|-----------------|-------|");

  let matchedCount = 0;
  let fellShortCount = 0;
  let unexpectedExtrasCount = 0;

  for (const scripted of scriptedResults) {
    const settlement = settlementMap.get(scripted.probe.id);
    const scriptedScore = scripted.score;
    const settlementScore = settlement?.score ?? 0;
    const delta = scriptedScore - settlementScore;

    lines.push(
      `| ${scripted.probe.id} | ${scriptedScore.toFixed(2)} | ${settlementScore.toFixed(2)} | ${delta >= 0 ? "" : ""}${delta.toFixed(2)} |`,
    );

    if (settlement) {
      if (scriptedScore >= settlementScore) {
        matchedCount++;
      } else {
        fellShortCount++;
      }
      if (scripted.unexpectedPresent.length > 0) {
        unexpectedExtrasCount++;
      }
    }
  }

  lines.push("");
  lines.push("## Extraction Summary");
  lines.push(`- Probes where thinker matched DSL: ${matchedCount}`);
  lines.push(`- Probes where thinker fell short: ${fellShortCount}`);
  lines.push(
    `- Unexpected extras in thinker (not in DSL): ${unexpectedExtrasCount}`,
  );

  return lines.join("\n");
}

export function alignProbeResults(
  scriptedResults: ProbeResult[],
  settlementResults: ProbeResult[],
  _story: Story,
): AlignedComparison[] {
  const settlementMap = new Map<string, ProbeResult>();
  for (const r of settlementResults) {
    settlementMap.set(r.probe.id, r);
  }

  const comparisons: AlignedComparison[] = [];

  for (const scripted of scriptedResults) {
    const settlement = settlementMap.get(scripted.probe.id);
    const settlementScore = settlement?.score ?? 0;
    const settlementPassed = settlement?.passed ?? false;

    comparisons.push({
      probeId: scripted.probe.id,
      query: scripted.probe.query,
      scriptedScore: scripted.score,
      settlementScore,
      delta: scripted.score - settlementScore,
      scriptedPassed: scripted.passed,
      settlementPassed,
    });

    settlementMap.delete(scripted.probe.id);
  }

  for (const settlement of settlementMap.values()) {
    comparisons.push({
      probeId: settlement.probe.id,
      query: settlement.probe.query,
      scriptedScore: 0,
      settlementScore: settlement.score,
      delta: -settlement.score,
      scriptedPassed: false,
      settlementPassed: settlement.passed,
    });
  }

  return comparisons;
}

type ParsedRecord = {
  sourcePointerKey?: string;
  predicate?: string;
  targetPointerKey?: string;
};

function safeParseRecordJson(json: string): ParsedRecord {
  try {
    return JSON.parse(json) as ParsedRecord;
  } catch {
    return {};
  }
}

export async function alignCognitionState(
  scriptedInfra: ScenarioInfra,
  settlementInfra: ScenarioInfra,
  _story: Story,
): Promise<CognitionAlignment[]> {
  const agentId = SCENARIO_DEFAULT_AGENT_ID;

  let scriptedRows: Array<{ cognition_key: string; record_json: string }>;
  let settlementRows: Array<{ cognition_key: string; record_json: string }>;

  try {
    scriptedRows = await scriptedInfra.repos.cognition.getAllCurrent(agentId);
    settlementRows = await settlementInfra.repos.cognition.getAllCurrent(agentId);
  } catch {
    // TODO: getAllCurrent may not be available in all repo implementations
    return [];
  }

  type AlignKey = string;
  function makeKey(pointerKeyPair: string, predicate: string): AlignKey {
    return `${pointerKeyPair}||${predicate}`;
  }

  const scriptedSet = new Map<AlignKey, { pointerKeyPair: string; predicate: string }>();
  for (const row of scriptedRows) {
    const parsed = safeParseRecordJson(row.record_json);
    const pair = parsed.targetPointerKey
      ? `${parsed.sourcePointerKey ?? "?"}+${parsed.targetPointerKey}`
      : (parsed.sourcePointerKey ?? row.cognition_key);
    const predicate = parsed.predicate ?? row.cognition_key;
    scriptedSet.set(makeKey(pair, predicate), { pointerKeyPair: pair, predicate });
  }

  const settlementSet = new Map<AlignKey, { pointerKeyPair: string; predicate: string }>();
  for (const row of settlementRows) {
    const parsed = safeParseRecordJson(row.record_json);
    const pair = parsed.targetPointerKey
      ? `${parsed.sourcePointerKey ?? "?"}+${parsed.targetPointerKey}`
      : (parsed.sourcePointerKey ?? row.cognition_key);
    const predicate = parsed.predicate ?? row.cognition_key;
    settlementSet.set(makeKey(pair, predicate), { pointerKeyPair: pair, predicate });
  }

  const allKeys = new Set([...scriptedSet.keys(), ...settlementSet.keys()]);
  const alignments: CognitionAlignment[] = [];

  for (const key of allKeys) {
    const inScripted = scriptedSet.has(key);
    const inSettlement = settlementSet.has(key);
    const entry = scriptedSet.get(key) ?? settlementSet.get(key)!;

    let status: CognitionAlignment["status"];
    if (inScripted && inSettlement) {
      status = "match";
    } else if (inSettlement && !inScripted) {
      status = "gap";
    } else {
      status = "surprise";
    }

    alignments.push({
      pointerKeyPair: entry.pointerKeyPair,
      predicate: entry.predicate,
      inSettlement,
      inScripted,
      status,
    });
  }

  return alignments;
}
