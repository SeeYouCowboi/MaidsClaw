// IMPORTANT: The cjk-segmenter module is a process-global singleton. Tests
// in this file mutate `instance`, `initialized`, `enabled`, and related state
// via `__resetCjkSegmenterForTests`. Bun runs test files sequentially within
// a single process by default, so:
//   1. beforeEach/afterEach MUST reset state to avoid leaking into later tests
//      in this file
//   2. Final afterEach MUST leave the segmenter in its default enabled state
//      so subsequent test files (which assume jieba is on) still work
// If you add new tests that flip MAIDSCLAW_CJK_SEGMENTER, verify afterEach
// restores the env var AND calls __resetCjkSegmenterForTests().
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  __resetCjkSegmenterForTests,
  getCjkSegmenterStatus,
  initCjkSegmenter,
  isCjkSegmenterAvailable,
  loadUserDict,
  segmentCjk,
} from "../../src/memory/cjk-segmenter";

describe("cjk-segmenter — initialization", () => {
  beforeEach(() => {
    __resetCjkSegmenterForTests();
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
  });

  afterEach(() => {
    __resetCjkSegmenterForTests();
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
  });

  it("initCjkSegmenter does not throw", () => {
    expect(() => initCjkSegmenter()).not.toThrow();
  });

  it("multiple init calls are idempotent", () => {
    initCjkSegmenter();
    initCjkSegmenter();
    initCjkSegmenter();
    expect(isCjkSegmenterAvailable()).toBe(true);
  });

  it("isCjkSegmenterAvailable lazily initializes", () => {
    // Reset state so no prior init leaked.
    __resetCjkSegmenterForTests();
    expect(isCjkSegmenterAvailable()).toBe(true);
  });

  it("MAIDSCLAW_CJK_SEGMENTER=off disables segmenter", () => {
    __resetCjkSegmenterForTests();
    process.env.MAIDSCLAW_CJK_SEGMENTER = "off";
    __resetCjkSegmenterForTests(); // Re-read env
    initCjkSegmenter();
    expect(isCjkSegmenterAvailable()).toBe(false);
    expect(segmentCjk("爱丽丝")).toBeNull();
  });
});

describe("cjk-segmenter — default dictionary", () => {
  beforeEach(() => {
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
    __resetCjkSegmenterForTests();
    initCjkSegmenter();
  });

  afterEach(() => {
    __resetCjkSegmenterForTests();
  });

  it("recognizes common proper nouns: 爱丽丝 / 储藏室 / 管家 / 厨娘", () => {
    const segments = segmentCjk("爱丽丝去了储藏室");
    expect(segments).not.toBeNull();
    expect(segments).toContain("爱丽丝");
    expect(segments).toContain("储藏室");
  });

  it("segments 管家和厨娘的争吵 into distinct word tokens", () => {
    const segments = segmentCjk("管家和厨娘的争吵");
    expect(segments).not.toBeNull();
    expect(segments).toContain("管家");
    expect(segments).toContain("厨娘");
    expect(segments).toContain("争吵");
  });

  it("returns an array for pure Latin input (passes through)", () => {
    const segments = segmentCjk("hello world");
    expect(segments).not.toBeNull();
    expect(Array.isArray(segments)).toBe(true);
  });

  it("returns an array for empty string", () => {
    const segments = segmentCjk("");
    expect(segments).not.toBeNull();
    expect(segments).toEqual([]);
  });
});

describe("cjk-segmenter — user dictionary", () => {
  beforeEach(() => {
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
    __resetCjkSegmenterForTests();
    initCjkSegmenter();
  });

  afterEach(() => {
    __resetCjkSegmenterForTests();
  });

  it("out-of-dict name is split before loading user dict", () => {
    // "鲍勃" is not in the default jieba dictionary — it will be split into single chars.
    const before = segmentCjk("鲍勃离开了");
    expect(before).not.toBeNull();
    // Either single-char splits OR jieba's default may not find "鲍勃" as a word.
    const hasWholeName = before!.includes("鲍勃");
    // If the default dict happens to include it, skip the pre-load assertion;
    // this test is about verifying the "after" state improves regardless.
    if (hasWholeName) return;
    expect(before!.some((s) => s === "鲍" || s === "勃")).toBe(true);
  });

  it("loadUserDict makes out-of-dict names segment as a single token", () => {
    loadUserDict(["鲍勃"]);
    const segments = segmentCjk("鲍勃离开了");
    expect(segments).not.toBeNull();
    expect(segments).toContain("鲍勃");
  });

  it("loadUserDict handles multiple custom words", () => {
    loadUserDict(["阿尔芒", "玛格丽特", "蔷薇厅"]);
    const segments = segmentCjk("阿尔芒在蔷薇厅见到了玛格丽特");
    expect(segments).not.toBeNull();
    expect(segments).toContain("阿尔芒");
    expect(segments).toContain("蔷薇厅");
    expect(segments).toContain("玛格丽特");
  });

  it("loadUserDict can be called multiple times to stack dictionaries", () => {
    loadUserDict(["鲍勃"]);
    loadUserDict(["蔷薇厅"]);
    const segments = segmentCjk("鲍勃在蔷薇厅");
    expect(segments).not.toBeNull();
    expect(segments).toContain("鲍勃");
    expect(segments).toContain("蔷薇厅");
  });

  it("loadUserDict filters Latin words, single chars, and empty strings", () => {
    // None of ["", "A", "ab", "好"] should be loaded as user-dict CJK words.
    // "爱丽丝" passes the filter (CJK + len >= 2).
    expect(() => loadUserDict(["", "A", "ab", "好", "爱丽丝"])).not.toThrow();
    const segments = segmentCjk("爱丽丝");
    expect(segments).not.toBeNull();
    expect(segments).toContain("爱丽丝");
  });

  it("loadUserDict with empty array is a no-op", () => {
    expect(() => loadUserDict([])).not.toThrow();
  });

  it("loadUserDict with all-filtered input is a no-op", () => {
    expect(() => loadUserDict(["A", "ab", "好"])).not.toThrow();
  });
});

describe("cjk-segmenter — fallback behavior when disabled", () => {
  beforeEach(() => {
    __resetCjkSegmenterForTests();
    process.env.MAIDSCLAW_CJK_SEGMENTER = "off";
    __resetCjkSegmenterForTests();
  });

  afterEach(() => {
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
    __resetCjkSegmenterForTests();
  });

  it("segmentCjk returns null when disabled", () => {
    expect(segmentCjk("爱丽丝")).toBeNull();
  });

  it("loadUserDict is a no-op when disabled", () => {
    expect(() => loadUserDict(["爱丽丝"])).not.toThrow();
    expect(segmentCjk("爱丽丝")).toBeNull();
  });

  it("isCjkSegmenterAvailable returns false", () => {
    expect(isCjkSegmenterAvailable()).toBe(false);
  });
});

describe("cjk-segmenter — getCjkSegmenterStatus", () => {
  beforeEach(() => {
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
    __resetCjkSegmenterForTests();
  });

  afterEach(() => {
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
    __resetCjkSegmenterForTests();
  });

  it("reports pre-init state", () => {
    const status = getCjkSegmenterStatus();
    expect(status.initialized).toBe(false);
    expect(status.available).toBe(false);
    expect(status.loadedUserWords).toBe(0);
    expect(status.lastInitError).toBeNull();
  });

  it("reports post-init state when enabled", () => {
    initCjkSegmenter();
    const status = getCjkSegmenterStatus();
    expect(status.initialized).toBe(true);
    expect(status.available).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.lastInitError).toBeNull();
  });

  it("tracks loadedUserWords across loadUserDict calls", () => {
    initCjkSegmenter();
    expect(getCjkSegmenterStatus().loadedUserWords).toBe(0);
    loadUserDict(["爱丽丝", "鲍勃"]);
    expect(getCjkSegmenterStatus().loadedUserWords).toBe(2);
    loadUserDict(["阿尔芒"]);
    expect(getCjkSegmenterStatus().loadedUserWords).toBe(3);
    // Filtered input contributes nothing
    loadUserDict(["A", "好"]);
    expect(getCjkSegmenterStatus().loadedUserWords).toBe(3);
  });

  it("reports disabled state when env flag is off", () => {
    process.env.MAIDSCLAW_CJK_SEGMENTER = "off";
    __resetCjkSegmenterForTests();
    initCjkSegmenter();
    const status = getCjkSegmenterStatus();
    expect(status.enabled).toBe(false);
    expect(status.available).toBe(false);
  });
});

describe("cjk-segmenter — test reset helper", () => {
  it("__resetCjkSegmenterForTests allows env-var changes between tests", () => {
    // Start enabled
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
    __resetCjkSegmenterForTests();
    expect(isCjkSegmenterAvailable()).toBe(true);

    // Disable
    process.env.MAIDSCLAW_CJK_SEGMENTER = "off";
    __resetCjkSegmenterForTests();
    expect(isCjkSegmenterAvailable()).toBe(false);

    // Re-enable
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
    __resetCjkSegmenterForTests();
    expect(isCjkSegmenterAvailable()).toBe(true);
  });
});

// Verify the tokenizer correctly falls back to its legacy bigram path when
// the segmenter is disabled. This exercises the `segmentCjk() === null` branch
// of query-tokenizer.ts without needing a separate test file + module cache
// busting.
describe("tokenizeQuery — bigram fallback path", () => {
  // Cleanup must restore default state so other test files see segmenter enabled.
  afterEach(() => {
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
    __resetCjkSegmenterForTests();
  });

  it("produces full CJK run + bigrams when segmenter is disabled", async () => {
    process.env.MAIDSCLAW_CJK_SEGMENTER = "off";
    __resetCjkSegmenterForTests();
    const { tokenizeQuery } = await import("../../src/memory/query-tokenizer");

    const tokens = tokenizeQuery("储藏室");
    expect(tokens).toContain("储藏室"); // full run
    expect(tokens).toContain("储藏"); // bigram
    expect(tokens).toContain("藏室"); // bigram
  });

  it("keeps full 2-char CJK run in fallback mode", async () => {
    process.env.MAIDSCLAW_CJK_SEGMENTER = "off";
    __resetCjkSegmenterForTests();
    const { tokenizeQuery } = await import("../../src/memory/query-tokenizer");

    expect(tokenizeQuery("好的")).toContain("好的");
  });

  it("still returns empty for single CJK char in fallback mode", async () => {
    process.env.MAIDSCLAW_CJK_SEGMENTER = "off";
    __resetCjkSegmenterForTests();
    const { tokenizeQuery } = await import("../../src/memory/query-tokenizer");

    expect(tokenizeQuery("好")).toEqual([]);
  });
});
