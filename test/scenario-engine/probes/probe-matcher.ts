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
    // Support OR matching: if fragment is an array, any alternative counts as a match.
    const alternatives = Array.isArray(fragment) ? fragment : [fragment];
    const matchedAlt = alternatives.find((alt) => {
      const lower = alt.toLowerCase();
      return topHits.some((h) => h.content.toLowerCase().includes(lower));
    });
    const label = Array.isArray(fragment) ? fragment.join("|") : fragment;
    if (matchedAlt) {
      matched.push(matchedAlt);
    } else {
      missed.push(label);
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

  let conflictFieldResults:
    | { field: string; expected: boolean; actual: boolean }[]
    | undefined;
  let conflictFieldsPassed = true;

  if (
    probe.expectedConflictFields &&
    probe.retrievalMethod === "cognition_search"
  ) {
    conflictFieldResults = [];
    const { hasConflictSummary, expectedFactorRefs, hasResolution } =
      probe.expectedConflictFields;

    if (hasConflictSummary !== undefined) {
      const actual = topHits.some(
        (h) => h.conflictSummary != null && h.conflictSummary !== "",
      );
      conflictFieldResults.push({
        field: "hasConflictSummary",
        expected: hasConflictSummary,
        actual,
      });
      if (actual !== hasConflictSummary) conflictFieldsPassed = false;
    }

    if (expectedFactorRefs && expectedFactorRefs.length > 0) {
      const allRefs = topHits.flatMap((h) => h.conflictFactorRefs ?? []);
      const actual = expectedFactorRefs.every((ref) => allRefs.includes(ref));
      conflictFieldResults.push({
        field: "expectedFactorRefs",
        expected: true,
        actual,
      });
      if (!actual) conflictFieldsPassed = false;
    }

    if (hasResolution !== undefined) {
      const actual = topHits.some(
        (h) => h.resolution != null,
      );
      conflictFieldResults.push({
        field: "hasResolution",
        expected: hasResolution,
        actual,
      });
      if (actual !== hasResolution) conflictFieldsPassed = false;
    }
  }

  const score =
    probe.expectedFragments.length === 0
      ? 1.0
      : matched.length / probe.expectedFragments.length;

  let passed: boolean;
  if (mode === "deterministic") {
    passed =
      score >= 1.0 &&
      unexpectedPresent.length === 0 &&
      conflictFieldsPassed;
  } else {
    const threshold = options?.liveThreshold ?? DEFAULT_LIVE_THRESHOLD;
    passed = score >= threshold && conflictFieldsPassed;
  }

  return {
    probe,
    hits: topHits,
    matched,
    missed,
    unexpectedPresent,
    score,
    passed,
    conflictFieldResults,
  };
}
