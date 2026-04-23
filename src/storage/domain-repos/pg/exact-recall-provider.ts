import type postgres from "postgres";

export type ExactRecallReason =
  | "alias_exact"
  | "pointer_key_exact"
  | "entity_pointer_key";

export type ExactRecallSurface =
  | "episode"
  | "cognition"
  | "area"
  | "world"
  | "private";

export interface ExactRecallCandidate {
  sourceRef: string;
  surface: ExactRecallSurface;
  scoreHint: number;
  reason: ExactRecallReason;
  canonicalEntityId?: number;
  pointerKey?: string;
}

export interface ExactRecallViewer {
  agentId: string;
}

export interface ExactRecallProvider {
  recallExact(
    surfaces: string[],
    viewer: ExactRecallViewer,
    limit: number,
  ): Promise<ExactRecallCandidate[]>;
}

const ALIAS_EXACT_SCORE = 3.0;
const POINTER_EXACT_SCORE = 2.5;
const ENTITY_POINTER_KEY_EPISODE_SCORE = 2.5;
const ENTITY_POINTER_KEY_PRIVATE_SCORE = 2.5;

function normalize(raw: string): string {
  return raw.normalize("NFKC").trim();
}

function dedupeCandidates(candidates: ExactRecallCandidate[]): ExactRecallCandidate[] {
  const seen = new Map<string, ExactRecallCandidate>();
  for (const c of candidates) {
    const key = `${c.reason}|${c.sourceRef}|${c.pointerKey ?? ""}|${c.canonicalEntityId ?? ""}`;
    const prev = seen.get(key);
    if (!prev || c.scoreHint > prev.scoreHint) {
      seen.set(key, c);
    }
  }
  return Array.from(seen.values());
}

export class PgExactRecallProvider implements ExactRecallProvider {
  constructor(private readonly sql: postgres.Sql) {}

  async recallExact(
    surfaces: string[],
    viewer: ExactRecallViewer,
    limit: number,
  ): Promise<ExactRecallCandidate[]> {
    const { agentId } = viewer;
    const normalized = Array.from(
      new Set(
        surfaces
          .map(normalize)
          .filter((s): s is string => s.length > 0),
      ),
    );
    if (normalized.length === 0 || limit <= 0) {
      return [];
    }

    const pointerKeysFromAliases = new Set<string>();
    const canonicalIdsFromAliases = new Set<number>();
    const candidates: ExactRecallCandidate[] = [];

    const aliasRows = await this.sql<{
      canonical_id: number;
      alias: string;
      owner_agent_id: string | null;
      pointer_key: string | null;
    }[]>`
      SELECT ea.canonical_id,
             ea.alias,
             ea.owner_agent_id,
             en.pointer_key
      FROM entity_aliases ea
      LEFT JOIN entity_nodes en
        ON en.id = ea.canonical_id
       AND (
            en.memory_scope = 'shared_public'
            OR (en.memory_scope = 'private_overlay' AND en.owner_agent_id = ${agentId})
       )
      WHERE LOWER(ea.alias) = ANY(${normalized.map((s) => s.toLowerCase())}::text[])
        AND (ea.owner_agent_id IS NULL OR ea.owner_agent_id = ${agentId})
    `;

    for (const row of aliasRows) {
      if (!row.pointer_key) {
        continue;
      }
      const canonicalId = Number(row.canonical_id);
      canonicalIdsFromAliases.add(canonicalId);
      pointerKeysFromAliases.add(row.pointer_key);
      candidates.push({
        sourceRef: `entity:${canonicalId}`,
        surface: "world",
        scoreHint: ALIAS_EXACT_SCORE,
        reason: "alias_exact",
        canonicalEntityId: canonicalId,
        pointerKey: row.pointer_key,
      });
    }

    const pointerRows = await this.sql<{
      id: number;
      pointer_key: string;
      memory_scope: string;
      owner_agent_id: string | null;
    }[]>`
      SELECT id, pointer_key, memory_scope, owner_agent_id
      FROM entity_nodes
      WHERE LOWER(pointer_key) = ANY(${normalized.map((s) => s.toLowerCase())}::text[])
        AND (
          memory_scope = 'shared_public'
          OR (memory_scope = 'private_overlay' AND owner_agent_id = ${agentId})
        )
    `;

    const allPointerKeys = new Set<string>(pointerKeysFromAliases);
    for (const row of pointerRows) {
      const canonicalId = Number(row.id);
      if (canonicalIdsFromAliases.has(canonicalId)) {
        allPointerKeys.add(row.pointer_key);
        continue;
      }
      allPointerKeys.add(row.pointer_key);
      candidates.push({
        sourceRef: `entity:${canonicalId}`,
        surface: row.memory_scope === "private_overlay" ? "private" : "world",
        scoreHint: POINTER_EXACT_SCORE,
        reason: "pointer_key_exact",
        canonicalEntityId: canonicalId,
        pointerKey: row.pointer_key,
      });
    }

    if (allPointerKeys.size > 0) {
      const pointerKeyArray = Array.from(allPointerKeys);
      const episodeLimit = Math.max(0, limit);

      const episodeRows = await this.sql<{
        source_ref: string;
        agent_id: string;
        matched_keys: string[];
      }[]>`
        SELECT source_ref,
               agent_id,
               ARRAY(
                 SELECT UNNEST(entity_pointer_keys)
                 INTERSECT
                 SELECT UNNEST(${pointerKeyArray}::text[])
               ) AS matched_keys
        FROM search_docs_episode
        WHERE entity_pointer_keys && ${pointerKeyArray}::text[]
        LIMIT ${episodeLimit}
      `;

      for (const row of episodeRows) {
        const matched = row.matched_keys?.[0];
        candidates.push({
          sourceRef: row.source_ref,
          surface: "episode",
          scoreHint: ENTITY_POINTER_KEY_EPISODE_SCORE,
          reason: "entity_pointer_key",
          pointerKey: matched,
        });
      }

      const privateRows = await this.sql<{
        id: number;
        matched_keys: string[];
      }[]>`
        SELECT id,
               ARRAY(
                 SELECT UNNEST(entity_pointer_keys)
                 INTERSECT
                 SELECT UNNEST(${pointerKeyArray}::text[])
               ) AS matched_keys
        FROM private_episode_events
        WHERE agent_id = ${agentId}
          AND entity_pointer_keys && ${pointerKeyArray}::text[]
        LIMIT ${episodeLimit}
      `;

      for (const row of privateRows) {
        const matched = row.matched_keys?.[0];
        candidates.push({
          sourceRef: `private_episode:${Number(row.id)}`,
          surface: "private",
          scoreHint: ENTITY_POINTER_KEY_PRIVATE_SCORE,
          reason: "entity_pointer_key",
          pointerKey: matched,
        });
      }
    }

    const deduped = dedupeCandidates(candidates);
    deduped.sort((a, b) => {
      if (b.scoreHint !== a.scoreHint) {
        return b.scoreHint - a.scoreHint;
      }
      if (a.sourceRef < b.sourceRef) return -1;
      if (a.sourceRef > b.sourceRef) return 1;
      return 0;
    });
    return deduped.slice(0, limit);
  }
}
