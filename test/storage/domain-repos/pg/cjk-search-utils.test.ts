import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { __resetCjkSegmenterForTests, initCjkSegmenter } from "../../../../src/memory/cjk-segmenter";
import { decomposeCjk } from "../../../../src/storage/domain-repos/pg/cjk-search-utils";

describe("cjk-search-utils decomposeCjk", () => {
  beforeEach(() => {
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
    __resetCjkSegmenterForTests();
    initCjkSegmenter();
  });

  afterEach(() => {
    delete process.env.MAIDSCLAW_CJK_SEGMENTER;
    __resetCjkSegmenterForTests();
  });

  it("prefers jieba word tokens over legacy character bigrams", () => {
    const decomp = decomposeCjk("我喜欢喝什么茶");

    expect(decomp.bigrams).toContain("喜欢");
    expect(decomp.bigrams).not.toContain("我喜");
    expect(decomp.bigrams).not.toContain("欢喝");
    expect(decomp.bigrams).not.toContain("么茶");
    expect(decomp.unigrams).toContain("茶");
  });

  it("keeps proper nouns as whole terms instead of sliding character pairs", () => {
    const decomp = decomposeCjk("爱丽丝去了储藏室");

    expect(decomp.bigrams).toContain("爱丽丝");
    expect(decomp.bigrams).toContain("储藏室");
    expect(decomp.bigrams).not.toContain("爱丽");
    expect(decomp.bigrams).not.toContain("丽丝");
    expect(decomp.bigrams).not.toContain("储藏");
    expect(decomp.bigrams).not.toContain("藏室");
  });

  it("preserves Latin terms alongside jieba CJK tokens", () => {
    const decomp = decomposeCjk("Alice有时候比管家还麻烦");

    expect(decomp.bigrams).toContain("有时候");
    expect(decomp.bigrams).toContain("管家");
    expect(decomp.bigrams).toContain("麻烦");
    expect(decomp.unigrams).toContain("alice");
  });
});
