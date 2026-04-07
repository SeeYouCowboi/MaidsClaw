import type { ProbeResult } from "./probe-types.js";

/**
 * Throw a descriptive error if any probe result failed. No-op when all pass or results are empty.
 */
export function assertAllProbesPass(results: ProbeResult[]): void {
  const failedProbes = results.filter((r) => !r.passed);
  if (failedProbes.length === 0) return;

  const total = results.length;
  const failedCount = failedProbes.length;

  throw new Error(
    `\nProbe assertion failed: ${failedCount} of ${total} probes failed\n\nFailed probes:\n${failedProbes
      .map(
        (r) =>
          `\n  Probe: "${r.probe.query}"\n  Method: ${r.probe.retrievalMethod}\n  Score: ${r.score.toFixed(2)}\n  Expected: [${r.probe.expectedFragments.join(", ")}]\n  Matched: [${r.matched.join(", ")}]\n  Missed: [${r.missed.join(", ")}]\n  Unexpected: [${r.unexpectedPresent.join(", ")}]`,
      )
      .join("\n")}\n`,
  );
}
