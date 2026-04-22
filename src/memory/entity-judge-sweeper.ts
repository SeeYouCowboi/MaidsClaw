import type postgres from "postgres";
import type { AliasRepo } from "../storage/domain-repos/contracts/alias-repo.js";
import type { EmbeddingRepo } from "../storage/domain-repos/contracts/embedding-repo.js";
import type {
  ChatMessage,
  ChatToolDefinition,
  MemoryTaskModelProvider,
  ToolCallResult,
} from "./task-agent.js";
import { makeNodeRef } from "./schema.js";
import {
  canonicalizeEntityMentionPointer,
  normalizeEntityMentionSurface,
  normalizeEntityMentions,
} from "./entity-mentions.js";

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

type CandidateEntityMention = {
  pointerKey: string;
  surfaceForms: string[];
};

type ParsedJudgeResult = {
  decision: "match" | "new";
  selectedIndex?: number;
  confidence?: number;
  rationale?: string;
  /** Entity-centric description for 'new' decisions — describes who/what the
   * entity IS, not the agent's state of knowing. Used as the entity summary
   * and as part of the embedding text. */
  entityDescription?: string;
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
      entity_description: {
        type: "string",
        description:
          "For decision='new' only. 1-2 short sentences describing who/what this entity IS based on the context evidence. Write from a neutral third-person perspective about the entity itself — NOT about the agent's state of knowing or confusion. Follow the conversation language (Chinese if context is Chinese). Example GOOD: 'Alice: 主人多次提及的人物；据主人所述曾在茶室与其交谈；身份待确认。' Example BAD: '我不记得这个人，主人反复提及但我没有印象。'",
      },
    },
    required: ["decision"],
  },
};

const DEFAULT_MAX_CANDIDATES_PER_KEY = 10;
const DEFAULT_JUDGE_MODEL_ID = "minimax/MiniMax-M2.7";

function normalizePointer(value: string): string {
  return canonicalizeEntityMentionPointer(value);
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

function appendCandidateMention(
  bucket: Map<string, Set<string>>,
  surface: string,
): void {
  const normalizedSurface = normalizeEntityMentionSurface(surface);
  if (!normalizedSurface) {
    return;
  }
  const pointerKey = normalizePointer(normalizedSurface);
  if (pointerKey.length === 0 || isIgnorablePointerKey(pointerKey)) {
    return;
  }
  const surfaceForms = bucket.get(pointerKey) ?? new Set<string>();
  surfaceForms.add(normalizedSurface);
  bucket.set(pointerKey, surfaceForms);
}

function pickPreferredDisplayName(
  pointerKey: string,
  surfaceForms: readonly string[],
): string {
  for (const surface of surfaceForms) {
    if (surface !== pointerKey) {
      return surface;
    }
  }
  return pointerKey;
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
    const entityDescription = asString(call.arguments.entity_description);
    return {
      decision,
      selectedIndex,
      confidence,
      rationale,
      entityDescription,
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
  lines.push(
    "When decision='new', ALSO provide entity_description: 1-2 short sentences describing who/what this entity IS based on the context evidence. Write from a neutral third-person perspective about the entity itself — NOT about the agent's state of knowing or confusion. Match the conversation language.",
  );

  return [
    {
      role: "system",
      content:
        "You judge entity reference canonicalization. Choose exactly one existing entity index when it matches, otherwise choose new and supply a neutral entity_description.",
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
  displayName?: string;
  agentId: string;
  scope: "shared_public" | "private_overlay";
  summary: string | null;
}): Promise<number | null> {
  const now = Date.now();
  const pointerKey = normalizePointer(params.pointerKey);
  const displayName =
    params.displayName?.normalize("NFC").trim().slice(0, 120) || pointerKey;
  const summary = params.summary?.trim().slice(0, 240) ?? null;
  const summaryProvided = summary !== null;

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
        display_name = CASE
          WHEN entity_nodes.display_name IS NULL OR entity_nodes.display_name = entity_nodes.pointer_key
            THEN EXCLUDED.display_name
          ELSE entity_nodes.display_name
        END,
        summary = CASE
          WHEN ${summaryProvided} AND (entity_nodes.summary IS NULL OR BTRIM(entity_nodes.summary) = '')
            THEN EXCLUDED.summary
          ELSE entity_nodes.summary
        END,
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
      display_name = CASE
        WHEN entity_nodes.display_name IS NULL OR entity_nodes.display_name = entity_nodes.pointer_key
          THEN EXCLUDED.display_name
        ELSE entity_nodes.display_name
      END,
      summary = CASE
        WHEN ${summaryProvided} AND (entity_nodes.summary IS NULL OR BTRIM(entity_nodes.summary) = '')
          THEN EXCLUDED.summary
        ELSE entity_nodes.summary
      END,
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
    private readonly modelProvider: Pick<
      MemoryTaskModelProvider,
      "chat" | "embed" | "defaultEmbeddingModelId"
    >,
    private readonly aliasRepo: Pick<
      AliasRepo,
      "createAlias" | "findEntityById"
    >,
    private readonly embeddingRepo?: EmbeddingRepo,
  ) {}

  /**
   * Embed a newly-created runtime entity so it becomes semantically searchable.
   * Runtime-created entities (via the entity judge "new" decision) previously
   * skipped embedding and the Talker's retrieval layer could not surface them
   * — the character would keep treating referenced names as unknown even after
   * the entity_nodes row existed. We now embed on creation.
   */
  /**
   * Retract any "knowledge gap"-style commitments/assertions about a
   * pointer_key once it has been resolved to a concrete entity. Without this
   * step, cognitions like `knowledge_gap/alice`, `intent/clarify_alice_identity`,
   * `alice/uncertain_existence` linger forever and keep pulling the agent
   * back toward denial of the entity's existence.
   *
   * Matches only uncertainty-flavored keys (gap/unknown/ambiguity/clarify/verify)
   * that ALSO reference the pointer_key substring, so factual assertions like
   * `butler/alice_connection` or `constraint/conceal_alice_from_butler` are
   * preserved.
   */
  private async retractIdentityGapCommitments(
    sql: postgres.Sql,
    agentId: string,
    pointerKey: string,
    entityId: number,
  ): Promise<void> {
    const lowerPK = pointerKey.toLowerCase();
    try {
      const rows = await sql<{ cognition_key: string; kind: string }[]>`
        SELECT DISTINCT cognition_key, kind
        FROM private_cognition_events
        WHERE agent_id = ${agentId}
          AND op = 'upsert'
          AND (
            cognition_key ILIKE ${`%${pointerKey}%`}
            OR cognition_key ILIKE ${`%${lowerPK}%`}
          )
          AND cognition_key ~* '(knowledge_gap|identity_unknown|uncertain_existence|identity_ambiguity|clarify_.*_identity|verify_.*_identity|no_knowledge(?:_of)?)'
          AND NOT EXISTS (
            SELECT 1 FROM private_cognition_events r
            WHERE r.agent_id = private_cognition_events.agent_id
              AND r.cognition_key = private_cognition_events.cognition_key
              AND r.op = 'retract'
          )
      `;
      if (rows.length === 0) return;
      const now = Date.now();
      const settlementId = `entity-judge-retract:${entityId}:${now}`;
      for (const r of rows) {
        const recordJson = JSON.stringify({
          key: r.cognition_key,
          kind: r.kind,
          reason: `resolved by entity ${pointerKey} (id=${entityId})`,
        });
        await sql`
          INSERT INTO private_cognition_events
            (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
          VALUES
            (${agentId}, ${r.cognition_key}, ${r.kind}, 'retract',
             ${recordJson}::jsonb, ${settlementId}, ${now}, ${now})
        `;
      }
      console.log(
        `[entity-judge] retracted ${rows.length} identity-gap cognitions for ${pointerKey} (id=${entityId}): ${rows.map((r) => r.cognition_key).join(", ")}`,
      );
    } catch (err) {
      console.warn(
        `[entity-judge] retract failed for ${pointerKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async createSurfaceAliases(
    canonicalId: number,
    surfaceForms: readonly string[],
    canonicalPointerKey?: string,
    ownerAgentId?: string,
  ): Promise<void> {
    for (const surface of surfaceForms) {
      if (surface.trim().length === 0) {
        continue;
      }
      if (canonicalPointerKey && surface === canonicalPointerKey) {
        continue;
      }
      try {
        await this.aliasRepo.createAlias(
          canonicalId,
          surface,
          "surface_mention",
          ownerAgentId,
        );
      } catch (err) {
        console.warn(
          `[entity-judge] alias create failed for ${surface} -> ${canonicalId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async embedRuntimeEntity(
    entityId: number,
    pointerKey: string,
    summary: string | null,
  ): Promise<void> {
    if (!this.embeddingRepo) return;
    try {
      const modelId = this.modelProvider.defaultEmbeddingModelId;
      if (!modelId) return;
      // Use pointer_key + summary to give the embedding semantic context
      // beyond just the raw identifier. Falls back to bare pointer_key when
      // summary is absent.
      const trimmedSummary = summary?.trim();
      const embedText =
        trimmedSummary && trimmedSummary.length > 0
          ? `${pointerKey}: ${trimmedSummary}`
          : pointerKey;
      const vectors = await this.modelProvider.embed(
        [embedText],
        "memory_index",
        modelId,
      );
      const vector = vectors[0];
      if (!vector || vector.length === 0) return;
      await this.embeddingRepo.upsert(
        makeNodeRef("entity", entityId),
        "entity",
        "primary",
        modelId,
        vector,
      );
    } catch (err) {
      console.warn(
        `[entity-judge] failed to embed new entity ${pointerKey} (id=${entityId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async finalizeResolvedEntity(
    sql: postgres.Sql,
    agentId: string,
    pointerKey: string,
    entityId: number,
    summary: string | null,
  ): Promise<void> {
    await this.embedRuntimeEntity(entityId, pointerKey, summary);
    await this.retractIdentityGapCommitments(sql, agentId, pointerKey, entityId);
  }

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

      const discoveredPointerMentions = await this.collectCandidatePointerKeys({
        sql,
        agentId: opts.agentId,
        sessionId: opts.sessionId,
        since: effectiveSince,
      });

      const unresolvedMentions = await this.filterExistingPointerKeys({
        sql,
        agentId: opts.agentId,
        mentions: discoveredPointerMentions,
      });

      const decisions: EntityJudgeDecision[] = [];
      let matched = 0;
      let created = 0;

      for (const mention of unresolvedMentions) {
        const pointerKey = mention.pointerKey;
        const displayName = pickPreferredDisplayName(
          pointerKey,
          mention.surfaceForms,
        );
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
              displayName,
              agentId: opts.agentId,
              scope,
              summary: contextSummary,
            });
          }
          if (createdEntityId != null) {
            created += 1;
            const aliasOwnerAgentId =
              scope === "private_overlay" ? opts.agentId : undefined;
            await this.createSurfaceAliases(
              createdEntityId,
              mention.surfaceForms,
              pointerKey,
              aliasOwnerAgentId,
            );
            await this.finalizeResolvedEntity(
              sql,
              opts.agentId,
              pointerKey,
              createdEntityId,
              contextSummary,
            );
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
            await this.createSurfaceAliases(
              selected.id,
              mention.surfaceForms,
              selected.pointer_key,
              aliasOwnerAgentId,
            );
            await this.retractIdentityGapCommitments(
              sql,
              opts.agentId,
              pointerKey,
              selected.id,
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

        // Prefer the LLM-generated entity_description (entity-centric) over
        // the raw episode contextSummary (agent-POV). The description is
        // stored as the entity summary AND used as embedding text so future
        // semantic retrievals surface a neutral description of what/who the
        // entity IS rather than a record of the agent's confusion.
        const entitySummary = parsed.entityDescription ?? contextSummary;
        let createdEntityId: number | null = null;
        if (!dryRun) {
          createdEntityId = await createRuntimeEntity({
            sql,
            pointerKey,
            displayName,
            agentId: opts.agentId,
            scope,
            summary: entitySummary,
          });
        }
        if (createdEntityId != null) {
          created += 1;
          const aliasOwnerAgentId =
            scope === "private_overlay" ? opts.agentId : undefined;
          await this.createSurfaceAliases(
            createdEntityId,
            mention.surfaceForms,
            pointerKey,
            aliasOwnerAgentId,
          );
          await this.finalizeResolvedEntity(
            sql,
            opts.agentId,
            pointerKey,
            createdEntityId,
            entitySummary,
          );
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
        candidate_keys: unresolvedMentions.length,
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
  }): Promise<CandidateEntityMention[]> {
    const { sql, agentId, sessionId, since } = params;
    const keys = new Map<string, Set<string>>();

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
    for (const row of episodeRows) {
      if (typeof row.key === "string") {
        appendCandidateMention(keys, row.key);
      }
    }

    const cognitionRows = await this.readCognitionCurrentRecords({
      sql,
      agentId,
      sessionId,
      since,
    });
    for (const row of cognitionRows) {
      for (const key of extractPointerKeysFromRecordJson(row.record_json)) {
        appendCandidateMention(keys, key);
      }
    }

    const settlementRows = await this.readSettlementMentionRows({
      sql,
      agentId,
      sessionId,
      since,
    });
    for (const row of settlementRows) {
      let payload = row.payload;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload) as unknown;
        } catch {
          continue;
        }
      }
      if (!payload || typeof payload !== "object") {
        continue;
      }
      const settlementPayload = payload as {
        ownerAgentId?: unknown;
        entityMentions?: unknown;
      };
      if (settlementPayload.ownerAgentId !== agentId) {
        continue;
      }

      let entityMentions: string[];
      try {
        entityMentions = normalizeEntityMentions(settlementPayload.entityMentions, {
          fieldName: "entityMentions",
        });
      } catch {
        continue;
      }
      for (const mention of entityMentions) {
        appendCandidateMention(keys, mention);
      }
    }

    return [...keys.entries()].map(([pointerKey, surfaceForms]) => ({
      pointerKey,
      surfaceForms: [...surfaceForms],
    }));
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

  private async readSettlementMentionRows(params: {
    sql: postgres.Sql;
    agentId: string;
    sessionId?: string;
    since?: number;
  }): Promise<Array<{ payload: unknown }>> {
    const { sql, sessionId, since } = params;
    if (sessionId && since !== undefined) {
      return sql<{ payload: unknown }[]>`
        SELECT payload
        FROM interaction_records
        WHERE session_id = ${sessionId}
          AND record_type = 'turn_settlement'
          AND committed_at >= ${since}
      `;
    }
    if (sessionId) {
      return sql<{ payload: unknown }[]>`
        SELECT payload
        FROM interaction_records
        WHERE session_id = ${sessionId}
          AND record_type = 'turn_settlement'
      `;
    }
    if (since !== undefined) {
      return sql<{ payload: unknown }[]>`
        SELECT payload
        FROM interaction_records
        WHERE record_type = 'turn_settlement'
          AND committed_at >= ${since}
      `;
    }
    return sql<{ payload: unknown }[]>`
      SELECT payload
      FROM interaction_records
      WHERE record_type = 'turn_settlement'
    `;
  }

  private async filterExistingPointerKeys(params: {
    sql: postgres.Sql;
    agentId: string;
    mentions: CandidateEntityMention[];
  }): Promise<CandidateEntityMention[]> {
    const { sql, agentId, mentions } = params;
    if (mentions.length === 0) {
      return [];
    }
    const pointerKeys = mentions.map((mention) => mention.pointerKey);
    const rows = await sql<{ pointer_key: string }[]>`
      SELECT LOWER(pointer_key) AS pointer_key
      FROM entity_nodes
      WHERE LOWER(pointer_key) = ANY(${pointerKeys})
        AND (
          memory_scope = 'shared_public'
          OR (memory_scope = 'private_overlay' AND owner_agent_id = ${agentId})
        )
    `;
    const existing = new Set(rows.map((row) => row.pointer_key));
    return mentions.filter((mention) => !existing.has(mention.pointerKey));
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
