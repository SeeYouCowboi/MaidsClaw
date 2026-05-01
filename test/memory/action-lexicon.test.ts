import { describe, expect, it } from "bun:test";
import {
  ACTION_LEXICON,
  expandQuerySynonyms,
  expandSynonyms,
} from "../../src/memory/action-lexicon.js";

describe("expandSynonyms — single token", () => {
  it("returns family siblings for a Chinese token", () => {
    const synonyms = expandSynonyms("去");
    expect(synonyms).toContain("来到");
    expect(synonyms).toContain("回到");
    expect(synonyms).toContain("走到");
    expect(synonyms).toContain("进入");
    expect(synonyms).toContain("离开");
    expect(synonyms).not.toContain("去");
  });

  it("returns family siblings for an English lemma", () => {
    const synonyms = expandSynonyms("walk");
    // English lemmas, inflections, and the Chinese tokens of the same
    // family are all reachable.
    expect(synonyms).toContain("go");
    expect(synonyms).toContain("move");
    expect(synonyms).toContain("walked");
    expect(synonyms).toContain("去");
    expect(synonyms).not.toContain("walk");
  });

  it("returns family siblings for an English inflection", () => {
    const synonyms = expandSynonyms("opened");
    expect(synonyms).toContain("open");
    expect(synonyms).toContain("close");
    expect(synonyms).toContain("打开");
  });

  it("does NOT cross family boundaries", () => {
    const moveSynonyms = expandSynonyms("去");
    expect(moveSynonyms).not.toContain("拿起"); // possession family
    expect(moveSynonyms).not.toContain("打开"); // status_change family
  });

  it("is case-insensitive on input", () => {
    const lower = expandSynonyms("walk");
    const upper = expandSynonyms("WALK");
    expect(upper).toEqual(lower);
  });

  it("returns empty for tokens outside the lexicon", () => {
    expect(expandSynonyms("爱丽丝")).toEqual([]);
    expect(expandSynonyms("garden")).toEqual([]);
    expect(expandSynonyms("")).toEqual([]);
  });
});

describe("expandQuerySynonyms — multiple tokens", () => {
  it("aggregates synonyms across tokens, deduped", () => {
    const synonyms = expandQuerySynonyms(["去", "拿起"]);
    // move family
    expect(synonyms).toContain("来到");
    // possession family
    expect(synonyms).toContain("拿出");
    // dedup: every entry is unique
    expect(new Set(synonyms).size).toBe(synonyms.length);
  });

  it("excludes tokens already present in the input set", () => {
    const synonyms = expandQuerySynonyms(["去", "来到"]);
    // "来到" was already in the input — must not appear in expansion
    expect(synonyms).not.toContain("来到");
    // Other family siblings still appear
    expect(synonyms).toContain("回到");
    expect(synonyms).toContain("走到");
  });

  it("returns empty when no token belongs to any family", () => {
    expect(expandQuerySynonyms(["爱丽丝", "花房"])).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(expandQuerySynonyms([])).toEqual([]);
  });
});

describe("ACTION_LEXICON shape", () => {
  it("loads with the three known families", () => {
    expect(Object.keys(ACTION_LEXICON.families).sort()).toEqual([
      "move",
      "possession",
      "status_change",
    ]);
  });

  it("each family has en lemmas + inflections and cn tokens", () => {
    for (const [, group] of Object.entries(ACTION_LEXICON.families)) {
      expect(group.en.lemmas.length).toBeGreaterThan(0);
      expect(group.cn.tokens.length).toBeGreaterThan(0);
      // Every lemma has an inflections entry (possibly empty list).
      for (const lemma of group.en.lemmas) {
        expect(group.en.inflections[lemma]).toBeDefined();
      }
    }
  });
});
