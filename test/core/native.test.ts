import { beforeEach, describe, expect, it } from "bun:test";

type NativeModule = typeof import("../../src/core/native.js");

let moduleSeed = 0;

async function loadNativeModule(forceFallback: boolean): Promise<NativeModule> {
  if (forceFallback) {
    process.env.MAIDSCLAW_NATIVE_MODULES = "false";
  } else {
    delete process.env.MAIDSCLAW_NATIVE_MODULES;
  }

  moduleSeed += 1;
  return import(`../../src/core/native.js?native-test=${moduleSeed}`);
}

describe("core/native", () => {
  beforeEach(() => {
    delete process.env.MAIDSCLAW_NATIVE_MODULES;
  });

  it("uses fallback mode when native modules are forced off", async () => {
    const module = await loadNativeModule(true);

    expect(module.NATIVE_AVAILABLE).toBe(false);
    expect(module.countTokens("hello world")).toBe(3);
    expect(module.countTokensBatch(["", "hello world"])).toEqual([0, 3]);
    expect(module.matchKeywords("The dragon attacked", ["dragon", "castle"])).toEqual(["dragon"]);
    expect(module.fitsInWindow(5, 10)).toBe(true);
    expect(module.fitsInWindow(11, 10)).toBe(false);
    expect(module.truncateToWindow(["a", "b", "c", "d"], 2)).toEqual(["c", "d"]);
  });

  it("has stable behavior in default mode", async () => {
    const module = await loadNativeModule(false);

    expect(module.countTokens("hello world")).toBe(3);
    expect(module.matchKeywords("The dragon attacked", ["dragon", "castle"])).toEqual(["dragon"]);
    expect(module.fitsInWindow(7, 6)).toBe(false);
    expect(module.truncateToWindow(["one", "two", "three"], 5)).toEqual(["one", "two", "three"]);
  });

  it("matches fallback results when native module is available", async () => {
    const defaultModule = await loadNativeModule(false);
    const fallbackModule = await loadNativeModule(true);

    if (!defaultModule.NATIVE_AVAILABLE) {
      expect(defaultModule.NATIVE_AVAILABLE).toBe(false);
      return;
    }

    const text = "hello world";
    const batch = ["hello world", "abcd", ""];
    const loreText = "The dragon attacked the castle walls";
    const keywords = ["dragon", "castle", "wizard"];
    const tokens = ["t1", "t2", "t3", "t4", "t5"];

    expect(defaultModule.countTokens(text)).toBe(fallbackModule.countTokens(text));
    expect(defaultModule.countTokensBatch(batch)).toEqual(fallbackModule.countTokensBatch(batch));
    expect(defaultModule.matchKeywords(loreText, keywords)).toEqual(fallbackModule.matchKeywords(loreText, keywords));
    expect(defaultModule.fitsInWindow(5, 4)).toBe(fallbackModule.fitsInWindow(5, 4));
    expect(defaultModule.truncateToWindow(tokens, 3)).toEqual(fallbackModule.truncateToWindow(tokens, 3));
  });
});
