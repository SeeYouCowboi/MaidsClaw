import { describe, expect, it } from "bun:test";
import { tokenizeQuery, containsCjk } from "../../src/memory/query-tokenizer";

describe("tokenizeQuery", () => {
  describe("Latin text", () => {
    it("splits on non-alphanumeric boundaries", () => {
      const tokens = tokenizeQuery("Alice went to the garden");
      expect(tokens).toContain("Alice");
      expect(tokens).toContain("went");
      expect(tokens).toContain("the");
      expect(tokens).toContain("garden");
    });

    it("filters single-character tokens", () => {
      const tokens = tokenizeQuery("A B cd");
      expect(tokens).not.toContain("A");
      expect(tokens).not.toContain("B");
      expect(tokens).toContain("cd");
    });

    it("preserves @ prefix tokens", () => {
      const tokens = tokenizeQuery("@Alice hello");
      expect(tokens).toContain("@Alice");
    });
  });

  describe("CJK text", () => {
    it("extracts full CJK runs for alias matching", () => {
      const tokens = tokenizeQuery("@爱丽丝 你好");
      expect(tokens).toContain("爱丽丝");
    });

    it("produces bigrams from CJK runs", () => {
      const tokens = tokenizeQuery("储藏室");
      expect(tokens).toContain("储藏室"); // full run
      expect(tokens).toContain("储藏");   // bigram
      expect(tokens).toContain("藏室");   // bigram
    });

    it("filters stopword-only bigrams", () => {
      const tokens = tokenizeQuery("的了是在");
      // All characters are stopwords; bigrams of two stopwords are excluded
      const bigramCount = tokens.filter((t) => t.length === 2).length;
      expect(bigramCount).toBe(0);
    });

    it("keeps bigrams with at least one non-stopword character", () => {
      const tokens = tokenizeQuery("好的");
      expect(tokens).toContain("好的"); // full run (2 chars)
      // "好" is not a stopword, "的" is — bigram should be kept
      expect(tokens.some((t) => t === "好的")).toBe(true);
    });

    it("does not produce tokens for single CJK character", () => {
      const tokens = tokenizeQuery("好");
      // Single char: no full run (< 2), no bigrams
      expect(tokens).toEqual([]);
    });
  });

  describe("mixed Latin + CJK", () => {
    it("handles interleaved Latin and CJK", () => {
      const tokens = tokenizeQuery("为什么Alice最近对Bob态度变了");
      expect(tokens).toContain("Alice");
      expect(tokens).toContain("Bob");
      expect(tokens).toContain("最近");
      expect(tokens).toContain("态度");
    });

    it("handles long CJK sentence with entities", () => {
      const tokens = tokenizeQuery("爱丽丝昨天晚上在储藏室里偷偷观察了管家和厨娘之间的争吵");
      expect(tokens).toContain("爱丽"); // bigram
      expect(tokens).toContain("丽丝"); // bigram
      expect(tokens).toContain("昨天");
      expect(tokens).toContain("储藏");
      expect(tokens).toContain("藏室");
      expect(tokens).toContain("管家");
      expect(tokens).toContain("厨娘");
      expect(tokens).toContain("争吵");
    });

    it("handles complex mixed query with reasoning", () => {
      const tokens = tokenizeQuery("Bob因为之前在花园里发现的线索所以怀疑Alice和管家串通一气欺骗了所有人");
      expect(tokens).toContain("Alice");
      expect(tokens).toContain("Bob");
      expect(tokens).toContain("花园");
      expect(tokens).toContain("线索");
      expect(tokens).toContain("怀疑");
      expect(tokens).toContain("管家");
      expect(tokens).toContain("串通");
      expect(tokens).toContain("欺骗");
    });

    it("handles long CJK query with time references", () => {
      const tokens = tokenizeQuery("请告诉我从昨天到现在这段时间里城堡内所有区域发生过的全部事件的详细时间线");
      expect(tokens).toContain("昨天");
      expect(tokens).toContain("城堡");
      expect(tokens).toContain("区域");
      expect(tokens).toContain("事件");
      expect(tokens).toContain("时间");
    });

    it("handles @ mentions mixed with CJK", () => {
      const tokens = tokenizeQuery("@Alice @Bob 你们两个之间到底发生了什么为什么关系突然变得这么差");
      expect(tokens).toContain("@Alice");
      expect(tokens).toContain("@Bob");
      expect(tokens).toContain("关系");
    });
  });

  describe("edge cases", () => {
    it("returns empty for empty string", () => {
      expect(tokenizeQuery("")).toEqual([]);
    });

    it("returns empty for single Latin character", () => {
      expect(tokenizeQuery("A")).toEqual([]);
    });

    it("deduplicates tokens", () => {
      const tokens = tokenizeQuery("Alice Alice");
      const aliceCount = tokens.filter((t) => t === "Alice").length;
      expect(aliceCount).toBe(1);
    });
  });
});

describe("containsCjk", () => {
  it("returns true for Chinese text", () => {
    expect(containsCjk("你好")).toBe(true);
  });

  it("returns true for mixed text", () => {
    expect(containsCjk("hello你好")).toBe(true);
  });

  it("returns false for pure Latin text", () => {
    expect(containsCjk("hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(containsCjk("")).toBe(false);
  });
});
