import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ProbeResult } from "./probe-types.js";
import type { DiagnosisResult } from "./probe-diagnosis.js";
import type { ScenarioRunResult, ScenarioInfra } from "../runner/infra.js";
import type { Story } from "../dsl/story-types.js";
import type {
  ReasoningChainResult,
  ToolCallAssertionResult,
} from "./scenario-assertion-types.js";
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
  status: "match" | "gap" | "surprise" | "drift";
  settlementStance?: string;
  scriptedStance?: string;
};

/**
 * Generate a markdown report from probe results and scenario run result.
 */
export function generateReport(
  probeResults: ProbeResult[],
  runResult: ScenarioRunResult,
  storyTitle?: string,
  chainResults?: ReasoningChainResult[],
  toolCallAssertionResults?: ToolCallAssertionResult[],
  diagnosisResults?: Map<string, DiagnosisResult[]>,
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

  if (runResult.perBeatStats.length > 0) {
    for (const beat of runResult.perBeatStats) {
      lines.push(
        `| ${beat.beatId} | ${beat.entitiesCreated} | ${beat.episodesCreated} | ${beat.assertionsCreated} | ${beat.evaluationsCreated} | ${beat.errors} |`,
      );
    }
  } else if (runResult.settlementCount === 0 && runResult.errors.length === 0) {
    lines.push("| (none) | - | - | - | - | 0 |");
  } else {
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

      const diagnoses = diagnosisResults?.get(r.probe.id) ?? [];
      if (diagnoses.length > 0) {
        lines.push("- 🔍 Diagnosis:");
        for (const item of diagnoses) {
          lines.push(`  - "${item.fragment}": ${item.layer} ${item.diagnosis}`);
          if (item.detail) {
            lines.push(`    → ${item.detail}`);
          }
        }
      }
    }
  }

  if (chainResults && chainResults.length > 0) {
    lines.push("");
    lines.push("## Reasoning Chain Verification");
    lines.push("");
    lines.push("| Probe | Passed | Cognitions | Edges |");
    lines.push("|-------|--------|------------|-------|");

    for (const result of chainResults) {
      const cognitionTotal = result.cognitionResults.length;
      const cognitionMatched = result.cognitionResults.filter(
        (r) => r.found && r.stanceMatch,
      ).length;

      const firstIssue = result.cognitionResults.find((r) => !r.found || !r.stanceMatch);
      const cognitionSummary = firstIssue
        ? `${cognitionMatched}/${cognitionTotal} (${firstIssue.cognitionKey}: ${!firstIssue.found ? "not found" : "stance mismatch"})`
        : `${cognitionMatched}/${cognitionTotal} match`;

      let edgeSummary = "N/A";
      if (result.edgeResults) {
        const edgeTotal = result.edgeResults.length;
        const edgeMatched = result.edgeResults.filter((edge) => edge.found).length;
        const firstMissing = result.edgeResults.find((edge) => !edge.found);
        edgeSummary = firstMissing
          ? `${edgeMatched}/${edgeTotal} (${firstMissing.fromRef}->${firstMissing.toRef}: missing)`
          : `${edgeMatched}/${edgeTotal} match`;
      }

      lines.push(
        `| ${result.probeId} | ${result.passed ? "✅" : "❌"} | ${cognitionSummary} | ${edgeSummary} |`,
      );
    }
  }

  if (toolCallAssertionResults && toolCallAssertionResults.length > 0) {
    lines.push("");
    lines.push("## Tool Call Pattern Assertions");
    lines.push("");
    lines.push("| Beat | Passed | Violations |");
    lines.push("|------|--------|------------|");

    for (const result of toolCallAssertionResults) {
      const passedIcon = result.passed ? "✅" : "❌";
      const violations = result.violations.length > 0
        ? result.violations
          .map((violation) => `${violation.rule}: ${violation.detail}`)
          .join("<br>")
        : "—";
      lines.push(`| ${result.beatId} | ${passedIcon} | ${violations} |`);
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
 * When infra references are provided, includes Cognition Alignment and Extraction Gaps/Surprises sections.
 */
export async function generateComparisonReport(
  scriptedResults: ProbeResult[],
  settlementResults: ProbeResult[],
  story: Story,
  infra?: { scripted: ScenarioInfra; settlement: ScenarioInfra },
): Promise<string> {
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

  // Probe alignment detail
  const aligned = alignProbeResults(scriptedResults, settlementResults, story);
  const gaps = aligned.filter((a) => !a.scriptedPassed && a.settlementPassed);
  const surprises = aligned.filter((a) => a.scriptedPassed && !a.settlementPassed);

  if (gaps.length > 0) {
    lines.push("");
    lines.push("## Extraction Gaps");
    lines.push("Probes the DSL expected to pass but the thinker missed:");
    lines.push("");
    for (const g of gaps) {
      lines.push(
        `- **${g.probeId}**: "${g.query}" — settlement ${g.settlementScore.toFixed(2)}, scripted ${g.scriptedScore.toFixed(2)}`,
      );
    }
  }

  if (surprises.length > 0) {
    lines.push("");
    lines.push("## Surprises");
    lines.push("Probes the thinker passed that the DSL did not:");
    lines.push("");
    for (const s of surprises) {
      lines.push(
        `- **${s.probeId}**: "${s.query}" — scripted ${s.scriptedScore.toFixed(2)}, settlement ${s.settlementScore.toFixed(2)}`,
      );
    }
  }

  // Cognition alignment (requires infra)
  if (infra) {
    // Coverage Ratio
    const settlementEpisodes = await countTableRows(infra.settlement, "private_episode_events");
    const settlementCognitions = await countTableRows(infra.settlement, "private_cognition_current");
    const settlementEntities = await countTableRows(infra.settlement, "entity_nodes");
    const liveEpisodes = await countTableRows(infra.scripted, "private_episode_events");
    const liveCognitions = await countTableRows(infra.scripted, "private_cognition_current");
    const liveEntities = await countTableRows(infra.scripted, "entity_nodes");

    const ratioEpisodes = settlementEpisodes > 0 ? liveEpisodes / settlementEpisodes : (liveEpisodes > 0 ? Infinity : 1);
    const ratioCognitions = settlementCognitions > 0 ? liveCognitions / settlementCognitions : (liveCognitions > 0 ? Infinity : 1);
    const ratioEntities = settlementEntities > 0 ? liveEntities / settlementEntities : (liveEntities > 0 ? Infinity : 1);

    const fmtRatio = (r: number) => r === Infinity ? "∞" : `${(r * 100).toFixed(1)}%`;

    lines.push("");
    lines.push("## Coverage Ratio");
    lines.push("");
    lines.push("| Dimension   | Settlement | Live | Ratio |");
    lines.push("|-------------|-----------|------|-------|");
    lines.push(`| Episodes    | ${settlementEpisodes}        | ${liveEpisodes}   | ${fmtRatio(ratioEpisodes)} |`);
    lines.push(`| Cognitions  | ${settlementCognitions}        | ${liveCognitions}   | ${fmtRatio(ratioCognitions)} |`);
    lines.push(`| Entities    | ${settlementEntities}        | ${liveEntities}   | ${fmtRatio(ratioEntities)} |`);

    const lowCoverage: string[] = [];
    if (ratioEpisodes < 0.8) lowCoverage.push("Episodes");
    if (ratioCognitions < 0.8) lowCoverage.push("Cognitions");
    if (ratioEntities < 0.8) lowCoverage.push("Entities");
    if (lowCoverage.length > 0) {
      lines.push("");
      lines.push(`⚠️ Low coverage ratio detected (< 80%) for ${lowCoverage.join(", ")}`);
    }

    const cognitionAlignments = await alignCognitionState(
      infra.scripted,
      infra.settlement,
      story,
    );

    if (cognitionAlignments.length > 0) {
      const matches = cognitionAlignments.filter((a) => a.status === "match");
      const drifts = cognitionAlignments.filter((a) => a.status === "drift");
      const cognitionGaps = cognitionAlignments.filter((a) => a.status === "gap");
      const cognitionSurprises = cognitionAlignments.filter((a) => a.status === "surprise");

      lines.push("");
      lines.push("## Cognition Alignment");
      lines.push(
        `- Matches: ${matches.length} | Drifts: ${drifts.length} | Gaps: ${cognitionGaps.length} | Surprises: ${cognitionSurprises.length}`,
      );

      if (cognitionGaps.length > 0) {
        lines.push("");
        lines.push("### Knowledge Gaps (in DSL but missing from thinker)");
        lines.push("| Entity Pair | Predicate |");
        lines.push("|-------------|-----------|");
        for (const g of cognitionGaps) {
          lines.push(`| ${g.pointerKeyPair} | ${g.predicate} |`);
        }
      }

      if (cognitionSurprises.length > 0) {
        lines.push("");
        lines.push("### Knowledge Surprises (in thinker but not in DSL)");
        lines.push("| Entity Pair | Predicate |");
        lines.push("|-------------|-----------|");
        for (const s of cognitionSurprises) {
          lines.push(`| ${s.pointerKeyPair} | ${s.predicate} |`);
        }
      }

      // Per-Assertion Alignment
      lines.push("");
      lines.push("## Per-Assertion Alignment");
      lines.push("");
      lines.push("| CognitionKey | Settlement Stance | Live Stance | Status |");
      lines.push("|-------------|-------------------|-------------|--------|");
      for (const a of cognitionAlignments) {
        const sStance = a.settlementStance ?? "—";
        const lStance = a.scriptedStance ?? "—";
        let statusLabel: string;
        switch (a.status) {
          case "match": statusLabel = "✅ match"; break;
          case "drift": statusLabel = "⚠️ drift"; break;
          case "gap": statusLabel = "❌ gap"; break;
          case "surprise": statusLabel = "🆕 surprise"; break;
        }
        lines.push(`| ${a.pointerKeyPair}:${a.predicate} | ${sStance} | ${lStance} | ${statusLabel} |`);
      }
    }
  }

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

async function countTableRows(infra: ScenarioInfra, tableName: string): Promise<number> {
  const rows = await infra.sql<[{ count: string }]>`
    SELECT COUNT(*)::text AS count FROM ${infra.sql(tableName)}
  `;
  return parseInt(rows[0]?.count ?? "0", 10);
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

  const scriptedSet = new Map<AlignKey, { pointerKeyPair: string; predicate: string; stance?: string }>();
  for (const row of scriptedRows) {
    const parsed = safeParseRecordJson(row.record_json);
    const pair = parsed.targetPointerKey
      ? `${parsed.sourcePointerKey ?? "?"}+${parsed.targetPointerKey}`
      : (parsed.sourcePointerKey ?? row.cognition_key);
    const predicate = parsed.predicate ?? row.cognition_key;
    const stance = (row as Record<string, unknown>).stance as string | undefined;
    scriptedSet.set(makeKey(pair, predicate), { pointerKeyPair: pair, predicate, stance });
  }

  const settlementSet = new Map<AlignKey, { pointerKeyPair: string; predicate: string; stance?: string }>();
  for (const row of settlementRows) {
    const parsed = safeParseRecordJson(row.record_json);
    const pair = parsed.targetPointerKey
      ? `${parsed.sourcePointerKey ?? "?"}+${parsed.targetPointerKey}`
      : (parsed.sourcePointerKey ?? row.cognition_key);
    const predicate = parsed.predicate ?? row.cognition_key;
    const stance = (row as Record<string, unknown>).stance as string | undefined;
    settlementSet.set(makeKey(pair, predicate), { pointerKeyPair: pair, predicate, stance });
  }

  const allKeys = new Set([...scriptedSet.keys(), ...settlementSet.keys()]);
  const alignments: CognitionAlignment[] = [];

  for (const key of allKeys) {
    const inScripted = scriptedSet.has(key);
    const inSettlement = settlementSet.has(key);
    const scriptedEntry = scriptedSet.get(key);
    const settlementEntry = settlementSet.get(key);
    const entry = scriptedEntry ?? settlementEntry!;

    let status: CognitionAlignment["status"];
    if (inScripted && inSettlement) {
      const sStance = settlementEntry?.stance;
      const lStance = scriptedEntry?.stance;
      status = (sStance && lStance && sStance !== lStance) ? "drift" : "match";
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
      settlementStance: settlementEntry?.stance,
      scriptedStance: scriptedEntry?.stance,
    });
  }

  return alignments;
}
