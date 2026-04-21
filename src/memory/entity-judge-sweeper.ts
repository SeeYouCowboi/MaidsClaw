import type postgres from "postgres";
import type { AliasRepo } from "../storage/domain-repos/contracts/alias-repo.js";
import type {
  ChatMessage,
  ChatToolDefinition,
  MemoryTaskModelProvider,
  ToolCallResult,
} from "./task-agent.js";

export type PgFactoryLike = {
  getPool(): postgres.Sql;
  isInitialized?: () => boolean;
};

export type EntityJudgeSweepOptions = {
  modelId?: string;
  agentId: string;
  sessionId?: string;
  dryRun?: boolean;
  maxCandidatesPerKey?: number;
  since?: number;
  scope?: "shared_public" | "private_overlay";
};

export type EntityJudgeDecision = {
  pointer_key: string;
  decision: "match" | "new";
  canonical_id?: number;
  canonical_pointer_key?: string;
  created_entity_id?: number;
  confidence?: number;
  rationale?: string;
};

export type EntityJudgeReport = {
  scanned_at: number;
  duration_ms: number;
  model_id: string;
  agent_id: string;
  session_id?: string;
  dry_run: boolean;
  scope: "shared_public" | "private_overlay";
  since?: number;
  max_candidates_per_key: number;
  candidate_keys: number;
  judged: number;
  matched: number;
  created: number;
  skipped_due_lock: boolean;
  decisions: EntityJudgeDecision[];
};

type CandidateEntity = {
  id: number;
  pointer_key: string;
  display_name: string;
  summary: string | null;
  lexical_score: number;
};

type ParsedJudgeResult = {
  decision: "match" | "new";
  selectedIndex?: number;
  confidence?: number;
  rationale?: string;
};

const JUDGE_TOOL: ChatToolDefinition = {
  name: "judge_entity_match",
  description:
    "Decide whether a candidate pointer_key refers to one listed entity or should be created as a new entity.",
  inputSchema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["match", "new"],
      },
      selectedIndex: {
        type: "integer",
        minimum: 1,
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
      rationale: {
        type: "string",
      },
    },
    required: ["decision"],
  },
};

const DEFAULT_MAX_CANDIDATES_PER_KEY = 10;
const DEFAULT_JUDGE_MODEL_ID = "minimax/MiniMax-M2.7";

function normalizePointer(value: string): string {
  return value.normalize("NFC").trim();
}

function isIgnorablePointerKey(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (value === "user" || value === "current_location") {
    return true;
  }
  if (value.startsWith("self:")) {
    return true;
  }
  return false;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function collectPointerKeysFromUnknown(
  node: unknown,
  out: Set<string>,
  depth = 0,
): void {
  if (depth > 20 || node == null) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectPointerKeysFromUnknown(item, out, depth + 1);
    }
    return;
  }
  if (typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.kind === "pointer_key" && typeof record.value === "string") {
    const normalized = normalizePointer(record.value);
    if (normalized.length > 0) {
      out.add(normalized);
    }
  }
  for (const value of Object.values(record)) {
    collectPointerKeysFromUnknown(value, out, depth + 1);
  }
}

function extractPointerKeysFromRecordJson(recordJson: unknown): string[] {
  let parsed: unknown = recordJson;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  const keys = new Set<string>();
  collectPointerKeysFromUnknown(parsed, keys);
  return [...keys];
}

function parseJudgeCall(
  calls: ToolCallResult[],
  candidateCount: number,
): ParsedJudgeResult {
  for (const call of calls) {
    if (call.name !== JUDGE_TOOL.name) {
      continue;
    }
    const rawDecision = call.arguments.decision;
    const decision =
      rawDecision === "match" || rawDecision === "new"
        ? rawDecision
        : undefined;
    if (!decision) {
      continue;
    }
    const selectedIndexRaw = call.arguments.selectedIndex;
    const selectedIndex =
      typeof selectedIndexRaw === "number" &&
      Number.isInteger(selectedIndexRaw) &&
      selectedIndexRaw >= 1 &&
      selectedIndexRaw <= candidateCount
        ? selectedIndexRaw
        : undefined;
    const confidence = asFiniteNumber(call.arguments.confidence);
    const rationale = asString(call.arguments.rationale);
    return {
      decision,
      selectedIndex,
      confidence,
      rationale,
    };
  }

  return { decision: "new" };
}

function buildJudgeMessages(params: {
  pointerKey: string;
  contextSummary: string | null;
  candidates: CandidateEntity[];
}): ChatMessage[] {
  const lines: string[] = [];
  lines.push(
    `Candidate pointer_key: "${params.pointerKey}"`,
  );
  if (params.contextSummary) {
    lines.push(`Recent context: "${params.contextSummary}"`);
  }
  lines.push("");
  lines.push("Known entities:");
  params.candidates.forEach((candidate, index) => {
    const summary = candidate.summary ? ` — ${candidate.summary}` : "";
    lines.push(
      `[${index + 1}] ${candidate.pointer_key} (${candidate.display_name})${summary}`,
    );
  });
  lines.push("");
  lines.push(
    "Reply via tool: decision='match' with selectedIndex, or decision='new' when none match.",
  );

  return [
    {
      role: "system",
      content:
        "You judge entity reference canonicalization. Choose exactly one existing entity index when it matches, otherwise choose new.",
    },
    {
      role: "user",
      content: lines.join("\n"),
    },
  ];
}

async function createRuntimeEntity(params: {
  sql: postgres.Sql;
  pointerKey: string;
  agentId: string;
  scope: "shared_public" | "private_overlay";
  summary: string | null;
}): Promise<number | null> {
  const now = Date.now();
  const pointerKey = normalizePointer(params.pointerKey);
  const displayName = pointerKey;
  const summary = params.summary?.trim().slice(0, 240) ?? null;

  if (params.scope === "private_overlay") {
    const rows = await params.sql<{ id: number | string }[]>`
      INSERT INTO entity_nodes (
        pointer_key, display_name, entity_type, memory_scope, owner_agent_id, summary, created_at, updated_at
      )
      VALUES (
        ${pointerKey},
        ${displayName},
        ${"entity"},
        ${"private_overlay"},
        ${params.agentId},
        ${summary},
        ${now},
        ${now}
      )
      ON CONFLICT (owner_agent_id, pointer_key)
      WHERE memory_scope = 'private_overlay'
      DO UPDATE SET
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `;
    if (rows.length === 0) {
      return null;
    }
    return Number(rows[0].id);
  }

  const rows = await params.sql<{ id: number | string }[]>`
    INSERT INTO entity_nodes (
      pointer_key, display_name, entity_type, memory_scope, owner_agent_id, summary, created_at, updated_at
    )
    VALUES (
      ${pointerKey},
      ${displayName},
      ${"entity"},
      ${"shared_public"},
      ${null},
      ${summary},
      ${now},
      ${now}
    )
    ON CONFLICT (pointer_key)
    WHERE memory_scope = 'shared_public'
    DO UPDATE SET
      updated_at = EXCLUDED.updated_at
    RETURNING id
  `;
  if (rows.length === 0) {
    return null;
  }
  return Number(rows[0].id);
}

export class EntityJudgeSweeper {
  private readonly activeLocks = new Set<string>();
  private readonly sinceCursor = new Map<string, number>();

  constructor(
    private readonly pgFactory: PgFactoryLike,
    private readonly modelProvider: Pick<MemoryTaskModelProvider, "chat">,
    private readonly aliasRepo: Pick<
      AliasRepo,
      "createAlias" | "findEntityById"
    >,
  ) {}

  async runSweep(opts: EntityJudgeSweepOptions): Promise<EntityJudgeReport> {
    const startedAt = Date.now();
    const dryRun = opts.dryRun ?? true;
    const scope = opts.scope ?? "private_overlay";
    const modelId = opts.modelId ?? DEFAULT_JUDGE_MODEL_ID;
    const maxCandidatesPerKey = Math.max(
      1,
      Math.min(opts.maxCandidatesPerKey ?? DEFAULT_MAX_CANDIDATES_PER_KEY, 30),
    );
    const lockKey = `${opts.agentId}:${opts.sessionId ?? "_all_"}`;

    if (this.activeLocks.has(lockKey)) {
      return {
        scanned_at: startedAt,
        duration_ms: Date.now() - startedAt,
        model_id: modelId,
        agent_id: opts.agentId,
        ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
        dry_run: dryRun,
        scope,
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        max_candidates_per_key: maxCandidatesPerKey,
        candidate_keys: 0,
        judged: 0,
        matched: 0,
        created: 0,
        skipped_due_lock: true,
        decisions: [],
      };
    }

    this.activeLocks.add(lockKey);
    try {
      const sql = this.pgFactory.getPool();
      const effectiveSince = opts.since ?? this.sinceCursor.get(lockKey);

      const discoveredPointerKeys = await this.collectCandidatePointerKeys({
        sql,
        agentId: opts.agentId,
        sessionId: opts.sessionId,
        since: effectiveSince,
      });

      const allCandidateKeys = [
        ...new Set(
          discoveredPointerKeys
            .map((key) => normalizePointer(key))
            .filter((key) => !isIgnorablePointerKey(key)),
        ),
      ];

      const unresolvedKeys = await this.filterExistingPointerKeys({
        sql,
        agentId: opts.agentId,
        pointerKeys: allCandidateKeys,
      });

      const decisions: EntityJudgeDecision[] = [];
      let matched = 0;
      let created = 0;

      for (const pointerKey of unresolvedKeys) {
        const contextSummary = await this.readRecentContextSummary({
          sql,
          agentId: opts.agentId,
          sessionId: opts.sessionId,
          pointerKey,
        });
        const candidates = await this.readCandidateEntities({
          sql,
          agentId: opts.agentId,
          pointerKey,
          maxCandidatesPerKey,
        });

        if (candidates.length === 0) {
          let createdEntityId: number | null = null;
          if (!dryRun) {
            createdEntityId = await createRuntimeEntity({
              sql,
              pointerKey,
              agentId: opts.agentId,
              scope,
              summary: contextSummary,
            });
          }
          if (createdEntityId != null) {
            created += 1;
          }
          decisions.push({
            pointer_key: pointerKey,
            decision: "new",
            ...(createdEntityId != null
              ? { created_entity_id: createdEntityId }
              : {}),
            rationale: "no candidate entities available",
          });
          continue;
        }

        const calls = await this.modelProvider.chat(
          buildJudgeMessages({
            pointerKey,
            contextSummary,
            candidates,
          }),
          [JUDGE_TOOL],
          { modelId },
        );
        const parsed = parseJudgeCall(calls, candidates.length);

        if (parsed.decision === "match" && parsed.selectedIndex) {
          const selected = candidates[parsed.selectedIndex - 1];
          const aliasOwnerAgentId =
            scope === "private_overlay" ? opts.agentId : undefined;
          if (!dryRun) {
            await this.aliasRepo.createAlias(
              selected.id,
              pointerKey,
              "llm_judged",
              aliasOwnerAgentId,
            );
          }
          matched += 1;
          decisions.push({
            pointer_key: pointerKey,
            decision: "match",
            canonical_id: selected.id,
            canonical_pointer_key: selected.pointer_key,
            ...(parsed.confidence !== undefined
              ? { confidence: parsed.confidence }
              : {}),
            ...(parsed.rationale ? { rationale: parsed.rationale } : {}),
          });
          continue;
        }

        let createdEntityId: number | null = null;
        if (!dryRun) {
          createdEntityId = await createRuntimeEntity({
            sql,
            pointerKey,
            agentId: opts.agentId,
            scope,
            summary: contextSummary,
          });
        }
        if (createdEntityId != null) {
          created += 1;
        }
        decisions.push({
          pointer_key: pointerKey,
          decision: "new",
          ...(createdEntityId != null
            ? { created_entity_id: createdEntityId }
            : {}),
          ...(parsed.confidence !== undefined
            ? { confidence: parsed.confidence }
            : {}),
          ...(parsed.rationale ? { rationale: parsed.rationale } : {}),
        });
      }

      this.sinceCursor.set(lockKey, Date.now());

      return {
        scanned_at: startedAt,
        duration_ms: Date.now() - startedAt,
        model_id: modelId,
        agent_id: opts.agentId,
        ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
        dry_run: dryRun,
        scope,
        ...(effectiveSince !== undefined ? { since: effectiveSince } : {}),
        max_candidates_per_key: maxCandidatesPerKey,
        candidate_keys: unresolvedKeys.length,
        judged: decisions.length,
        matched,
        created,
        skipped_due_lock: false,
        decisions,
      };
    } finally {
      this.activeLocks.delete(lockKey);
    }
  }

  private async collectCandidatePointerKeys(params: {
    sql: postgres.Sql;
    agentId: string;
    sessionId?: string;
    since?: number;
  }): Promise<string[]> {
    const { sql, agentId, sessionId, since } = params;
    const keys: string[] = [];

    const episodeRows =
      sessionId && since !== undefined
        ? await sql<{ key: string }[]>`
            SELECT DISTINCT unnest(entity_pointer_keys) AS key
            FROM private_episode_events
            WHERE agent_id = ${agentId}
              AND session_id = ${sessionId}
              AND created_at >= ${since}
          `
        : sessionId
          ? await sql<{ key: string }[]>`
              SELECT DISTINCT unnest(entity_pointer_keys) AS key
              FROM private_episode_events
              WHERE agent_id = ${agentId}
                AND session_id = ${sessionId}
            `
          : since !== undefined
            ? await sql<{ key: string }[]>`
                SELECT DISTINCT unnest(entity_pointer_keys) AS key
                FROM private_episode_events
                WHERE agent_id = ${agentId}
                  AND created_at >= ${since}
              `
            : await sql<{ key: string }[]>`
                SELECT DISTINCT unnest(entity_pointer_keys) AS key
                FROM private_episode_events
                WHERE agent_id = ${agentId}
              `;
    keys.push(
      ...episodeRows
        .map((row) => row.key)
        .filter((value): value is string => typeof value === "string"),
    );

    const cognitionRows = await this.readCognitionCurrentRecords({
      sql,
      agentId,
      sessionId,
      since,
    });
    for (const row of cognitionRows) {
      keys.push(...extractPointerKeysFromRecordJson(row.record_json));
    }

    return keys;
  }

  private async readCognitionCurrentRecords(params: {
    sql: postgres.Sql;
    agentId: string;
    sessionId?: string;
    since?: number;
  }): Promise<Array<{ record_json: unknown }>> {
    const { sql, agentId, sessionId, since } = params;
    if (sessionId && since !== undefined) {
      return sql<{ record_json: unknown }[]>`
        SELECT c.record_json
        FROM private_cognition_current c
        WHERE c.agent_id = ${agentId}
          AND c.updated_at >= ${since}
          AND EXISTS (
            SELECT 1
            FROM private_cognition_events e
            JOIN private_episode_events pe
              ON pe.settlement_id = e.settlement_id
             AND pe.agent_id = e.agent_id
            WHERE e.id = c.source_event_id
              AND pe.session_id = ${sessionId}
            LIMIT 1
          )
      `;
    }
    if (sessionId) {
      return sql<{ record_json: unknown }[]>`
        SELECT c.record_json
        FROM private_cognition_current c
        WHERE c.agent_id = ${agentId}
          AND EXISTS (
            SELECT 1
            FROM private_cognition_events e
            JOIN private_episode_events pe
              ON pe.settlement_id = e.settlement_id
             AND pe.agent_id = e.agent_id
            WHERE e.id = c.source_event_id
              AND pe.session_id = ${sessionId}
            LIMIT 1
          )
      `;
    }
    if (since !== undefined) {
      return sql<{ record_json: unknown }[]>`
        SELECT record_json
        FROM private_cognition_current
        WHERE agent_id = ${agentId}
          AND updated_at >= ${since}
      `;
    }
    return sql<{ record_json: unknown }[]>`
      SELECT record_json
      FROM private_cognition_current
      WHERE agent_id = ${agentId}
    `;
  }

  private async filterExistingPointerKeys(params: {
    sql: postgres.Sql;
    agentId: string;
    pointerKeys: string[];
  }): Promise<string[]> {
    const { sql, agentId, pointerKeys } = params;
    if (pointerKeys.length === 0) {
      return [];
    }
    const rows = await sql<{ pointer_key: string }[]>`
      SELECT pointer_key
      FROM entity_nodes
      WHERE pointer_key = ANY(${pointerKeys})
        AND (
          memory_scope = 'shared_public'
          OR (memory_scope = 'private_overlay' AND owner_agent_id = ${agentId})
        )
    `;
    const existing = new Set(rows.map((row) => row.pointer_key));
    return pointerKeys.filter((key) => !existing.has(key));
  }

  private async readRecentContextSummary(params: {
    sql: postgres.Sql;
    agentId: string;
    sessionId?: string;
    pointerKey: string;
  }): Promise<string | null> {
    const { sql, agentId, sessionId, pointerKey } = params;
    const queryRows = sessionId
      ? await sql<{ summary: string | null }[]>`
          SELECT summary
          FROM private_episode_events
          WHERE agent_id = ${agentId}
            AND session_id = ${sessionId}
            AND entity_pointer_keys @> ARRAY[${pointerKey}]::text[]
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `
      : await sql<{ summary: string | null }[]>`
          SELECT summary
          FROM private_episode_events
          WHERE agent_id = ${agentId}
            AND entity_pointer_keys @> ARRAY[${pointerKey}]::text[]
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `;
    if (queryRows.length === 0) {
      return null;
    }
    const summary = queryRows[0].summary?.trim();
    return summary && summary.length > 0 ? summary : null;
  }

  private async readCandidateEntities(params: {
    sql: postgres.Sql;
    agentId: string;
    pointerKey: string;
    maxCandidatesPerKey: number;
  }): Promise<CandidateEntity[]> {
    const { sql, agentId, pointerKey, maxCandidatesPerKey } = params;
    const rows = await sql<{
      id: number | string;
      pointer_key: string;
      display_name: string;
      summary: string | null;
      lexical_score: number | string;
    }[]>`
      SELECT
        id,
        pointer_key,
        display_name,
        summary,
        GREATEST(
          similarity(pointer_key, ${pointerKey}),
          similarity(display_name, ${pointerKey})
        ) AS lexical_score
      FROM entity_nodes
      WHERE
        (
          memory_scope = 'shared_public'
          OR (memory_scope = 'private_overlay' AND owner_agent_id = ${agentId})
        )
      ORDER BY lexical_score DESC, updated_at DESC, id DESC
      LIMIT ${maxCandidatesPerKey}
    `;
    return rows.map((row) => ({
      id: Number(row.id),
      pointer_key: row.pointer_key,
      display_name: row.display_name,
      summary: row.summary,
      lexical_score: Number(row.lexical_score),
    }));
  }
}
