import { normalizePointerKey } from "./contracts/pointer-key.js";

const ENTITY_MENTION_SPECIAL_VALUES = new Set([
  "self",
  "user",
  "current_location",
]);

const DEFAULT_MAX_ENTITY_MENTIONS = 12;
const MAX_ENTITY_MENTION_LENGTH = 80;

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
  return normalized.slice(0, MAX_ENTITY_MENTION_LENGTH);
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
