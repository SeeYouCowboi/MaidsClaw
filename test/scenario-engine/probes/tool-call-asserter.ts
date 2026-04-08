import type { StoryBeat } from "../dsl/story-types.js";
import type { BeatCallLog } from "../generators/scripted-provider.js";
import type { ToolCallAssertionResult } from "./scenario-assertion-types.js";

function collectToolNames(beatLog: BeatCallLog): string[] {
  return beatLog.flushCalls.flatMap((flushCall) => flushCall.toolCalls).map((toolCall) => toolCall.name);
}

export function assertToolCallPatterns(
  beats: StoryBeat[],
  beatCallLogs: BeatCallLog[],
): ToolCallAssertionResult[] {
  const logByBeatId = new Map<string, BeatCallLog>();
  for (const log of beatCallLogs) {
    logByBeatId.set(log.beatId, log);
  }

  const results: ToolCallAssertionResult[] = [];

  for (const beat of beats) {
    const pattern = beat.expectedToolPattern;
    if (!pattern) continue;

    const beatLog = logByBeatId.get(beat.id);
    if (!beatLog) continue;

    const toolNames = collectToolNames(beatLog);
    const violations: ToolCallAssertionResult["violations"] = [];

    for (const name of pattern.mustContain ?? []) {
      if (!toolNames.includes(name)) {
        violations.push({
          rule: "mustContain",
          detail: `tool '${name}' not found in calls [${toolNames.join(", ")}]`,
        });
      }
    }

    for (const name of pattern.mustNotContain ?? []) {
      if (toolNames.includes(name)) {
        violations.push({
          rule: "mustNotContain",
          detail: `tool '${name}' was called but must not appear`,
        });
      }
    }

    const actualCallCount = toolNames.length;
    if (
      typeof pattern.minCalls === "number" &&
      actualCallCount < pattern.minCalls
    ) {
      violations.push({
        rule: "minCalls",
        detail: `expected >= ${pattern.minCalls} calls, got ${actualCallCount}`,
      });
    }

    if (
      typeof pattern.maxCalls === "number" &&
      actualCallCount > pattern.maxCalls
    ) {
      violations.push({
        rule: "maxCalls",
        detail: `expected <= ${pattern.maxCalls} calls, got ${actualCallCount}`,
      });
    }

    results.push({
      kind: "tool_call_pattern",
      beatId: beat.id,
      passed: violations.length === 0,
      violations,
    });
  }

  return results;
}

export function assertAllToolCallPatternsPass(
  results: ToolCallAssertionResult[],
): void {
  const failed = results.filter((result) => !result.passed);
  if (failed.length === 0) return;

  const total = results.length;
  const failedCount = failed.length;

  throw new Error(
    `\nTool call pattern assertion failed: ${failedCount} of ${total} beats failed\n\nFailed beats:\n${failed
      .map((result) => {
        const violationsText = result.violations
          .map((violation) => `    - ${violation.rule}: ${violation.detail}`)
          .join("\n");
        return `\n  Beat: ${result.beatId}\n  Violations:\n${violationsText}`;
      })
      .join("\n")}\n`,
  );
}
