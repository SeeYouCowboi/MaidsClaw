import { describe, expect, it } from "bun:test";
import { tokenizeQuery, containsCjk } from "../../src/memory/query-tokenizer";

// Default test environment uses the jieba-backed path. The `MAIDSCLAW_CJK_SEGMENTER=off`
// fallback is exercised by test/memory/query-tokenizer-fallback.test.ts via a
// module cache-bust pattern.

describe("tokenizeQuery — Latin text", () => {
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

describe("tokenizeQuery — CJK text (jieba-backed)", () => {
  it("identifies multi-character proper nouns as single tokens", () => {
    // Default jieba dictionary recognizes common proper nouns.
    const tokens = tokenizeQuery("储藏室");
    expect(tokens).toContain("储藏室");
    // No bigrams — jieba outputs the whole word.
    expect(tokens).not.toContain("储藏");
    expect(tokens).not.toContain("藏室");
  });

  it("extracts proper nouns from @ mentions", () => {
    const tokens = tokenizeQuery("@爱丽丝 你好");
    expect(tokens).toContain("爱丽丝");
  });

  it("drops short function-word fragments", () => {
    // jieba splits "的了是在" into single-character tokens → len >= 2 filter removes all.
    const tokens = tokenizeQuery("的了是在");
    expect(tokens).toEqual([]);
  });

  it("does not produce tokens for single CJK character", () => {
    expect(tokenizeQuery("好")).toEqual([]);
  });

  it("drops two-character strings that jieba splits into two single chars", () => {
    // "好的" is segmented by jieba as ["好", "的"] — both are filtered by len >= 2.
    expect(tokenizeQuery("好的")).toEqual([]);
  });
});

describe("tokenizeQuery — mixed Latin + CJK", () => {
  it("handles interleaved Latin and CJK", () => {
    const tokens = tokenizeQuery("为什么Alice最近对Bob态度变了");
    expect(tokens).toContain("Alice");
    expect(tokens).toContain("Bob");
    expect(tokens).toContain("为什么");
    expect(tokens).toContain("最近");
    expect(tokens).toContain("态度");
  });

  it("handles long CJK sentence with proper nouns", () => {
    const tokens = tokenizeQuery(
      "爱丽丝昨天晚上在储藏室里偷偷观察了管家和厨娘之间的争吵",
    );
    // Proper nouns in default jieba dict — identified as single words, not bigrams.
    expect(tokens).toContain("爱丽丝");
    expect(tokens).toContain("储藏室");
    expect(tokens).toContain("管家");
    expect(tokens).toContain("厨娘");
    expect(tokens).toContain("争吵");
  });

  it("handles complex mixed query with reasoning words", () => {
    const tokens = tokenizeQuery(
      "Bob因为之前在花园里发现的线索所以怀疑Alice和管家串通一气欺骗了所有人",
    );
    expect(tokens).toContain("Alice");
    expect(tokens).toContain("Bob");
    expect(tokens).toContain("线索");
    expect(tokens).toContain("怀疑");
    expect(tokens).toContain("管家");
    expect(tokens).toContain("欺骗");
    // jieba may merge "花园里" as a single word — check substring presence or merged word.
    expect(
      tokens.includes("花园") || tokens.includes("花园里"),
    ).toBe(true);
  });

  it("handles long CJK query with time references", () => {
    const tokens = tokenizeQuery(
      "请告诉我从昨天到现在这段时间里城堡内所有区域发生过的全部事件的详细时间线",
    );
    expect(tokens).toContain("昨天");
    expect(tokens).toContain("城堡");
    expect(tokens).toContain("区域");
    expect(tokens).toContain("事件");
    expect(tokens).toContain("时间");
  });

  it("handles @ mentions mixed with CJK", () => {
    const tokens = tokenizeQuery(
      "@Alice @Bob 你们两个之间到底发生了什么为什么关系突然变得这么差",
    );
    expect(tokens).toContain("@Alice");
    expect(tokens).toContain("@Bob");
    expect(tokens).toContain("关系");
    expect(tokens).toContain("为什么");
  });
});

describe("tokenizeQuery — edge cases", () => {
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

  it("filters pure punctuation tokens from jieba output", () => {
    // jieba may emit punctuation as separate tokens — they must be dropped.
    const tokens = tokenizeQuery("爱丽丝，你好。");
    expect(tokens).not.toContain("，");
    expect(tokens).not.toContain("。");
    expect(tokens).toContain("爱丽丝");
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
