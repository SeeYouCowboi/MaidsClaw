import type postgres from "postgres";
import type { CognitionEventRow } from "../../../memory/cognition/cognition-event-repo.js";
import {
  normalizeConflictFactorRefs,
  type CognitionCurrentRow,
} from "../../../memory/cognition/private-cognition-current.js";
import type { CognitionProjectionRepo } from "../contracts/cognition-projection-repo.js";

type ParsedAssertionRecord = {
  holderPointerKey?: string;
  claim?: string;
  entityPointerKeys?: string[];
  stance?: string;
  basis?: string;
  preContestedStance?: string;
  conflictSummary?: string;
  conflictFactorRefs?: unknown;
};

type ParsedCommitmentRecord = {
  mode?: string;
  target?: unknown;
  status?: string;
};

function safeParseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringifyJsonb(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
}

function stringifyJsonbNullable(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Extract flat pointer keys from the nested record_json structure.
 * record_json stores holderId as {kind, value} and entityRefs as [{kind, value}, ...],
 * but ParsedAssertionRecord expects holderPointerKey (string) and entityPointerKeys (string[]).
 * Also handles backward compat from old SPO model (sourcePointerKey/predicate/targetPointerKey).
 */
function extractAssertionRecord(raw: Record<string, unknown>): ParsedAssertionRecord {
  const record = raw as Record<string, unknown>;

  // Extract holderPointerKey from holderId (new model) or sourcePointerKey (old model)
  let holderPointerKey: string | undefined;
  const holderId = record.holderId as Record<string, unknown> | string | undefined;
  if (typeof holderId === "string") {
    holderPointerKey = holderId;
  } else if (holderId && typeof holderId === "object" && typeof holderId.value === "string") {
    holderPointerKey = holderId.value;
  } else if (typeof record.holderPointerKey === "string") {
    holderPointerKey = record.holderPointerKey;
  } else if (typeof record.sourcePointerKey === "string") {
    // Backward compat: old SPO model
    holderPointerKey = record.sourcePointerKey;
  }

  // Extract claim from claim (new model) or predicate (old model)
  let claim: string | undefined;
  if (typeof record.claim === "string") {
    claim = record.claim;
  } else if (typeof record.predicate === "string") {
    claim = record.predicate;
  }

  // Extract entityPointerKeys from entityRefs (new model) or targetPointerKey (old model)
  let entityPointerKeys: string[] | undefined;
  const entityRefs = record.entityRefs as unknown[] | undefined;
  if (Array.isArray(entityRefs)) {
    entityPointerKeys = entityRefs
      .map((ref) => {
        if (typeof ref === "string") return ref;
        if (ref && typeof ref === "object" && typeof (ref as Record<string, unknown>).value === "string") {
          return (ref as Record<string, unknown>).value as string;
        }
        return null;
      })
      .filter((v): v is string => v !== null);
  } else if (Array.isArray(record.entityPointerKeys)) {
    entityPointerKeys = record.entityPointerKeys as string[];
  } else if (typeof record.targetPointerKey === "string") {
    // Backward compat: old SPO model
    entityPointerKeys = [record.targetPointerKey];
  }

  return {
    holderPointerKey,
    claim,
    entityPointerKeys,
    stance: typeof record.stance === "string" ? record.stance : undefined,
    basis: typeof record.basis === "string" ? record.basis : undefined,
    preContestedStance: typeof record.preContestedStance === "string" ? record.preContestedStance : undefined,
    conflictSummary: typeof record.conflictSummary === "string" ? record.conflictSummary : undefined,
    conflictFactorRefs: record.conflictFactorRefs,
  };
}

export class PgCognitionProjectionRepo implements CognitionProjectionRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async upsertFromEvent(event: CognitionEventRow): Promise<void> {
    if (event.op === "retract") {
      await this.applyRetract(event);
      return;
    }

    const parsed = safeParseJson(event.record_json);

    if (event.kind === "assertion") {
      await this.applyAssertionUpsert(event, extractAssertionRecord(parsed));
    } else if (event.kind === "evaluation") {
      await this.applyEvaluationUpsert(event, parsed);
    } else if (event.kind === "commitment") {
      await this.applyCommitmentUpsert(event, parsed as ParsedCommitmentRecord);
    }
  }

  async rebuild(agentId: string): Promise<void> {
    await this.sql`
      DELETE FROM private_cognition_current WHERE agent_id = ${agentId}
    `;

    const rows = await this.sql`
      SELECT id, agent_id, cognition_key, kind, op, record_json,
             settlement_id, committed_time, created_at
      FROM private_cognition_events
      WHERE agent_id = ${agentId}
      ORDER BY committed_time ASC, id ASC
    `;

    for (const row of rows) {
      const eventRow: CognitionEventRow = {
        id: Number(row.id),
        agent_id: row.agent_id as string,
        cognition_key: row.cognition_key as string,
        kind: row.kind as string,
        op: row.op as string,
        record_json: stringifyJsonbNullable(row.record_json),
        settlement_id: row.settlement_id as string,
        committed_time: Number(row.committed_time),
        created_at: Number(row.created_at),
      };
      await this.upsertFromEvent(eventRow);
    }
  }

  async getCurrent(
    agentId: string,
    cognitionKey: string,
  ): Promise<CognitionCurrentRow | null> {
    const rows = await this.sql`
      SELECT id, agent_id, cognition_key, kind, stance, basis, status,
             pre_contested_stance, conflict_summary, conflict_factor_refs_json,
             summary_text, record_json, source_event_id, updated_at
      FROM private_cognition_current
      WHERE agent_id = ${agentId} AND cognition_key = ${cognitionKey}
    `;
    if (rows.length === 0) return null;
    return this.mapCurrentRow(rows[0]);
  }

  async getAllCurrent(agentId: string): Promise<CognitionCurrentRow[]> {
    const rows = await this.sql`
      SELECT id, agent_id, cognition_key, kind, stance, basis, status,
             pre_contested_stance, conflict_summary, conflict_factor_refs_json,
             summary_text, record_json, source_event_id, updated_at
      FROM private_cognition_current
      WHERE agent_id = ${agentId}
      ORDER BY updated_at DESC
    `;
    return rows.map((r) => this.mapCurrentRow(r));
  }

  private jsonb(value: unknown) {
    return this.sql.json(value as never);
  }

  private mapCurrentRow(row: Record<string, unknown>): CognitionCurrentRow {
    return {
      id: Number(row.id),
      agent_id: row.agent_id as string,
      cognition_key: row.cognition_key as string,
      kind: row.kind as string,
      stance: (row.stance as string) ?? null,
      basis: (row.basis as string) ?? null,
      status: row.status as string,
      pre_contested_stance: (row.pre_contested_stance as string) ?? null,
      conflict_summary: (row.conflict_summary as string) ?? null,
      conflict_factor_refs_json: stringifyJsonbNullable(row.conflict_factor_refs_json),
      summary_text: (row.summary_text as string) ?? null,
      record_json: stringifyJsonb(row.record_json),
      source_event_id: Number(row.source_event_id),
      updated_at: Number(row.updated_at),
    };
  }

  private async applyAssertionUpsert(
    event: CognitionEventRow,
    record: ParsedAssertionRecord,
  ): Promise<void> {
    const isContested = record.stance === "contested";
    const normalizedFactors = normalizeConflictFactorRefs(record.conflictFactorRefs);
    const fallbackSummary =
      normalizedFactors.dropped > 0
        ? `contested (${normalizedFactors.refs.length} factors resolved, ${normalizedFactors.dropped} dropped)`
        : `contested (${normalizedFactors.refs.length} factors)`;
    const conflictSummary = isContested
      ? (record.conflictSummary?.trim() || fallbackSummary)
      : null;
    const conflictFactorRefsJsonb = isContested
      ? this.jsonb(normalizedFactors.refs)
      : null;
    const entitySuffix = Array.isArray(record.entityPointerKeys) && record.entityPointerKeys.length > 0
      ? ` | entities: ${record.entityPointerKeys.join(", ")}`
      : "";
    const summaryText = record.claim
      ? `[${event.cognition_key}] [${record.holderPointerKey ?? "?"}] ${record.claim}${entitySuffix}`
      : null;

    const recordJsonb = this.jsonb(safeParseJson(event.record_json));

    await this.sql`
      INSERT INTO private_cognition_current (
        agent_id, cognition_key, kind, stance, basis, status,
        pre_contested_stance, conflict_summary, conflict_factor_refs_json,
        summary_text, record_json, source_event_id, updated_at
      ) VALUES (
        ${event.agent_id}, ${event.cognition_key}, 'assertion',
        ${record.stance ?? null}, ${record.basis ?? null}, 'active',
        ${record.preContestedStance ?? null}, ${conflictSummary},
        ${conflictFactorRefsJsonb},
        ${summaryText}, ${recordJsonb},
        ${event.id}, ${event.committed_time}
      )
      ON CONFLICT(agent_id, cognition_key) DO UPDATE SET
        stance = excluded.stance,
        basis = CASE WHEN excluded.basis IS NOT NULL THEN excluded.basis
                     ELSE private_cognition_current.basis END,
        status = 'active',
        -- Auto-track pre_contested_stance: preserve the stance that held
        -- BEFORE the contested transition. If the new record supplies an
        -- explicit value, use it; otherwise keep whatever was previously
        -- recorded in pre_contested_stance (never overwrite it with the
        -- literal 'contested' sentinel — that would discard the pre-contested
        -- history and break belief-revision rollback checks).
        pre_contested_stance = COALESCE(
          excluded.pre_contested_stance,
          private_cognition_current.pre_contested_stance
        ),
        -- Preserve conflict metadata when resolving a contested assertion
        conflict_summary = COALESCE(
          excluded.conflict_summary,
          private_cognition_current.conflict_summary
        ),
        conflict_factor_refs_json = COALESCE(
          excluded.conflict_factor_refs_json,
          private_cognition_current.conflict_factor_refs_json
        ),
        summary_text = excluded.summary_text,
        record_json = excluded.record_json,
        source_event_id = excluded.source_event_id,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= private_cognition_current.updated_at
    `;
  }

  private async applyEvaluationUpsert(
    event: CognitionEventRow,
    record: Record<string, unknown>,
  ): Promise<void> {
    const notes = typeof record.notes === "string" ? record.notes : "";
    const summaryText = `evaluation: ${notes}`;
    const recordJsonb = this.jsonb(safeParseJson(event.record_json));

    await this.sql`
      INSERT INTO private_cognition_current (
        agent_id, cognition_key, kind, stance, basis, status,
        pre_contested_stance, conflict_summary, conflict_factor_refs_json,
        summary_text, record_json, source_event_id, updated_at
      ) VALUES (
        ${event.agent_id}, ${event.cognition_key}, 'evaluation',
        ${null}, ${null}, 'active',
        ${null}, ${null}, ${null},
        ${summaryText}, ${recordJsonb},
        ${event.id}, ${event.committed_time}
      )
      ON CONFLICT(agent_id, cognition_key) DO UPDATE SET
        status = 'active',
        summary_text = excluded.summary_text,
        record_json = excluded.record_json,
        source_event_id = excluded.source_event_id,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= private_cognition_current.updated_at
    `;
  }

  private async applyCommitmentUpsert(
    event: CognitionEventRow,
    record: ParsedCommitmentRecord,
  ): Promise<void> {
    const commitmentStatus = record.status ?? "active";
    const target = record.target ? JSON.stringify(record.target) : "";
    const summaryText = `${record.mode ?? "goal"}: ${target}`;
    const recordJsonb = this.jsonb(safeParseJson(event.record_json));

    await this.sql`
      INSERT INTO private_cognition_current (
        agent_id, cognition_key, kind, stance, basis, status,
        pre_contested_stance, conflict_summary, conflict_factor_refs_json,
        summary_text, record_json, source_event_id, updated_at
      ) VALUES (
        ${event.agent_id}, ${event.cognition_key}, 'commitment',
        ${null}, ${null}, ${commitmentStatus},
        ${null}, ${null}, ${null},
        ${summaryText}, ${recordJsonb},
        ${event.id}, ${event.committed_time}
      )
      ON CONFLICT(agent_id, cognition_key) DO UPDATE SET
        status = excluded.status,
        summary_text = excluded.summary_text,
        record_json = excluded.record_json,
        source_event_id = excluded.source_event_id,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= private_cognition_current.updated_at
    `;
  }

  private async applyRetract(event: CognitionEventRow): Promise<void> {
    const rows = await this.sql`
      SELECT id, kind FROM private_cognition_current
      WHERE agent_id = ${event.agent_id} AND cognition_key = ${event.cognition_key}
    `;

    if (rows.length === 0) return;
    const existingId = Number(rows[0].id);

    if (rows[0].kind === "assertion") {
      await this.sql`
        UPDATE private_cognition_current
        SET status = 'retracted', stance = 'rejected',
            source_event_id = ${event.id}, updated_at = ${event.committed_time}
        WHERE id = ${existingId}
      `;
    } else {
      await this.sql`
        UPDATE private_cognition_current
        SET status = 'retracted',
            source_event_id = ${event.id}, updated_at = ${event.committed_time}
        WHERE id = ${existingId}
      `;
    }
  }

  async updateConflictFactors(
    agentId: string,
    cognitionKey: string,
    conflictSummary: string,
    conflictFactorRefsJson: string,
    updatedAt: number,
  ): Promise<void> {
    await this.sql`
      UPDATE private_cognition_current
      SET conflict_summary = ${conflictSummary},
          conflict_factor_refs_json = ${conflictFactorRefsJson},
          updated_at = ${updatedAt}
      WHERE agent_id = ${agentId} AND cognition_key = ${cognitionKey}
    `;
  }

  async patchRecordJsonSourceEventRef(
    id: number,
    sourceEventRef: string,
    updatedAt: number,
  ): Promise<void> {
    await this.sql`
      UPDATE private_cognition_current
      SET record_json = record_json || jsonb_build_object('sourceEventRef', ${sourceEventRef}::text),
          updated_at = ${updatedAt}
      WHERE id = ${id}
    `;
  }

  async resolveEntityByPointerKey(pointerKey: string, agentId: string): Promise<number | null> {
    const normalizedPointerKey = pointerKey.normalize("NFC");
    const rows = await this.sql<{ id: string | number }[]>`
      SELECT id
      FROM entity_nodes
      WHERE pointer_key = ${normalizedPointerKey}
        AND (
          (memory_scope = 'private_overlay' AND owner_agent_id = ${agentId})
          OR memory_scope = 'shared_public'
        )
      ORDER BY CASE WHEN memory_scope = 'private_overlay' THEN 0 ELSE 1 END
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return Number(rows[0].id);
  }
}
