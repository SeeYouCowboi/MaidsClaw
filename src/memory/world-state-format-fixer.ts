import type postgres from "postgres";
import type { ChatToolDefinition, MemoryTaskModelProvider } from "./task-agent.js";
import type { WorldStatePointerKeyFormatFixer } from "./world-state-ops-applier.js";

/**
 * Lazy LLM-based pointer_key canonicalizer for worldStateOps. Wraps a
 * lightweight model call (default: minimax/MiniMax-M2.7-highspeed) that maps
 * an unknown raw pointer_key — typically a malformed or partial form like
 * "金表" instead of "item:金怀表", or "管家" instead of "char:管家" — back to
 * a canonical pointer_key from the entity_nodes catalog.
 *
 * Designed for the lazy fallback path: the applier only invokes the fixer
 * when the direct lookup AND the alias-table fallback have both returned
 * null. With a clean catalog and well-aligned prompt, the happy path stays
 * at 0 LLM calls; on a 150-turn rp:mei run the worst case observed pre-fix
 * was 4 unresolved ops, so a per-op call ceiling of ~4 is acceptable.
 */
const FIX_TOOL: ChatToolDefinition = {
  name: "fix_pointer_key",
  description:
    "Map an unknown raw pointer_key to a canonical pointer_key from the catalog. Return null if no candidate is a confident match.",
  inputSchema: {
    type: "object",
    properties: {
      canonical_pointer_key: {
        type: "string",
        description:
          "EXACT pointer_key string copied verbatim from the catalog (including the typed prefix like 'char:' / 'item:' / 'loc:'). Use the literal string 'null' (not the JSON null) if no candidate is a confident match.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "0.0 = pure guess, 1.0 = the catalog clearly contains this exact entity under a different surface/prefix.",
      },
      reason: {
        type: "string",
      },
    },
    required: ["canonical_pointer_key"],
  },
};

const DEFAULT_MODEL_ID = "minimax/MiniMax-M2.7-highspeed";
const CANDIDATE_LIMIT = 12;
const MIN_CONFIDENCE = 0.55;

/** Per-process LRU cache: collapses repeated misses for the same key into a
 *  single LLM call across a long session. Keyed by `${agentId}::${key}`. */
const fixerCache = new Map<string, string | null>();
const FIXER_CACHE_MAX = 512;

function cacheGet(agentId: string, key: string): string | null | undefined {
  return fixerCache.get(`${agentId}::${key}`);
}

function cacheSet(agentId: string, key: string, value: string | null): void {
  if (fixerCache.size >= FIXER_CACHE_MAX) {
    // Drop oldest entry — Map preserves insertion order.
    const first = fixerCache.keys().next();
    if (!first.done) fixerCache.delete(first.value);
  }
  fixerCache.set(`${agentId}::${key}`, value);
}

type CandidateRow = {
  pointer_key: string;
  display_name: string;
  entity_type: string;
  summary: string | null;
  lexical_score: number;
};

async function readCandidates(
  sql: postgres.Sql,
  unknownKey: string,
  agentId: string,
): Promise<CandidateRow[]> {
  // Trigram-based shortlist over both pointer_key and display_name. The
  // unknown key may be either prefix-stripped ("金表") or a partial of the
  // canonical form, so we score against display_name as well to surface
  // entities whose canonical pointer_key looks nothing like the surface.
  const rows = await sql<{
    pointer_key: string;
    display_name: string;
    entity_type: string;
    summary: string | null;
    lexical_score: number | string;
  }[]>`
    SELECT
      pointer_key,
      display_name,
      entity_type,
      summary,
      GREATEST(
        similarity(pointer_key, ${unknownKey}),
        similarity(display_name, ${unknownKey})
      ) AS lexical_score
    FROM entity_nodes
    WHERE
      memory_scope = 'shared_public'
      OR (memory_scope = 'private_overlay' AND owner_agent_id = ${agentId})
    ORDER BY lexical_score DESC, updated_at DESC, id DESC
    LIMIT ${CANDIDATE_LIMIT}
  `;
  return rows.map((row) => ({
    pointer_key: row.pointer_key,
    display_name: row.display_name,
    entity_type: row.entity_type,
    summary: row.summary,
    lexical_score: Number(row.lexical_score),
  }));
}

function buildPrompt(params: {
  unknownPointerKey: string;
  factText: string;
  predicate: string;
  endpoint: "subject" | "object";
  candidates: CandidateRow[];
}): { role: "system" | "user"; content: string }[] {
  const { unknownPointerKey, factText, predicate, endpoint, candidates } = params;
  const lines: string[] = [];
  lines.push(`Unknown pointer_key (used as ${endpoint} of a fact_edge):`);
  lines.push(`  "${unknownPointerKey}"`);
  lines.push("");
  lines.push(`Predicate: ${predicate}`);
  if (factText.trim().length > 0) {
    lines.push(`Fact text: ${factText.trim()}`);
  }
  lines.push("");
  lines.push("Catalog (canonical entries):");
  if (candidates.length === 0) {
    lines.push("  (empty — no shortlist available)");
  } else {
    candidates.forEach((c, i) => {
      const summary = c.summary ? ` — ${c.summary}` : "";
      lines.push(
        `  [${i + 1}] ${c.pointer_key}  (${c.display_name}, ${c.entity_type})${summary}`,
      );
    });
  }
  lines.push("");
  lines.push(
    "Decide if the unknown pointer_key refers to ONE of the catalog entries above.",
  );
  lines.push(
    "If yes, return that entry's EXACT pointer_key (verbatim, including 'char:' / 'item:' / 'loc:' prefix).",
  );
  lines.push(
    "If no candidate is a confident match, return the literal string 'null'.",
  );

  return [
    {
      role: "system",
      content:
        "You canonicalize world-state pointer_keys for a memory graph. The model that emitted the unknown key sometimes drops typed prefixes ('管家' instead of 'char:管家'), uses partial names ('金表' instead of 'item:金怀表'), or invents prefixes ('self:rp:mei'). Your job is to match the surface form back to a catalog entry. Be strict — only match when the entity is clearly the same.",
    },
    { role: "user", content: lines.join("\n") },
  ];
}

export type CreateWorldStateFormatFixerOptions = {
  /** Override the LLM model id. Defaults to MiniMax-M2.7-highspeed. */
  modelId?: string;
  /** Override the minimum confidence threshold. Defaults to 0.55. */
  minConfidence?: number;
};

/**
 * Build a {@link WorldStatePointerKeyFormatFixer} bound to a sql pool and
 * model provider. Returns undefined when prerequisites are missing so the
 * applier silently skips this fallback rather than crashing.
 */
export function createWorldStateFormatFixer(
  pgFactory: { getPool(): postgres.Sql } | null | undefined,
  modelProvider:
    | Pick<MemoryTaskModelProvider, "chat">
    | null
    | undefined,
  options: CreateWorldStateFormatFixerOptions = {},
): WorldStatePointerKeyFormatFixer | undefined {
  if (!pgFactory || !modelProvider) {
    return undefined;
  }
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const minConfidence = options.minConfidence ?? MIN_CONFIDENCE;

  return async ({
    unknownPointerKey,
    agentId,
    factText,
    predicate,
    endpoint,
  }) => {
    const cached = cacheGet(agentId, unknownPointerKey);
    if (cached !== undefined) {
      return cached;
    }

    let candidates: CandidateRow[];
    try {
      candidates = await readCandidates(
        pgFactory.getPool(),
        unknownPointerKey,
        agentId,
      );
    } catch (err) {
      console.warn(
        `[world-state-fixer] candidate lookup failed for "${unknownPointerKey}": ${err instanceof Error ? err.message : String(err)}`,
      );
      cacheSet(agentId, unknownPointerKey, null);
      return null;
    }

    if (candidates.length === 0) {
      cacheSet(agentId, unknownPointerKey, null);
      return null;
    }

    const messages = buildPrompt({
      unknownPointerKey,
      factText,
      predicate,
      endpoint,
      candidates,
    });

    let calls;
    try {
      calls = await modelProvider.chat(messages, [FIX_TOOL], { modelId });
    } catch (err) {
      console.warn(
        `[world-state-fixer] LLM call failed for "${unknownPointerKey}": ${err instanceof Error ? err.message : String(err)}`,
      );
      cacheSet(agentId, unknownPointerKey, null);
      return null;
    }

    for (const call of calls) {
      if (call.name !== FIX_TOOL.name) continue;
      const raw = call.arguments.canonical_pointer_key;
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (trimmed.length === 0 || trimmed.toLowerCase() === "null") {
        cacheSet(agentId, unknownPointerKey, null);
        return null;
      }
      const confidenceRaw = call.arguments.confidence;
      const confidence =
        typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
          ? confidenceRaw
          : 1.0;
      if (confidence < minConfidence) {
        cacheSet(agentId, unknownPointerKey, null);
        return null;
      }
      // Trust only candidates from the shortlist — ignore hallucinated keys.
      const inCatalog = candidates.some((c) => c.pointer_key === trimmed);
      if (!inCatalog) {
        cacheSet(agentId, unknownPointerKey, null);
        return null;
      }
      cacheSet(agentId, unknownPointerKey, trimmed);
      return trimmed;
    }

    cacheSet(agentId, unknownPointerKey, null);
    return null;
  };
}

/** Test-only: clear the in-process cache. */
export function _resetWorldStateFormatFixerCache(): void {
  fixerCache.clear();
}
