import type { CognitionEventRow } from "./cognition-event-repo.js";

type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  transaction?<T>(fn: () => T): T | (() => T);
};

export type CognitionCurrentRow = {
  id: number;
  agent_id: string;
  "cognition_key": string;
  kind: string;
  stance: string | null;
  basis: string | null;
  status: string;
  pre_contested_stance: string | null;
  conflict_summary: string | null;
  conflict_factor_refs_json: string | null;
  summary_text: string | null;
  record_json: string;
  source_event_id: number;
  updated_at: number;
};

type ParsedAssertionRecord = {
  holderPointerKey?: string;
  claim?: string;
  entityPointerKeys?: string[];
  stance?: string;
  basis?: string;
  preContestedStance?: string;
  conflictSummary?: string;
  conflictFactorRefs?: unknown;
  provenance?: string;
};

type ParsedCommitmentRecord = {
  mode?: string;
  target?: unknown;
  status?: string;
  priority?: number;
  horizon?: string;
};

function extractAssertionRecord(raw: Record<string, unknown>): ParsedAssertionRecord {
  let holderPointerKey: string | undefined;
  const holderId = raw.holderId as Record<string, unknown> | string | undefined;
  if (typeof holderId === "string") holderPointerKey = holderId;
  else if (holderId && typeof holderId === "object" && typeof holderId.value === "string") holderPointerKey = holderId.value;
  else if (typeof raw.holderPointerKey === "string") holderPointerKey = raw.holderPointerKey;
  else if (typeof raw.sourcePointerKey === "string") holderPointerKey = raw.sourcePointerKey;

  let claim: string | undefined;
  if (typeof raw.claim === "string") claim = raw.claim;
  else if (typeof raw.predicate === "string") claim = raw.predicate;

  let entityPointerKeys: string[] | undefined;
  const entityRefs = raw.entityRefs as unknown[] | undefined;
  if (Array.isArray(entityRefs)) {
    entityPointerKeys = entityRefs
      .map((ref) => {
        if (typeof ref === "string") return ref;
        if (ref && typeof ref === "object" && typeof (ref as Record<string, unknown>).value === "string") return (ref as Record<string, unknown>).value as string;
        return null;
      })
      .filter((v): v is string => v !== null);
  } else if (Array.isArray(raw.entityPointerKeys)) {
    entityPointerKeys = raw.entityPointerKeys as string[];
  } else if (typeof raw.targetPointerKey === "string") {
    entityPointerKeys = [raw.targetPointerKey];
  }

  return {
    holderPointerKey, claim, entityPointerKeys,
    stance: typeof raw.stance === "string" ? raw.stance : undefined,
    basis: typeof raw.basis === "string" ? raw.basis : undefined,
    preContestedStance: typeof raw.preContestedStance === "string" ? raw.preContestedStance : undefined,
    conflictSummary: typeof raw.conflictSummary === "string" ? raw.conflictSummary : undefined,
    conflictFactorRefs: raw.conflictFactorRefs,
    provenance: typeof raw.provenance === "string" ? raw.provenance : undefined,
  };
}

function safeParseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function normalizeConflictFactorRefs(value: unknown): { refs: string[]; dropped: number } {
  if (!Array.isArray(value)) {
    return { refs: [], dropped: 0 };
  }

  const refs: string[] = [];
  let dropped = 0;
  for (const item of value) {
    if (typeof item !== "string") {
      dropped += 1;
      continue;
    }
    const trimmed = item.trim();
    if (!/^(assertion|evaluation|commitment|episode|private_episode|event):\d+$/.test(trimmed)) {
      dropped += 1;
      continue;
    }
    refs.push(trimmed);
  }
  return { refs, dropped };
}

export class PrivateCognitionProjectionRepo {
  constructor(private readonly db: DbLike) {}

  private runInTransaction<T>(fn: () => T): T {
    const db = this.db as unknown as { transaction?: (f: () => T) => T | (() => T) };
    if (typeof db.transaction !== "function") {
      return fn();
    }
    const result = db.transaction(fn);
    if (typeof result === "function") {
      return (result as () => T)();
    }
    return result;
  }

  upsertFromEvent(event: CognitionEventRow): void {
    if (event.op === "retract") {
      this.applyRetract(event);
      return;
    }

    const parsed = safeParseJson(event.record_json);

    if (event.kind === "assertion") {
      this.applyAssertionUpsert(event, extractAssertionRecord(parsed));
    } else if (event.kind === "evaluation") {
      this.applyEvaluationUpsert(event, parsed);
    } else if (event.kind === "commitment") {
      this.applyCommitmentUpsert(event, parsed as ParsedCommitmentRecord);
    }
  }

  rebuild(agentId: string): void {
    this.runInTransaction(() => {
      this.db
        .prepare(`DELETE FROM private_cognition_current WHERE agent_id = ?`)
        .run(agentId);

      const events = this.db
        .prepare(
          `SELECT id, agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at FROM private_cognition_events WHERE agent_id = ? ORDER BY committed_time ASC, id ASC`,
        )
        .all(agentId) as CognitionEventRow[];

      for (const event of events) {
        this.upsertFromEvent(event);
      }
    });
  }

  getCurrent(agentId: string, cognitionKey: string): CognitionCurrentRow | null {
    const row = this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, kind, stance, basis, status, pre_contested_stance, conflict_summary, conflict_factor_refs_json, summary_text, record_json, source_event_id, updated_at FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ?`,
      )
      .get(agentId, cognitionKey) as CognitionCurrentRow | undefined;
    return row ?? null;
  }

  getAllCurrent(agentId: string): CognitionCurrentRow[] {
    return this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, kind, stance, basis, status, pre_contested_stance, conflict_summary, conflict_factor_refs_json, summary_text, record_json, source_event_id, updated_at FROM private_cognition_current WHERE agent_id = ? ORDER BY updated_at DESC`,
      )
      .all(agentId) as CognitionCurrentRow[];
  }

  private applyAssertionUpsert(event: CognitionEventRow, record: ParsedAssertionRecord): void {
    const isContested = record.stance === "contested";
    const normalizedFactors = normalizeConflictFactorRefs(record.conflictFactorRefs);
    const fallbackSummary = normalizedFactors.dropped > 0
      ? `contested (${normalizedFactors.refs.length} factors resolved, ${normalizedFactors.dropped} dropped)`
      : `contested (${normalizedFactors.refs.length} factors)`;
    const conflictSummary = isContested
      ? (record.conflictSummary?.trim() || fallbackSummary)
      : null;
    const conflictFactorRefsJson = isContested
      ? JSON.stringify(normalizedFactors.refs)
      : null;

    const entitySuffix = Array.isArray(record.entityPointerKeys) && record.entityPointerKeys.length > 0
      ? ` | entities: ${record.entityPointerKeys.join(", ")}`
      : "";
    const summaryText = record.claim
      ? `[${event.cognition_key}] [${record.holderPointerKey ?? "?"}] ${record.claim}${entitySuffix}`
      : null;

    this.db
      .prepare(
        `INSERT INTO private_cognition_current (agent_id, cognition_key, kind, stance, basis, status, pre_contested_stance, conflict_summary, conflict_factor_refs_json, summary_text, record_json, source_event_id, updated_at)
         VALUES (?, ?, 'assertion', ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, cognition_key) DO UPDATE SET
            stance = excluded.stance,
            basis = CASE WHEN excluded.basis IS NOT NULL THEN excluded.basis ELSE private_cognition_current.basis END,
            status = 'active',
            -- Preserve pre_contested_stance across transitions: only overwrite
            -- when the new record explicitly supplies a value. The prior code
            -- used a simple excluded.pre_contested_stance override which wiped
            -- the field to NULL on any contested to non-contested transition
            -- whose op did not repeat the preContestedStance (e.g. rejected
            -- rollbacks). COALESCE preserves the earlier value instead.
            --
            -- The conflict_* COALESCEs mirror the PG path: applyAssertionUpsert
            -- only populates the insert values when the new record is itself
            -- contested, so the COALESCE effectively means "preserve existing
            -- conflict metadata unless this op is writing fresh contested
            -- metadata". Non-contested transitions therefore will NOT clear
            -- stale conflict rows -- readers that care must consult status
            -- (retracted) or stance (rejected) to disambiguate.
            pre_contested_stance = COALESCE(excluded.pre_contested_stance, private_cognition_current.pre_contested_stance),
            conflict_summary = COALESCE(excluded.conflict_summary, private_cognition_current.conflict_summary),
            conflict_factor_refs_json = COALESCE(excluded.conflict_factor_refs_json, private_cognition_current.conflict_factor_refs_json),
            summary_text = excluded.summary_text,
            record_json = excluded.record_json,
            source_event_id = excluded.source_event_id,
            updated_at = excluded.updated_at`,
      )
      .run(
        event.agent_id,
        event.cognition_key,
        record.stance ?? null,
        record.basis ?? null,
        record.preContestedStance ?? null,
        conflictSummary,
        conflictFactorRefsJson,
        summaryText,
        event.record_json ?? "{}",
        event.id,
        event.committed_time,
      );
  }

  private applyEvaluationUpsert(event: CognitionEventRow, record: Record<string, unknown>): void {
    const notes = typeof record.notes === "string" ? record.notes : "";
    const summaryText = `evaluation: ${notes}`;

    this.db
      .prepare(
        `INSERT INTO private_cognition_current (agent_id, cognition_key, kind, stance, basis, status, pre_contested_stance, conflict_summary, conflict_factor_refs_json, summary_text, record_json, source_event_id, updated_at)
         VALUES (?, ?, 'evaluation', NULL, NULL, 'active', NULL, NULL, NULL, ?, ?, ?, ?)
         ON CONFLICT(agent_id, cognition_key) DO UPDATE SET
           status = 'active',
           summary_text = excluded.summary_text,
           record_json = excluded.record_json,
           source_event_id = excluded.source_event_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        event.agent_id,
        event.cognition_key,
        summaryText,
        event.record_json ?? "{}",
        event.id,
        event.committed_time,
      );
  }

  private applyCommitmentUpsert(event: CognitionEventRow, record: ParsedCommitmentRecord): void {
    const commitmentStatus = record.status ?? "active";
    const target = record.target ? JSON.stringify(record.target) : "";
    const summaryText = `${record.mode ?? "goal"}: ${target}`;

    this.db
      .prepare(
        `INSERT INTO private_cognition_current (agent_id, cognition_key, kind, stance, basis, status, pre_contested_stance, conflict_summary, conflict_factor_refs_json, summary_text, record_json, source_event_id, updated_at)
         VALUES (?, ?, 'commitment', NULL, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?)
         ON CONFLICT(agent_id, cognition_key) DO UPDATE SET
           status = excluded.status,
           summary_text = excluded.summary_text,
           record_json = excluded.record_json,
           source_event_id = excluded.source_event_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        event.agent_id,
        event.cognition_key,
        commitmentStatus,
        summaryText,
        event.record_json ?? "{}",
        event.id,
        event.committed_time,
      );
  }

  private applyRetract(event: CognitionEventRow): void {
    const existing = this.db
      .prepare(
        `SELECT id, kind FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ?`,
      )
      .get(event.agent_id, event.cognition_key) as { id: number; kind: string } | undefined;

    if (!existing) return;

    if (existing.kind === "assertion") {
      this.db
        .prepare(
          `UPDATE private_cognition_current SET status = 'retracted', stance = 'rejected', source_event_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(event.id, event.committed_time, existing.id);
    } else {
      this.db
        .prepare(
          `UPDATE private_cognition_current SET status = 'retracted', source_event_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(event.id, event.committed_time, existing.id);
    }
  }
}
