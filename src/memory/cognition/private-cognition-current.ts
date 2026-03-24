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
  sourcePointerKey?: string;
  predicate?: string;
  targetPointerKey?: string;
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

function safeParseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeConflictFactorRefs(value: unknown): { refs: string[]; dropped: number } {
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
    if (!/^(assertion|evaluation|commitment|private_belief|private_event|private_episode|event):\d+$/.test(trimmed)) {
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
      this.applyAssertionUpsert(event, parsed as ParsedAssertionRecord);
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

    const summaryText = record.predicate
      ? `${record.predicate}: ${record.sourcePointerKey ?? "?"} → ${record.targetPointerKey ?? "?"}`
      : null;

    this.db
      .prepare(
        `INSERT INTO private_cognition_current (agent_id, cognition_key, kind, stance, basis, status, pre_contested_stance, conflict_summary, conflict_factor_refs_json, summary_text, record_json, source_event_id, updated_at)
         VALUES (?, ?, 'assertion', ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, cognition_key) DO UPDATE SET
            stance = excluded.stance,
            basis = CASE WHEN excluded.basis IS NOT NULL THEN excluded.basis ELSE private_cognition_current.basis END,
            status = 'active',
            pre_contested_stance = excluded.pre_contested_stance,
            conflict_summary = excluded.conflict_summary,
            conflict_factor_refs_json = excluded.conflict_factor_refs_json,
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
