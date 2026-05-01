import { normalizePointerKey } from "./contracts/pointer-key.js";

const ENTITY_MENTION_SPECIAL_VALUES = new Set([
  "self",
  "user",
  "current_location",
]);

const DEFAULT_MAX_ENTITY_MENTIONS = 12;
const MAX_ENTITY_MENTION_LENGTH = 80;

// Min CJK length: a single CJK char is almost never a stable entity
// (e.g. 门 / 窗 / 假) and pollutes known_entities with one-char tokens.
// Latin proper nouns are required to be ≥ 2 chars by the surface-class
// rule below, so this floor only affects CJK-only surfaces.
const MIN_CJK_SURFACE_LENGTH = 2;

// Max CJK length: surfaces longer than this are typically phrases or
// fragments (e.g. "也不知道是不是真的"), not entity references.
const MAX_CJK_SURFACE_LENGTH = 12;

const CJK_CHAR_RE = /[一-鿿㐀-䶿豈-﫿]/u;
const ALL_LATIN_RE = /^[A-Za-z0-9_@.\-]+$/u;
const ALL_PUNCT_OR_SPACE_RE = /^[\p{P}\p{S}\s]+$/u;

/**
 * Surfaces that look like entity mentions but are actually function words,
 * greetings, time expressions, generic adjectives, or aspect markers.
 *
 * This is the SHARED noise list — both the LLM-emitted entityMentions path
 * (turn-service → normalizeEntityMentions) and the CJK fallback derivation
 * path filter through it. Keep them in one place so the two paths cannot
 * drift.
 *
 * Add only words that are:
 *   - never stable entity names (no character, location, or item ever
 *     called this), AND
 *   - likely to be over-emitted by an LLM that was asked for "entity
 *     mentions" but defaulted to topic words.
 *
 * Do NOT add words that could plausibly be a person/place/item name in
 * some session — e.g. "梅" (could be a character) or "茶" (could refer
 * to a specific tea) — even if they show up as noise in one transcript.
 */
export const CJK_NOISE_STOPWORDS: ReadonlySet<string> = new Set([
  // Demonstratives / generic nouns
  "主人",
  "这位",
  "那位",
  "这个",
  "那个",
  "这里",
  "那里",
  "那边",
  "这边",
  "这些",
  "这种",
  "这样",
  "一个",
  "一些",
  "一下",
  "一遍",
  "两块",
  "两个",
  "所有",
  "之间",
  "时候",
  "事情",
  "东西",
  "物品",
  "状态",
  "动作",
  "时间",
  "变化",
  // Time / sequence adverbs
  "今天",
  "最近",
  "早安",
  "晚安",
  "午安",
  "现在",
  "刚才",
  "最后",
  "一直",
  "当时",
  "到底",
  "总能",
  "后来",
  "以后",
  "下午",
  "肯定",
  "真正",
  "最新",
  "有时候",
  // Pronouns
  "自己",
  "我们",
  "你们",
  "他们",
  "它们",
  // Question words / interrogative phrases
  "是不是",
  "有没有",
  "什么",
  "为什么",
  "怎么",
  "如何",
  "哪儿",
  "哪里",
  "哪个",
  "哪些",
  // Modal / aspect / epistemic verbs
  "可以",
  "可能",
  "应该",
  "觉得",
  "感觉",
  "记得",
  "知道",
  "认为",
  "真的",
  "其实",
  "总是",
  "总往",
  "起来",
  "喜欢",
  "告诉",
  "多一些",
  "有点",
  "好像",
  "还是",
  "要是",
  "这么",
  "或者",
  "或许",
  "也许",
  "应当",
  "不该",
  "假设",
  "聊聊",
  "不会",
  "不是",
  "不过",
  "不然",
  "没有",
  "就是",
  "怀疑",
  "记错",
  "发生",
  "如果",
  "反应",
  "以为",
  "挪动",
  "看见",
  "关上",
  "打开",
  "锁上",
  "解锁",
  "点亮",
  "熄灭",
  "拿走",
  "拿来",
  "打翻",
  "还给",
  "交给",
  "递给",
  "提到",
  "注意",
  "搞混",
  "搞不清楚",
  "也就是说",
  "记不清",
  "的话",
  "忽然",
  "突然",
  "分别",
  "放下",
  "出来",
  "进去",
  "不想",
  "不见",
  "记住",
  "手里",
  // Phrasal connectives / closure markers
  "算了",
  "到此为止",
  "等等",
  // Generic adjectives the LLM tends to surface as "entities"
  "安静",
  "正式",
  "随便",
  "清楚",
  "辛苦",
  "偏好",
  "太苦",
  "不错",
  "可靠",
  "心情",
  "顺序",
  // Abstract action / state nouns (rule-like, not entity-like)
  "保密",
  "约束",
  "规矩",
  // Disambiguators that conflict with seeded location 花房
  "花园",
]);

function parseMaybeJson(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Returns true if the surface looks like a real entity reference rather
 * than function-word / greeting / generic-adjective noise.
 *
 * Surface classes (in priority order):
 *   1. Typed pointer (`char:butler`, `item:silver_pocket_watch`) — always
 *      accepted; canonical form by construction.
 *   2. All-Latin proper noun / pointer body (`Alice`, `silver_pocket_watch`)
 *      — accepted when ≥ 2 chars.
 *   3. CJK / mixed surfaces — rejected when in the noise stopword list,
 *      below the min CJK length, above the max CJK length, or made of only
 *      punctuation/symbols.
 */
export function isAcceptableEntitySurface(surface: string): boolean {
  if (surface.length === 0) return false;
  if (ALL_PUNCT_OR_SPACE_RE.test(surface)) return false;

  // Typed pointer keys (`char:butler`) are already canonical — never filter.
  if (surface.includes(":")) return true;

  // Pure Latin/digit identifiers (English names, snake_case pointer bodies).
  if (ALL_LATIN_RE.test(surface)) {
    return surface.length >= 2;
  }

  // CJK or mixed: apply the noise filter.
  if (CJK_NOISE_STOPWORDS.has(surface)) return false;

  const containsCjk = CJK_CHAR_RE.test(surface);
  if (containsCjk) {
    if (surface.length < MIN_CJK_SURFACE_LENGTH) return false;
    if (surface.length > MAX_CJK_SURFACE_LENGTH) return false;
  } else {
    // Neither pure Latin, pure CJK, nor punctuation — exotic mixed input.
    // Accept if length ≥ 2 to stay conservative.
    if (surface.length < 2) return false;
  }

  return true;
}

export function normalizeEntityMentionSurface(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) {
    return null;
  }
  if (
    ENTITY_MENTION_SPECIAL_VALUES.has(normalized.toLowerCase())
  ) {
    return null;
  }
  const trimmed = normalized.slice(0, MAX_ENTITY_MENTION_LENGTH);
  if (!isAcceptableEntitySurface(trimmed)) {
    return null;
  }
  return trimmed;
}

export function canonicalizeEntityMentionPointer(surface: string): string {
  return normalizePointerKey(surface.normalize("NFC"));
}

export function normalizeEntityMentions(
  raw: unknown,
  options?: {
    fieldName?: string;
    maxItems?: number;
  },
): string[] {
  if (raw === undefined) {
    return [];
  }

  const parsed = parseMaybeJson(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${options?.fieldName ?? "entityMentions"} must be an array when present`,
    );
  }

  const maxItems = Math.max(1, options?.maxItems ?? DEFAULT_MAX_ENTITY_MENTIONS);
  const seen = new Set<string>();
  const mentions: string[] = [];
  for (const entry of parsed) {
    const normalized = normalizeEntityMentionSurface(entry);
    if (!normalized) {
      continue;
    }
    const dedupeKey = normalized.toLocaleLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    mentions.push(normalized);
    if (mentions.length >= maxItems) {
      break;
    }
  }
  return mentions;
}
