import { createRequire } from "node:module";

import { fitsInWindow as fallbackFitsInWindow, truncateToWindow as fallbackTruncateToWindow } from "../native-fallbacks/context-window.js";
import { matchKeywords as fallbackMatchKeywords } from "../native-fallbacks/lore-matcher.js";
import { countTokens as fallbackCountTokens, countTokensBatch as fallbackCountTokensBatch } from "../native-fallbacks/token-counter.js";

type NativeApi = {
  countTokens: (text: string) => number;
  countTokensBatch: (texts: string[]) => number[];
  matchKeywords: (text: string, keywords: string[]) => string[];
  fitsInWindow: (tokenCount: number, maxTokens: number) => boolean;
  truncateToWindow: (tokens: string[], maxTokens: number) => string[];
};

const fallbackApi: NativeApi = {
  countTokens: fallbackCountTokens,
  countTokensBatch: fallbackCountTokensBatch,
  matchKeywords: fallbackMatchKeywords,
  fitsInWindow: fallbackFitsInWindow,
  truncateToWindow: fallbackTruncateToWindow,
};

const forceFallback = process.env.MAIDSCLAW_NATIVE_MODULES === "false";

let loadedApi: NativeApi | null = null;
if (!forceFallback) {
  try {
    const require = createRequire(import.meta.url);
    const nativeApi = require("../../native/index.node") as Partial<NativeApi>;

    if (
      typeof nativeApi.countTokens === "function"
      && typeof nativeApi.countTokensBatch === "function"
      && typeof nativeApi.matchKeywords === "function"
      && typeof nativeApi.fitsInWindow === "function"
      && typeof nativeApi.truncateToWindow === "function"
    ) {
      loadedApi = nativeApi as NativeApi;
    }
  } catch {
    loadedApi = null;
  }
}

const api = loadedApi ?? fallbackApi;

export const NATIVE_AVAILABLE = loadedApi !== null;

export const countTokens = api.countTokens;
export const countTokensBatch = api.countTokensBatch;
export const matchKeywords = api.matchKeywords;
export const fitsInWindow = api.fitsInWindow;
export const truncateToWindow = api.truncateToWindow;
