import type {
  ProbeDefinition,
  ProbeResult,
  RetrievalHit,
  MatchOptions,
} from "./probe-types.js";

const DEFAULT_LIVE_THRESHOLD = 0.7;

export function matchProbeResults(
  probe: ProbeDefinition,
  hits: RetrievalHit[],
  options?: MatchOptions,
): ProbeResult {
  const mode = options?.mode ?? "deterministic";
  const topHits = hits.slice(0, probe.topK);

  const matched: string[] = [];
  const missed: string[] = [];

  for (const fragment of probe.expectedFragments) {
    const lower = fragment.toLowerCase();
    const found = topHits.some((h) => h.content.toLowerCase().includes(lower));
    if (found) {
      matched.push(fragment);
    } else {
      missed.push(fragment);
    }
  }

  const unexpectedPresent: string[] = [];
  for (const anti of probe.expectedMissing ?? []) {
    const lower = anti.toLowerCase();
    const found = topHits.some((h) => h.content.toLowerCase().includes(lower));
    if (found) {
      unexpectedPresent.push(anti);
    }
  }

  const score =
    probe.expectedFragments.length === 0
      ? 1.0
      : matched.length / probe.expectedFragments.length;

  let passed: boolean;
  if (mode === "deterministic") {
    passed = score >= 1.0 && unexpectedPresent.length === 0;
  } else {
    const threshold = options?.liveThreshold ?? DEFAULT_LIVE_THRESHOLD;
    passed = score >= threshold;
  }

  return {
    probe,
    hits: topHits,
    matched,
    missed,
    unexpectedPresent,
    score,
    passed,
  };
}
