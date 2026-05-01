import { describe, expect, it } from "bun:test";

import {
  CJK_NOISE_STOPWORDS,
  isAcceptableEntitySurface,
  normalizeEntityMentionSurface,
  normalizeEntityMentions,
} from "./entity-mentions.js";

describe("isAcceptableEntitySurface", () => {
  it("accepts typed pointer keys regardless of body", () => {
    expect(isAcceptableEntitySurface("char:butler")).toBe(true);
    expect(isAcceptableEntitySurface("item:silver_pocket_watch")).toBe(true);
    expect(isAcceptableEntitySurface("loc:tea_room")).toBe(true);
  });

  it("accepts Latin proper nouns and snake_case pointer bodies", () => {
    expect(isAcceptableEntitySurface("Alice")).toBe(true);
    expect(isAcceptableEntitySurface("silver_pocket_watch")).toBe(true);
    expect(isAcceptableEntitySurface("tea_room")).toBe(true);
  });

  it("rejects single-character Latin", () => {
    expect(isAcceptableEntitySurface("A")).toBe(false);
  });

  it("accepts seeded CJK entity names", () => {
    for (const name of ["茶室", "温室", "花房", "书房", "管家", "梅姨"]) {
      expect(isAcceptableEntitySurface(name)).toBe(true);
    }
  });

  it("accepts multi-char CJK entity names", () => {
    expect(isAcceptableEntitySurface("银怀表")).toBe(true);
    expect(isAcceptableEntitySurface("金怀表")).toBe(true);
    expect(isAcceptableEntitySurface("花房的人")).toBe(true);
  });

  it("rejects single-character CJK surfaces", () => {
    expect(isAcceptableEntitySurface("门")).toBe(false);
    expect(isAcceptableEntitySurface("假")).toBe(false);
  });

  it("rejects CJK noise stopwords", () => {
    for (const word of [
      "早安",
      "安静",
      "正式",
      "随便",
      "聊聊",
      "这么",
      "要是",
      "感觉",
      "一遍",
      "假设",
      "偏好",
      "太苦",
      "什么",
      "为什么",
      "觉得",
      "起来",
      "总是",
    ]) {
      expect(isAcceptableEntitySurface(word)).toBe(false);
    }
  });

  it("rejects all-punctuation surfaces", () => {
    expect(isAcceptableEntitySurface("……")).toBe(false);
    expect(isAcceptableEntitySurface("???")).toBe(false);
    expect(isAcceptableEntitySurface("。。")).toBe(false);
  });

  it("rejects over-length CJK fragments", () => {
    // 13 CJK chars — likely a sentence fragment, not an entity reference.
    expect(isAcceptableEntitySurface("一二三四五六七八九十一二三")).toBe(false);
  });
});

describe("normalizeEntityMentionSurface", () => {
  it("returns null for noise that previously slipped through", () => {
    expect(normalizeEntityMentionSurface("早安")).toBeNull();
    expect(normalizeEntityMentionSurface("感觉")).toBeNull();
    expect(normalizeEntityMentionSurface("门")).toBeNull();
  });

  it("preserves seeded entity surfaces", () => {
    expect(normalizeEntityMentionSurface("茶室")).toBe("茶室");
    expect(normalizeEntityMentionSurface("管家")).toBe("管家");
    expect(normalizeEntityMentionSurface("Alice")).toBe("Alice");
  });

  it("rejects 'self' / 'user' / 'current_location' regardless of case", () => {
    expect(normalizeEntityMentionSurface("self")).toBeNull();
    expect(normalizeEntityMentionSurface("USER")).toBeNull();
    expect(normalizeEntityMentionSurface("Current_Location")).toBeNull();
  });
});

describe("normalizeEntityMentions", () => {
  it("filters noise from a mixed array and dedupes the rest", () => {
    const out = normalizeEntityMentions([
      "早安",
      "茶室",
      "感觉",
      "茶室",
      "Alice",
      "门",
      "管家",
      "char:butler",
    ]);
    expect(out).toEqual(["茶室", "Alice", "管家", "char:butler"]);
  });

  it("returns [] for empty input", () => {
    expect(normalizeEntityMentions(undefined)).toEqual([]);
    expect(normalizeEntityMentions([])).toEqual([]);
  });

  it("respects maxItems", () => {
    const out = normalizeEntityMentions(
      ["茶室", "温室", "花房", "书房", "管家"],
      { maxItems: 3 },
    );
    expect(out).toEqual(["茶室", "温室", "花房"]);
  });

  it("throws when value is not an array", () => {
    expect(() => normalizeEntityMentions(42 as unknown)).toThrow();
  });
});

describe("CJK_NOISE_STOPWORDS", () => {
  it("does not include words that could be real entity names", () => {
    // Sanity guard against accidental over-aggressive filtering — these
    // must NEVER appear in the noise list because some session may legitimately
    // use them as a character / location / item name.
    for (const candidate of ["梅姨", "茶室", "温室", "花房", "管家", "Alice"]) {
      expect(CJK_NOISE_STOPWORDS.has(candidate)).toBe(false);
    }
  });
});
