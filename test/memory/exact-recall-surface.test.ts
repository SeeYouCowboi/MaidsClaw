import { describe, expect, it } from "bun:test";
import { mergeSignalCandidates } from "../../src/memory/retrieval/candidate-merge.js";
import { RRF_K } from "../../src/memory/retrieval/search-backend-contract.js";

describe("mergeSignalCandidates exact-recall surface", () => {
  it("promotes exact candidates and applies signal-weighted RRF", () => {
    const merged = mergeSignalCandidates([
      {
        sourceRef: "episode:2",
        signal: "pointer_exact",
        rank: 0,
        scoreHint: 2.5,
      },
      {
        sourceRef: "episode:2",
        signal: "bm25_en",
        rank: 0,
        content: "finds pocket watch near greenhouse",
      },
      {
        sourceRef: "episode:2",
        signal: "embedding",
        rank: 0,
      },
      {
        sourceRef: "episode:1",
        signal: "alias_exact",
        rank: 0,
      },
      {
        sourceRef: "episode:1",
        signal: "embedding",
        rank: 2,
      },
      {
        sourceRef: "episode:3",
        signal: "bm25_en",
        rank: 1,
      },
    ]);

    expect(merged).toHaveLength(3);
    expect(merged[0]?.sourceRef).toBe("episode:2");
    expect(merged[1]?.sourceRef).toBe("episode:1");
    expect(merged[2]?.sourceRef).toBe("episode:3");

    const expectedTopScore = (2.5 + 1.2 + 1.2) / (RRF_K + 1);
    const expectedSecondScore = 3.0 / (RRF_K + 1) + 1.2 / (RRF_K + 3);
    expect(merged[0]?.score).toBeCloseTo(expectedTopScore, 10);
    expect(merged[1]?.score).toBeCloseTo(expectedSecondScore, 10);

    expect(merged[0]?.signals.sort()).toEqual([
      "bm25_en",
      "embedding",
      "pointer_exact",
    ]);
    expect(merged[1]?.signals.sort()).toEqual(["alias_exact", "embedding"]);
    expect(merged[0]?.content).toBe("finds pocket watch near greenhouse");
  });
});
