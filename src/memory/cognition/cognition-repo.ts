import { MaidsClawError } from "../../core/errors.js";
import {
  BELIEF_TYPE_TO_BASIS,
  EPISTEMIC_STATUS_TO_STANCE,
  type AssertionBasis,
  type AssertionStance,
} from "../../runtime/rp-turn-contract.js";

type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

type LegacyEpistemicStatus = "confirmed" | "suspected" | "hypothetical" | "retracted";
type LegacyBeliefType = "observation" | "inference" | "suspicion" | "intention";

type UpsertAssertionParams = {
  agentId: string;
  cognitionKey?: string;
  settlementId: string;
  opIndex: number;
  sourcePointerKey: string;
  predicate: string;
  targetPointerKey: string;
  stance: AssertionStance;
  basis?: AssertionBasis;
  preContestedStance?: AssertionStance;
  confidence?: number;
  provenance?: string;
};

type UpsertEvaluationParams = {
  agentId: string;
  cognitionKey?: string;
  settlementId: string;
  opIndex: number;
  targetEntityId?: number;
  salience?: number;
  dimensions: Array<{ name: string; value: number }>;
  emotionTags?: string[];
  notes?: string;
};

type UpsertCommitmentParams = {
  agentId: string;
  cognitionKey?: string;
  settlementId: string;
  opIndex: number;
  targetEntityId?: number;
  salience?: number;
  mode: "goal" | "intent" | "plan" | "constraint" | "avoidance";
  target: unknown;
  status: "active" | "paused" | "fulfilled" | "abandoned";
  priority?: number;
  horizon?: "immediate" | "near" | "long";
};

type CanonicalAssertionRow = {
  id: number;
  agentId: string;
  sourceEntityId: number;
  targetEntityId: number;
  predicate: string;
  cognitionKey: string | null;
  settlementId: string | null;
  opIndex: number | null;
  provenance: string | null;
  sourceEventRef: string | null;
  stance: AssertionStance;
  basis: AssertionBasis | null;
  preContestedStance: AssertionStance | null;
  createdAt: number;
  updatedAt: number;
};

type CanonicalEvaluationRow = {
  id: number;
  agentId: string;
  cognitionKey: string | null;
  settlementId: string | null;
  opIndex: number | null;
  salience: number | null;
  targetEntityId: number | null;
  dimensions: Array<{ name: string; value: number }>;
  emotionTags: string[];
  notes: string | null;
  status: "active" | "retracted";
  createdAt: number;
  updatedAt: number | null;
};

type CanonicalCommitmentRow = {
  id: number;
  agentId: string;
  cognitionKey: string | null;
  settlementId: string | null;
  opIndex: number | null;
  salience: number | null;
  targetEntityId: number | null;
  mode: "goal" | "intent" | "plan" | "constraint" | "avoidance";
  target: unknown;
  commitmentStatus: "active" | "paused" | "fulfilled" | "abandoned";
  priority: number | null;
  horizon: "immediate" | "near" | "long" | null;
  status: "active" | "retracted";
  createdAt: number;
  updatedAt: number | null;
};

type FactOverlayRow = {
  id: number;
  agent_id: string;
  source_entity_id: number;
  target_entity_id: number;
  predicate: string;
  belief_type: LegacyBeliefType | null;
  epistemic_status: LegacyEpistemicStatus | null;
  basis: AssertionBasis | null;
  stance: AssertionStance | null;
  pre_contested_stance: AssertionStance | null;
  provenance: string | null;
  source_event_ref: string | null;
  cognition_key: string | null;
  settlement_id: string | null;
  op_index: number | null;
  created_at: number;
  updated_at: number;
};

type EventOverlayRow = {
  id: number;
  agent_id: string;
  cognition_key: string | null;
  explicit_kind: "evaluation" | "commitment" | null;
  settlement_id: string | null;
  op_index: number | null;
  salience: number | null;
  primary_actor_entity_id: number | null;
  target_entity_id: number | null;
  metadata_json: string | null;
  cognition_status: "active" | "retracted";
  created_at: number;
  updated_at: number | null;
};

const STANCE_TO_EPISTEMIC_STATUS: Record<AssertionStance, LegacyEpistemicStatus> = {
  confirmed: "confirmed",
  tentative: "suspected",
  hypothetical: "hypothetical",
  rejected: "retracted",
  accepted: "confirmed",
  contested: "suspected",
  abandoned: "retracted",
};

const BASIS_TO_BELIEF_TYPE: Record<AssertionBasis, LegacyBeliefType> = {
  first_hand: "observation",
  inference: "inference",
  introspection: "intention",
  hearsay: "observation",
  belief: "observation",
};

export class CognitionRepository {
  constructor(private readonly db: DbLike) {}

  upsertAssertion(params: UpsertAssertionParams): { id: number } {
    const sourceEntityId = this.resolveEntityByPointerKey(params.sourcePointerKey, params.agentId);
    const targetEntityId = this.resolveEntityByPointerKey(params.targetPointerKey, params.agentId);
    if (sourceEntityId === null || targetEntityId === null) {
      const unresolvedPointerKeys: string[] = [];
      if (sourceEntityId === null) unresolvedPointerKeys.push(params.sourcePointerKey);
      if (targetEntityId === null) unresolvedPointerKeys.push(params.targetPointerKey);
      throw new MaidsClawError({
        code: "COGNITION_UNRESOLVED_REFS",
        message: `Unresolved entity refs in explicit assertion: ${unresolvedPointerKeys.join(", ")}`,
        retriable: true,
        details: {
          unresolvedPointerKeys,
          cognitionKey: params.cognitionKey,
          settlementId: params.settlementId,
        },
      });
    }

    const now = Date.now();
    const cognitionKey = params.cognitionKey?.normalize("NFC");
    const legacyStatus = STANCE_TO_EPISTEMIC_STATUS[params.stance];
    const legacyBeliefType = params.basis ? BASIS_TO_BELIEF_TYPE[params.basis] : null;

    if (cognitionKey) {
      const existing = this.db
        .prepare(
          `SELECT id FROM agent_fact_overlay
           WHERE agent_id = ? AND cognition_key = ?`,
        )
        .get(params.agentId, cognitionKey) as { id: number } | null;

      if (existing) {
        this.db
          .prepare(
            `UPDATE agent_fact_overlay
             SET source_entity_id = ?,
                 target_entity_id = ?,
                 predicate = ?,
                 confidence = NULL,
                 epistemic_status = ?,
                 belief_type = ?,
                 basis = ?,
                 stance = ?,
                 pre_contested_stance = ?,
                 provenance = ?,
                 settlement_id = ?,
                 op_index = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(
            sourceEntityId,
            targetEntityId,
            params.predicate,
            legacyStatus,
            legacyBeliefType,
            params.basis ?? null,
            params.stance,
            params.preContestedStance ?? null,
            params.provenance ?? null,
            params.settlementId,
            params.opIndex,
            now,
            existing.id,
          );
        return { id: existing.id };
      }

      const result = this.db
        .prepare(
          `INSERT INTO agent_fact_overlay (
             agent_id,
             source_entity_id,
             target_entity_id,
             predicate,
             belief_type,
             confidence,
             epistemic_status,
             basis,
             stance,
             pre_contested_stance,
             provenance,
             source_event_ref,
             cognition_key,
             settlement_id,
             op_index,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          params.agentId,
          sourceEntityId,
          targetEntityId,
          params.predicate,
          legacyBeliefType,
          legacyStatus,
          params.basis ?? null,
          params.stance,
          params.preContestedStance ?? null,
          params.provenance ?? null,
          cognitionKey,
          params.settlementId,
          params.opIndex,
          now,
          now,
        );
      return { id: Number(result.lastInsertRowid) };
    }

    const result = this.db
      .prepare(
        `INSERT INTO agent_fact_overlay (
           agent_id,
           source_entity_id,
           target_entity_id,
           predicate,
           belief_type,
           confidence,
           epistemic_status,
           basis,
           stance,
           pre_contested_stance,
           provenance,
           source_event_ref,
           settlement_id,
           op_index,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        params.agentId,
        sourceEntityId,
        targetEntityId,
        params.predicate,
        legacyBeliefType,
        legacyStatus,
        params.basis ?? null,
        params.stance,
        params.preContestedStance ?? null,
        params.provenance ?? null,
        params.settlementId,
        params.opIndex,
        now,
        now,
      );
    return { id: Number(result.lastInsertRowid) };
  }

  upsertEvaluation(params: UpsertEvaluationParams): { id: number } {
    const now = Date.now();
    const cognitionKey = params.cognitionKey?.normalize("NFC");
    const metadataJson = JSON.stringify({
      dimensions: params.dimensions,
      emotionTags: params.emotionTags ?? [],
      notes: params.notes ?? null,
    });

    if (cognitionKey) {
      const existing = this.db
        .prepare(
          `SELECT id FROM agent_event_overlay
           WHERE agent_id = ? AND cognition_key = ? AND cognition_status = 'active'`,
        )
        .get(params.agentId, cognitionKey) as { id: number } | null;
      if (existing) {
        this.db
          .prepare(
            `UPDATE agent_event_overlay
             SET salience = ?,
                 primary_actor_entity_id = ?,
                 target_entity_id = ?,
                 metadata_json = ?,
                 settlement_id = ?,
                 op_index = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(
            params.salience ?? null,
            params.targetEntityId ?? null,
            params.targetEntityId ?? null,
            metadataJson,
            params.settlementId,
            params.opIndex,
            now,
            existing.id,
          );
        return { id: existing.id };
      }
    }

    const result = this.db
      .prepare(
        `INSERT INTO agent_event_overlay (
           event_id,
           agent_id,
           role,
           private_notes,
           salience,
           emotion,
           event_category,
           primary_actor_entity_id,
           projection_class,
           location_entity_id,
           target_entity_id,
           projectable_summary,
           source_record_id,
           cognition_key,
           explicit_kind,
           settlement_id,
           op_index,
           metadata_json,
           cognition_status,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        null,
        params.agentId,
        null,
        null,
        params.salience ?? null,
        null,
        "thought",
        params.targetEntityId ?? null,
        "none",
        null,
        params.targetEntityId ?? null,
        null,
        null,
        cognitionKey ?? null,
        "evaluation",
        params.settlementId,
        params.opIndex,
        metadataJson,
        now,
        now,
      );
    return { id: Number(result.lastInsertRowid) };
  }

  upsertCommitment(params: UpsertCommitmentParams): { id: number } {
    const now = Date.now();
    const cognitionKey = params.cognitionKey?.normalize("NFC");
    const metadataJson = JSON.stringify({
      mode: params.mode,
      target: params.target,
      status: params.status,
      priority: params.priority ?? null,
      horizon: params.horizon ?? null,
    });

    if (cognitionKey) {
      const existing = this.db
        .prepare(
          `SELECT id FROM agent_event_overlay
           WHERE agent_id = ? AND cognition_key = ? AND cognition_status = 'active'`,
        )
        .get(params.agentId, cognitionKey) as { id: number } | null;
      if (existing) {
        this.db
          .prepare(
            `UPDATE agent_event_overlay
             SET salience = ?,
                 primary_actor_entity_id = ?,
                 target_entity_id = ?,
                 metadata_json = ?,
                 settlement_id = ?,
                 op_index = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(
            params.salience ?? null,
            params.targetEntityId ?? null,
            params.targetEntityId ?? null,
            metadataJson,
            params.settlementId,
            params.opIndex,
            now,
            existing.id,
          );
        return { id: existing.id };
      }
    }

    const result = this.db
      .prepare(
        `INSERT INTO agent_event_overlay (
           event_id,
           agent_id,
           role,
           private_notes,
           salience,
           emotion,
           event_category,
           primary_actor_entity_id,
           projection_class,
           location_entity_id,
           target_entity_id,
           projectable_summary,
           source_record_id,
           cognition_key,
           explicit_kind,
           settlement_id,
           op_index,
           metadata_json,
           cognition_status,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        null,
        params.agentId,
        null,
        null,
        params.salience ?? null,
        null,
        "thought",
        params.targetEntityId ?? null,
        "none",
        null,
        params.targetEntityId ?? null,
        null,
        null,
        cognitionKey ?? null,
        "commitment",
        params.settlementId,
        params.opIndex,
        metadataJson,
        now,
        now,
      );
    return { id: Number(result.lastInsertRowid) };
  }

  retractCognition(
    agentId: string,
    cognitionKey: string,
    kind?: "assertion" | "evaluation" | "commitment",
  ): void {
    const normalizedKey = cognitionKey.normalize("NFC");
    const now = Date.now();

    if (kind === "assertion") {
      this.db
        .prepare(
          `UPDATE agent_fact_overlay
           SET stance = 'rejected',
               epistemic_status = 'retracted',
               updated_at = ?
           WHERE agent_id = ? AND cognition_key = ?`,
        )
        .run(now, agentId, normalizedKey);
      return;
    }

    if (kind === "evaluation" || kind === "commitment") {
      this.db
        .prepare(
          `UPDATE agent_event_overlay
           SET cognition_status = 'retracted',
               updated_at = ?
           WHERE agent_id = ? AND cognition_key = ? AND explicit_kind = ?`,
        )
        .run(now, agentId, normalizedKey, kind);
      return;
    }

    this.db
      .prepare(
        `UPDATE agent_fact_overlay
         SET stance = 'rejected',
             epistemic_status = 'retracted',
             updated_at = ?
         WHERE agent_id = ? AND cognition_key = ?`,
      )
      .run(now, agentId, normalizedKey);
    this.db
      .prepare(
        `UPDATE agent_event_overlay
         SET cognition_status = 'retracted',
             updated_at = ?
         WHERE agent_id = ? AND cognition_key = ?`,
      )
      .run(now, agentId, normalizedKey);
  }

  getAssertions(agentId: string, options?: { activeOnly?: boolean }): CanonicalAssertionRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, source_entity_id, target_entity_id, predicate,
                belief_type, epistemic_status, basis, stance, pre_contested_stance,
                provenance, source_event_ref, cognition_key, settlement_id, op_index,
                created_at, updated_at
         FROM agent_fact_overlay
         WHERE agent_id = ?
         ORDER BY updated_at DESC
         LIMIT 500`,
      )
      .all(agentId) as FactOverlayRow[];

    const mapped = rows
      .map((row) => this.toCanonicalAssertion(row))
      .filter((row): row is CanonicalAssertionRow => row !== null);

    if (!options?.activeOnly) {
      return mapped;
    }
    return mapped.filter((row) => row.stance !== "rejected" && row.stance !== "abandoned");
  }

  getEvaluations(agentId: string, options?: { activeOnly?: boolean }): CanonicalEvaluationRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, explicit_kind, settlement_id, op_index,
                salience, primary_actor_entity_id, target_entity_id, metadata_json,
                cognition_status, created_at, updated_at
         FROM agent_event_overlay
         WHERE agent_id = ? AND explicit_kind = 'evaluation'
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 500`,
      )
      .all(agentId) as EventOverlayRow[];

    const mapped = rows.map((row) => this.toCanonicalEvaluation(row));
    if (!options?.activeOnly) {
      return mapped;
    }
    return mapped.filter((row) => row.status === "active");
  }

  getCommitments(agentId: string, options?: { activeOnly?: boolean }): CanonicalCommitmentRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, explicit_kind, settlement_id, op_index,
                salience, primary_actor_entity_id, target_entity_id, metadata_json,
                cognition_status, created_at, updated_at
         FROM agent_event_overlay
         WHERE agent_id = ? AND explicit_kind = 'commitment'
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 500`,
      )
      .all(agentId) as EventOverlayRow[];

    const mapped = rows.map((row) => this.toCanonicalCommitment(row));
    if (!options?.activeOnly) {
      return mapped;
    }
    return mapped.filter((row) => row.status === "active");
  }

  getAssertionByKey(agentId: string, cognitionKey: string): CanonicalAssertionRow | null {
    const row = this.db
      .prepare(
        `SELECT id, agent_id, source_entity_id, target_entity_id, predicate,
                belief_type, epistemic_status, basis, stance, pre_contested_stance,
                provenance, source_event_ref, cognition_key, settlement_id, op_index,
                created_at, updated_at
         FROM agent_fact_overlay
         WHERE agent_id = ? AND cognition_key = ?
         LIMIT 1`,
      )
      .get(agentId, cognitionKey.normalize("NFC")) as FactOverlayRow | null;
    if (!row) return null;
    return this.toCanonicalAssertion(row);
  }

  getEvaluationByKey(agentId: string, cognitionKey: string): CanonicalEvaluationRow | null {
    const row = this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, explicit_kind, settlement_id, op_index,
                salience, primary_actor_entity_id, target_entity_id, metadata_json,
                cognition_status, created_at, updated_at
         FROM agent_event_overlay
         WHERE agent_id = ? AND cognition_key = ? AND explicit_kind = 'evaluation'
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 1`,
      )
      .get(agentId, cognitionKey.normalize("NFC")) as EventOverlayRow | null;
    if (!row) return null;
    return this.toCanonicalEvaluation(row);
  }

  getCommitmentByKey(agentId: string, cognitionKey: string): CanonicalCommitmentRow | null {
    const row = this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, explicit_kind, settlement_id, op_index,
                salience, primary_actor_entity_id, target_entity_id, metadata_json,
                cognition_status, created_at, updated_at
         FROM agent_event_overlay
         WHERE agent_id = ? AND cognition_key = ? AND explicit_kind = 'commitment'
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 1`,
      )
      .get(agentId, cognitionKey.normalize("NFC")) as EventOverlayRow | null;
    if (!row) return null;
    return this.toCanonicalCommitment(row);
  }

  backfillLegacyRows(agentId: string): void {
    this.db
      .prepare(
        `UPDATE agent_fact_overlay
         SET stance = CASE epistemic_status
             WHEN 'confirmed' THEN 'confirmed'
             WHEN 'suspected' THEN 'tentative'
             WHEN 'hypothetical' THEN 'hypothetical'
             WHEN 'retracted' THEN 'rejected'
             ELSE stance END,
             basis = CASE belief_type
             WHEN 'observation' THEN 'first_hand'
             WHEN 'inference' THEN 'inference'
             WHEN 'suspicion' THEN 'inference'
             WHEN 'intention' THEN 'introspection'
             ELSE basis END,
             updated_at = ?
         WHERE agent_id = ? AND (stance IS NULL OR basis IS NULL)`,
      )
      .run(Date.now(), agentId);
  }

  private resolveEntityByPointerKey(pointerKey: string, agentId: string): number | null {
    const normalizedPointerKey = pointerKey.normalize("NFC");
    const row = this.db
      .prepare(
        `SELECT id
         FROM entity_nodes
         WHERE pointer_key = ?
           AND (
             (memory_scope = 'private_overlay' AND owner_agent_id = ?)
             OR memory_scope = 'shared_public'
           )
         ORDER BY CASE WHEN memory_scope = 'private_overlay' THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(normalizedPointerKey, agentId) as { id: number } | null;

    return row?.id ?? null;
  }

  private toCanonicalAssertion(row: FactOverlayRow): CanonicalAssertionRow | null {
    const stance = row.stance ?? (row.epistemic_status ? EPISTEMIC_STATUS_TO_STANCE[row.epistemic_status] : undefined);
    if (!stance) {
      return null;
    }
    const basis = row.basis ?? (row.belief_type ? BELIEF_TYPE_TO_BASIS[row.belief_type] : undefined) ?? null;
    return {
      id: row.id,
      agentId: row.agent_id,
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      predicate: row.predicate,
      cognitionKey: row.cognition_key,
      settlementId: row.settlement_id,
      opIndex: row.op_index,
      provenance: row.provenance,
      sourceEventRef: row.source_event_ref,
      stance,
      basis,
      preContestedStance: row.pre_contested_stance,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toCanonicalEvaluation(row: EventOverlayRow): CanonicalEvaluationRow {
    const parsed = safeParseJson(row.metadata_json);
    return {
      id: row.id,
      agentId: row.agent_id,
      cognitionKey: row.cognition_key,
      settlementId: row.settlement_id,
      opIndex: row.op_index,
      salience: row.salience,
      targetEntityId: row.target_entity_id ?? row.primary_actor_entity_id,
      dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions : [],
      emotionTags: Array.isArray(parsed.emotionTags) ? parsed.emotionTags : [],
      notes: typeof parsed.notes === "string" ? parsed.notes : null,
      status: row.cognition_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toCanonicalCommitment(row: EventOverlayRow): CanonicalCommitmentRow {
    const parsed = safeParseJson(row.metadata_json);
    return {
      id: row.id,
      agentId: row.agent_id,
      cognitionKey: row.cognition_key,
      settlementId: row.settlement_id,
      opIndex: row.op_index,
      salience: row.salience,
      targetEntityId: row.target_entity_id ?? row.primary_actor_entity_id,
      mode: asCommitmentMode(parsed.mode),
      target: parsed.target,
      commitmentStatus: asCommitmentStatus(parsed.status),
      priority: typeof parsed.priority === "number" ? parsed.priority : null,
      horizon: asCommitmentHorizon(parsed.horizon),
      status: row.cognition_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function safeParseJson(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asCommitmentMode(value: unknown): "goal" | "intent" | "plan" | "constraint" | "avoidance" {
  if (value === "goal" || value === "intent" || value === "plan" || value === "constraint" || value === "avoidance") {
    return value;
  }
  return "goal";
}

function asCommitmentStatus(value: unknown): "active" | "paused" | "fulfilled" | "abandoned" {
  if (value === "active" || value === "paused" || value === "fulfilled" || value === "abandoned") {
    return value;
  }
  return "active";
}

function asCommitmentHorizon(value: unknown): "immediate" | "near" | "long" | null {
  if (value === "immediate" || value === "near" || value === "long") {
    return value;
  }
  return null;
}

export type {
  CanonicalAssertionRow,
  CanonicalCommitmentRow,
  CanonicalEvaluationRow,
  UpsertAssertionParams,
  UpsertCommitmentParams,
  UpsertEvaluationParams,
};
