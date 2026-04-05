import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ProbeResult } from "./probe-types.js";
import type { ScenarioRunResult } from "../runner/infra.js";
import type { Story } from "../dsl/story-types.js";

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
  lines.push("## Per-Beat Error Summary");
  lines.push("| Beat ID | Error |");
  lines.push("|---------|-------|");
  if (runResult.errors.length === 0) {
    lines.push("| No errors | |");
  } else {
    for (const err of runResult.errors) {
      lines.push(`| ${err.beatId} | ${err.error.message} |`);
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
