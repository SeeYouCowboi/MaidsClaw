import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ActionFamily = "move" | "possession" | "status_change";

export type ActionLexiconFamily = {
  en: {
    lemmas: string[];
    inflections: Record<string, string[]>;
  };
  cn: {
    tokens: string[];
  };
};

export type ActionLexicon = {
  schemaVersion: number;
  generatedAt?: string;
  sourceDigests?: Record<string, string>;
  families: Record<ActionFamily, ActionLexiconFamily>;
};

const HARDCODED_FALLBACK: ActionLexicon = {
  schemaVersion: 1,
  generatedAt: "2026-04-21T00:00:00.000Z",
  sourceDigests: { fallback: "inline-hardcoded" },
  families: {
    move: {
      en: {
        lemmas: ["go", "walk", "move", "return", "enter", "leave"],
        inflections: {
          go: ["goes", "went", "gone", "going"],
          walk: ["walks", "walked", "walking"],
          move: ["moves", "moved", "moving"],
          return: ["returns", "returned", "returning"],
          enter: ["enters", "entered", "entering"],
          leave: ["leaves", "left", "leaving"],
        },
      },
      cn: { tokens: ["去", "来到", "回到", "走到", "进入", "离开"] },
    },
    possession: {
      en: {
        lemmas: ["take", "pick up", "hold", "show", "hand", "put"],
        inflections: {
          take: ["takes", "took", "taken", "taking"],
          "pick up": ["picks up", "picked up", "picking up"],
          hold: ["holds", "held", "holding"],
          show: ["shows", "showed", "shown", "showing"],
          hand: ["hands", "handed", "handing"],
          put: ["puts", "putting"],
        },
      },
      cn: { tokens: ["拿起", "拿出", "展示", "递给", "交给", "放下"] },
    },
    status_change: {
      en: {
        lemmas: ["open", "close", "lock", "unlock", "light", "extinguish"],
        inflections: {
          open: ["opens", "opened", "opening"],
          close: ["closes", "closed", "closing"],
          lock: ["locks", "locked", "locking"],
          unlock: ["unlocks", "unlocked", "unlocking"],
          light: ["lights", "lit", "lighted", "lighting"],
          extinguish: ["extinguishes", "extinguished", "extinguishing"],
        },
      },
      cn: { tokens: ["打开", "关上", "锁上", "解锁", "点亮", "熄灭"] },
    },
  },
};

function resolveLexiconPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "data", "lexicon", "action-lexicon.json");
}

function isValidLexicon(value: unknown): value is ActionLexicon {
  if (!value || typeof value !== "object") return false;
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 1) return false;
  const families = root.families as Record<string, unknown> | undefined;
  if (!families) return false;
  for (const family of ["move", "possession", "status_change"] as const) {
    const entry = families[family] as
      | { en?: { lemmas?: unknown; inflections?: unknown }; cn?: { tokens?: unknown } }
      | undefined;
    if (
      !entry ||
      !Array.isArray(entry.en?.lemmas) ||
      typeof entry.en?.inflections !== "object" ||
      entry.en.inflections === null ||
      !Array.isArray(entry.cn?.tokens)
    ) {
      return false;
    }
  }
  return true;
}

function loadActionLexicon(): ActionLexicon {
  if (process.env.MAIDSCLAW_EXPANDED_LEXICON === "off") {
    return HARDCODED_FALLBACK;
  }
  try {
    const raw = readFileSync(resolveLexiconPath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidLexicon(parsed)) {
      console.warn("[action-lexicon] lexicon_load_failed", {
        reason: "schema_mismatch",
      });
      return HARDCODED_FALLBACK;
    }
    return parsed;
  } catch (error) {
    console.warn("[action-lexicon] lexicon_load_failed", {
      reason: (error as Error).message,
    });
    return HARDCODED_FALLBACK;
  }
}

export const ACTION_LEXICON: ActionLexicon = loadActionLexicon();

type SynonymIndexEntry = {
  family: ActionFamily;
  members: ReadonlyArray<string>;
};

function buildSynonymIndex(
  lexicon: ActionLexicon,
): Map<string, SynonymIndexEntry> {
  const index = new Map<string, SynonymIndexEntry>();
  for (const [family, group] of Object.entries(lexicon.families) as Array<
    [ActionFamily, ActionLexiconFamily]
  >) {
    const members: string[] = [];
    for (const lemma of group.en.lemmas) {
      members.push(lemma);
      const inflections = group.en.inflections[lemma] ?? [];
      members.push(...inflections);
    }
    members.push(...group.cn.tokens);
    const dedupedMembers = Array.from(new Set(members));
    const entry: SynonymIndexEntry = { family, members: dedupedMembers };
    for (const surface of dedupedMembers) {
      // Earliest hit wins; lemmas appear before inflections so a lemma
      // surface always maps to its own family even if shared with another
      // (none currently overlap, but the contract is explicit).
      if (!index.has(surface.toLowerCase())) {
        index.set(surface.toLowerCase(), entry);
      }
    }
  }
  return index;
}

const SYNONYM_INDEX: Map<string, SynonymIndexEntry> = buildSynonymIndex(
  ACTION_LEXICON,
);

/**
 * Returns the family-sibling surfaces of a single token (lemma, inflection,
 * or Chinese token), excluding the token itself. Returns an empty array
 * when the token does not belong to any known family.
 *
 * The match is case-insensitive on the input but preserves the lexicon's
 * canonical surfaces in the output.
 */
export function expandSynonyms(token: string): string[] {
  if (!token) return [];
  const entry = SYNONYM_INDEX.get(token.toLowerCase());
  if (!entry) return [];
  const lower = token.toLowerCase();
  return entry.members.filter((m) => m.toLowerCase() !== lower);
}

/**
 * Returns the deduplicated set of family-sibling surfaces across all
 * tokens in a query. Tokens that don't match any family contribute
 * nothing. Useful for query-time synonym injection so a search for
 * "去" can also match documents containing "走到" / "来到".
 */
export function expandQuerySynonyms(tokens: ReadonlyArray<string>): string[] {
  const expanded = new Set<string>();
  const lowered = new Set(tokens.map((t) => t.toLowerCase()));
  for (const token of tokens) {
    for (const synonym of expandSynonyms(token)) {
      if (!lowered.has(synonym.toLowerCase())) {
        expanded.add(synonym);
      }
    }
  }
  return [...expanded];
}
