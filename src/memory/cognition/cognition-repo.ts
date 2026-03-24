import { MaidsClawError } from "../../core/errors.js";
import type { AssertionBasis, AssertionStance, CognitionKind } from "../../runtime/rp-turn-contract.js";
import { CognitionEventRepo } from "./cognition-event-repo.js";
import { RelationBuilder } from "./relation-builder.js";
import {
  TERMINAL_STANCES,
  assertLegalStanceTransition,
  assertBasisUpgradeOnly,
} from "./belief-revision.js";
import type { ExistingAssertionState } from "./belief-revision.js";

type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

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
  basis: AssertionBasis | null;
  stance: AssertionStance | null;
  pre_contested_stance: AssertionStance | null;
  provenance: string | null;
  source_event_ref: string | null;
  "cognition_key": string | null;
  settlement_id: string | null;
  op_index: number | null;
  created_at: number;
  updated_at: number;
};

type CognitionCurrentRow = {
  id: number;
  agent_id: string;
  "cognition_key": string;
  kind: "assertion" | "evaluation" | "commitment";
  stance: AssertionStance | null;
  basis: AssertionBasis | null;
  status: "active" | "retracted";
  pre_contested_stance: AssertionStance | null;
  summary_text: string | null;
  record_json: string;
  source_event_id: number;
  updated_at: number;
};

type AssertionProjectionRecord = {
  sourcePointerKey?: string;
  predicate?: string;
  targetPointerKey?: string;
  stance?: AssertionStance;
  basis?: AssertionBasis;
  preContestedStance?: AssertionStance;
  provenance?: string;
};



export class CognitionRepository {
  private readonly relationBuilder: RelationBuilder;
  private readonly eventRepo: CognitionEventRepo;

  constructor(private readonly db: DbLike) {
    this.relationBuilder = new RelationBuilder(db);
    this.eventRepo = new CognitionEventRepo(db);
  }

  getEventRepo(): CognitionEventRepo {
    return this.eventRepo;
  }

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

    if (params.stance === "contested" && !params.preContestedStance) {
      throw new MaidsClawError({
        code: "COGNITION_MISSING_PRE_CONTESTED_STANCE",
        message: "contested assertion writes must include preContestedStance",
        retriable: false,
        details: { cognitionKey, stance: params.stance },
      });
    }

    const recordJson = JSON.stringify({
      sourcePointerKey: params.sourcePointerKey,
      predicate: params.predicate,
      targetPointerKey: params.targetPointerKey,
      stance: params.stance,
      basis: params.basis ?? null,
      preContestedStance: params.preContestedStance ?? null,
      provenance: params.provenance ?? null,
    });

    if (cognitionKey) {
      const existing = this.db
        .prepare(
          `SELECT id, stance, basis, pre_contested_stance as preContestedStance FROM agent_fact_overlay
           WHERE agent_id = ? AND cognition_key = ?`,
        )
        .get(params.agentId, cognitionKey) as ExistingAssertionState | null;

      if (existing?.stance && TERMINAL_STANCES.has(existing.stance)) {
        throw new MaidsClawError({
          code: "COGNITION_TERMINAL_KEY_REUSE",
          message: "terminal assertion keys cannot be reused; create a new cognition key",
          retriable: false,
          details: {
            cognitionKey,
            currentStance: existing.stance,
            targetStance: params.stance,
          },
        });
      }

      if (existing?.stance && params.stance !== existing.stance) {
        assertLegalStanceTransition(existing, params.stance, cognitionKey);
      }

      if (existing) {
        assertBasisUpgradeOnly(existing.basis, params.basis, cognitionKey);
      }

      if (existing) {
        return this.runInTransaction(() => {
          this.db
            .prepare(
              `UPDATE agent_fact_overlay
               SET source_entity_id = ?,
                   target_entity_id = ?,
                   predicate = ?,
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
              params.basis ?? null,
              params.stance,
              params.preContestedStance ?? null,
              params.provenance ?? null,
              params.settlementId,
              params.opIndex,
              now,
              existing.id,
            );
          this.syncCognitionSearchDoc({
            overlayId: existing.id,
            agentId: params.agentId,
            kind: "assertion",
            content: `${params.predicate}: ${params.sourcePointerKey} → ${params.targetPointerKey}`,
            stance: params.stance,
            basis: params.basis ?? null,
            sourceRefKind: "assertion",
            now,
          });
          if (params.stance === "contested") {
            this.relationBuilder.writeContestRelations(
              `assertion:${existing.id}`,
              [],
              params.settlementId,
              0.8,
            );
          }
          const eventId = this.eventRepo.append({
            agentId: params.agentId,
            cognitionKey,
            kind: "assertion",
            op: "upsert",
            recordJson,
            settlementId: params.settlementId,
            committedTime: now,
          });
          this.syncAssertionCurrentProjection({
            agentId: params.agentId,
            cognitionKey,
            stance: params.stance,
            basis: params.basis ?? null,
            preContestedStance: params.preContestedStance ?? null,
            recordJson,
            sourceEventId: eventId,
            updatedAt: now,
          });
          return { id: existing.id };
        });
      }

      return this.runInTransaction(() => {
        const result = this.db
          .prepare(
            `INSERT INTO agent_fact_overlay (
               agent_id,
               source_entity_id,
               target_entity_id,
               predicate,
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
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            params.agentId,
            sourceEntityId,
            targetEntityId,
            params.predicate,
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
        const insertedId = Number(result.lastInsertRowid);
        this.syncCognitionSearchDoc({
          overlayId: insertedId,
          agentId: params.agentId,
          kind: "assertion",
          content: `${params.predicate}: ${params.sourcePointerKey} → ${params.targetPointerKey}`,
          stance: params.stance,
          basis: params.basis ?? null,
          sourceRefKind: "assertion",
          now,
        });
        if (params.stance === "contested") {
          this.relationBuilder.writeContestRelations(
            `assertion:${insertedId}`,
            [],
            params.settlementId,
            0.8,
          );
        }
        const eventId = this.eventRepo.append({
          agentId: params.agentId,
          cognitionKey,
          kind: "assertion",
          op: "upsert",
          recordJson,
          settlementId: params.settlementId,
          committedTime: now,
        });
        this.syncAssertionCurrentProjection({
          agentId: params.agentId,
          cognitionKey,
          stance: params.stance,
          basis: params.basis ?? null,
          preContestedStance: params.preContestedStance ?? null,
          recordJson,
          sourceEventId: eventId,
          updatedAt: now,
        });
        return { id: insertedId };
      });
    }

    return this.runInTransaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO agent_fact_overlay (
             agent_id,
             source_entity_id,
             target_entity_id,
             predicate,
             basis,
             stance,
             pre_contested_stance,
             provenance,
             source_event_ref,
             settlement_id,
             op_index,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          params.agentId,
          sourceEntityId,
          targetEntityId,
          params.predicate,
          params.basis ?? null,
          params.stance,
          params.preContestedStance ?? null,
          params.provenance ?? null,
          params.settlementId,
          params.opIndex,
          now,
          now,
        );
      const insertedId = Number(result.lastInsertRowid);
      this.syncCognitionSearchDoc({
        overlayId: insertedId,
        agentId: params.agentId,
        kind: "assertion",
        content: `${params.predicate}: ${params.sourcePointerKey} → ${params.targetPointerKey}`,
        stance: params.stance,
        basis: params.basis ?? null,
        sourceRefKind: "assertion",
        now,
      });
      this.eventRepo.append({
        agentId: params.agentId,
        cognitionKey: `__anon_assertion_${insertedId}`,
        kind: "assertion",
        op: "upsert",
        recordJson,
        settlementId: params.settlementId,
        committedTime: now,
      });
      return { id: insertedId };
    });
  }

  upsertEvaluation(params: UpsertEvaluationParams): { id: number } {
    const now = Date.now();
    const cognitionKey = params.cognitionKey?.normalize("NFC");
    const eventRecordPayload = {
      dimensions: params.dimensions,
      emotionTags: params.emotionTags ?? [],
      notes: params.notes ?? null,
      salience: params.salience ?? null,
      targetEntityId: params.targetEntityId ?? null,
      settlementId: params.settlementId,
      opIndex: params.opIndex,
    };

    if (cognitionKey) {
      const existing = this.db
        .prepare(
          `SELECT id, record_json FROM private_cognition_current
           WHERE agent_id = ? AND cognition_key = ? AND kind = 'evaluation'
           LIMIT 1`,
        )
        .get(params.agentId, cognitionKey) as { id: number; record_json: string } | null;
      if (existing) {
        return this.runInTransaction(() => {
          const existingRecord = safeParseJson(existing.record_json);
          const createdAt = typeof existingRecord.createdAt === "number" ? existingRecord.createdAt : now;
          const eventRecordJson = JSON.stringify({ ...eventRecordPayload, createdAt });
          const eventId = this.eventRepo.append({
            agentId: params.agentId,
            cognitionKey,
            kind: "evaluation",
            op: "upsert",
            recordJson: eventRecordJson,
            settlementId: params.settlementId,
            committedTime: now,
          });
          const summaryText = `evaluation: ${params.notes ?? ""}`;

          this.db
            .prepare(
              `UPDATE private_cognition_current
               SET kind = 'evaluation',
                   stance = NULL,
                   basis = NULL,
                   status = 'active',
                   pre_contested_stance = NULL,
                   summary_text = ?,
                   record_json = ?,
                   source_event_id = ?,
                   updated_at = ?
                WHERE id = ?`,
            )
            .run(
              summaryText,
              eventRecordJson,
              eventId,
              now,
              existing.id,
            );
          this.syncCognitionSearchDoc({
            overlayId: existing.id,
            agentId: params.agentId,
            kind: "evaluation",
            content: summaryText,
            stance: null,
            basis: null,
            sourceRefKind: "evaluation",
            now,
          });
          return { id: existing.id };
        });
      }
    }

    return this.runInTransaction(() => {
      const effectiveKey = cognitionKey ?? `__anon_evaluation__${params.settlementId}:${params.opIndex}:${now}`;
      const eventRecordJson = JSON.stringify({ ...eventRecordPayload, createdAt: now });
      const eventId = this.eventRepo.append({
        agentId: params.agentId,
        cognitionKey: effectiveKey,
        kind: "evaluation",
        op: "upsert",
        recordJson: eventRecordJson,
        settlementId: params.settlementId,
        committedTime: now,
      });
      const summaryText = `evaluation: ${params.notes ?? ""}`;
      const result = this.db
        .prepare(
          `INSERT INTO private_cognition_current (
             agent_id,
             cognition_key,
             kind,
             stance,
             basis,
             status,
             pre_contested_stance,
             summary_text,
             record_json,
             source_event_id,
             updated_at
           ) VALUES (?, ?, 'evaluation', NULL, NULL, 'active', NULL, ?, ?, ?, ?)`,
        )
        .run(params.agentId, effectiveKey, summaryText, eventRecordJson, eventId, now);
      const evalId = Number(result.lastInsertRowid);
      this.syncCognitionSearchDoc({
        overlayId: evalId,
        agentId: params.agentId,
        kind: "evaluation",
        content: summaryText,
        stance: null,
        basis: null,
        sourceRefKind: "evaluation",
        now,
      });
      return { id: evalId };
    });
  }

  upsertCommitment(params: UpsertCommitmentParams): { id: number } {
    const now = Date.now();
    const cognitionKey = params.cognitionKey?.normalize("NFC");
    const eventRecordPayload = {
      mode: params.mode,
      target: params.target,
      status: params.status,
      priority: params.priority ?? null,
      horizon: params.horizon ?? null,
      salience: params.salience ?? null,
      targetEntityId: params.targetEntityId ?? null,
      settlementId: params.settlementId,
      opIndex: params.opIndex,
    };

    if (cognitionKey) {
      const existing = this.db
        .prepare(
          `SELECT id, record_json FROM private_cognition_current
           WHERE agent_id = ? AND cognition_key = ? AND kind = 'commitment'
           LIMIT 1`,
        )
        .get(params.agentId, cognitionKey) as { id: number; record_json: string } | null;
      if (existing) {
        return this.runInTransaction(() => {
          const existingRecord = safeParseJson(existing.record_json);
          const createdAt = typeof existingRecord.createdAt === "number" ? existingRecord.createdAt : now;
          const eventRecordJson = JSON.stringify({ ...eventRecordPayload, createdAt });
          const eventId = this.eventRepo.append({
            agentId: params.agentId,
            cognitionKey,
            kind: "commitment",
            op: "upsert",
            recordJson: eventRecordJson,
            settlementId: params.settlementId,
            committedTime: now,
          });
          const summaryText = `${params.mode}: ${JSON.stringify(params.target)}`;

          this.db
            .prepare(
              `UPDATE private_cognition_current
               SET kind = 'commitment',
                   stance = NULL,
                   basis = NULL,
                   status = 'active',
                   pre_contested_stance = NULL,
                   summary_text = ?,
                   record_json = ?,
                   source_event_id = ?,
                   updated_at = ?
                WHERE id = ?`,
            )
            .run(
              summaryText,
              eventRecordJson,
              eventId,
              now,
              existing.id,
            );
          this.syncCognitionSearchDoc({
            overlayId: existing.id,
            agentId: params.agentId,
            kind: "commitment",
            content: summaryText,
            stance: null,
            basis: null,
            sourceRefKind: "commitment",
            now,
          });
          return { id: existing.id };
        });
      }
    }

    return this.runInTransaction(() => {
      const effectiveKey = cognitionKey ?? `__anon_commitment__${params.settlementId}:${params.opIndex}:${now}`;
      const eventRecordJson = JSON.stringify({ ...eventRecordPayload, createdAt: now });
      const eventId = this.eventRepo.append({
        agentId: params.agentId,
        cognitionKey: effectiveKey,
        kind: "commitment",
        op: "upsert",
        recordJson: eventRecordJson,
        settlementId: params.settlementId,
        committedTime: now,
      });
      const summaryText = `${params.mode}: ${JSON.stringify(params.target)}`;
      const result = this.db
        .prepare(
          `INSERT INTO private_cognition_current (
             agent_id,
             cognition_key,
             kind,
             stance,
             basis,
             status,
             pre_contested_stance,
             summary_text,
             record_json,
             source_event_id,
             updated_at
           ) VALUES (?, ?, 'commitment', NULL, NULL, 'active', NULL, ?, ?, ?, ?)`,
        )
        .run(params.agentId, effectiveKey, summaryText, eventRecordJson, eventId, now);
      const commitId = Number(result.lastInsertRowid);
      this.syncCognitionSearchDoc({
        overlayId: commitId,
        agentId: params.agentId,
        kind: "commitment",
        content: summaryText,
        stance: null,
        basis: null,
        sourceRefKind: "commitment",
        now,
      });
      return { id: commitId };
    });
  }

  retractCognition(
    agentId: string,
    cognitionKey: string,
    kind?: "assertion" | "evaluation" | "commitment",
    settlementId?: string,
  ): void {
    const normalizedKey = cognitionKey.normalize("NFC");
    const now = Date.now();
    const effectiveSettlementId = settlementId ?? "__retract__";

    if (kind === "assertion") {
      this.runInTransaction(() => {
        const eventId = this.eventRepo.append({
          agentId,
          cognitionKey: normalizedKey,
          kind: "assertion",
          op: "retract",
          recordJson: null,
          settlementId: effectiveSettlementId,
          committedTime: now,
        });
        this.db
          .prepare(
            `UPDATE agent_fact_overlay
             SET stance = 'rejected',
                 updated_at = ?
             WHERE agent_id = ? AND cognition_key = ?`,
          )
          .run(now, agentId, normalizedKey);
        this.db
          .prepare(
            `UPDATE private_cognition_current
             SET status = 'retracted',
                 stance = 'rejected',
                 source_event_id = ?,
                 updated_at = ?
             WHERE agent_id = ? AND cognition_key = ? AND kind = 'assertion'`,
          )
          .run(eventId, now, agentId, normalizedKey);
        this.updateCognitionSearchDocStance(agentId, "assertion", normalizedKey, "rejected", now);
      });
      return;
    }

    if (kind === "evaluation" || kind === "commitment") {
      this.runInTransaction(() => {
        this.eventRepo.append({
          agentId,
          cognitionKey: normalizedKey,
          kind,
          op: "retract",
          recordJson: null,
          settlementId: effectiveSettlementId,
          committedTime: now,
        });
        this.db
          .prepare(
            `UPDATE private_cognition_current
             SET status = 'retracted',
                  updated_at = ?
             WHERE agent_id = ? AND cognition_key = ? AND kind = ?`,
          )
          .run(now, agentId, normalizedKey, kind);
        this.updateCognitionSearchDocStance(agentId, kind, normalizedKey, "abandoned", now);
      });
      return;
    }

    this.runInTransaction(() => {
      this.db
        .prepare(
          `UPDATE agent_fact_overlay
           SET stance = 'rejected',
               updated_at = ?
           WHERE agent_id = ? AND cognition_key = ?`,
        )
        .run(now, agentId, normalizedKey);
      this.db
        .prepare(
          `UPDATE private_cognition_current
           SET status = 'retracted',
                stance = CASE WHEN kind = 'assertion' THEN 'rejected' ELSE stance END,
                updated_at = ?
           WHERE agent_id = ? AND cognition_key = ? AND kind IN ('assertion', 'evaluation', 'commitment')`,
        )
        .run(now, agentId, normalizedKey);
      this.updateCognitionSearchDocStance(agentId, "assertion", normalizedKey, "rejected", now);
      this.updateCognitionSearchDocStance(agentId, "evaluation", normalizedKey, "abandoned", now);
      this.updateCognitionSearchDocStance(agentId, "commitment", normalizedKey, "abandoned", now);
      this.eventRepo.append({
        agentId,
        cognitionKey: normalizedKey,
        kind: kind ?? "assertion",
        op: "retract",
        recordJson: null,
        settlementId: effectiveSettlementId,
        committedTime: now,
      });
    });
  }

  getAssertions(
    agentId: string,
    options?: { activeOnly?: boolean; stance?: AssertionStance; basis?: AssertionBasis },
  ): CanonicalAssertionRow[] {
    const keyedRows = this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, kind, stance, basis, status,
                pre_contested_stance, summary_text, record_json, source_event_id, updated_at
         FROM private_cognition_current
         WHERE agent_id = ? AND kind = 'assertion'
         ORDER BY updated_at DESC
         LIMIT 500`,
      )
      .all(agentId) as CognitionCurrentRow[];

    const rows = this.db
      .prepare(
        `SELECT id, agent_id, source_entity_id, target_entity_id, predicate,
                basis, stance, pre_contested_stance,
                provenance, source_event_ref, cognition_key, settlement_id, op_index,
                created_at, updated_at
         FROM agent_fact_overlay
         WHERE agent_id = ? AND cognition_key IS NULL
         ORDER BY updated_at DESC
         LIMIT 500`,
      )
      .all(agentId) as FactOverlayRow[];

    const keyedMapped = keyedRows
      .map((row) => this.toCanonicalAssertionFromProjection(row))
      .filter((row): row is CanonicalAssertionRow => row !== null);

    const unkeyedMapped = rows
      .map((row) => this.toCanonicalAssertion(row))
      .filter((row): row is CanonicalAssertionRow => row !== null);

    let mapped = [...keyedMapped, ...unkeyedMapped].sort((a, b) => b.updatedAt - a.updatedAt);

    if (options?.activeOnly) {
      mapped = mapped.filter((row) => row.stance !== "rejected" && row.stance !== "abandoned");
    }
    if (options?.stance) {
      mapped = mapped.filter((row) => row.stance === options.stance);
    }
    if (options?.basis) {
      mapped = mapped.filter((row) => row.basis === options.basis);
    }
    return mapped;
  }

  getEvaluations(agentId: string, options?: { activeOnly?: boolean }): CanonicalEvaluationRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, kind, stance, basis, status,
                pre_contested_stance, summary_text, record_json, source_event_id, updated_at
         FROM private_cognition_current
         WHERE agent_id = ? AND kind = 'evaluation'
         ORDER BY updated_at DESC
         LIMIT 500`,
      )
      .all(agentId) as CognitionCurrentRow[];

    const mapped = rows.map((row) => this.toCanonicalEvaluation(row));
    if (!options?.activeOnly) {
      return mapped;
    }
    return mapped.filter((row) => row.status === "active");
  }

  getCommitments(
    agentId: string,
    options?: { activeOnly?: boolean; mode?: string },
  ): CanonicalCommitmentRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, kind, stance, basis, status,
                pre_contested_stance, summary_text, record_json, source_event_id, updated_at
         FROM private_cognition_current
         WHERE agent_id = ? AND kind = 'commitment'
         ORDER BY updated_at DESC
         LIMIT 500`,
      )
      .all(agentId) as CognitionCurrentRow[];

    let mapped = rows.map((row) => this.toCanonicalCommitment(row));
    if (options?.activeOnly) {
      mapped = mapped.filter((row) => row.status === "active");
    }
    if (options?.mode) {
      mapped = mapped.filter((row) => row.mode === options.mode);
    }
    return mapped;
  }

  getAssertionByKey(agentId: string, cognitionKey: string): CanonicalAssertionRow | null {
    const keyed = this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, kind, stance, basis, status,
                pre_contested_stance, summary_text, record_json, source_event_id, updated_at
         FROM private_cognition_current
         WHERE agent_id = ? AND cognition_key = ? AND kind = 'assertion'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(agentId, cognitionKey.normalize("NFC")) as CognitionCurrentRow | null;
    if (keyed) {
      return this.toCanonicalAssertionFromProjection(keyed);
    }

    const row = this.db
      .prepare(
        `SELECT id, agent_id, source_entity_id, target_entity_id, predicate,
                basis, stance, pre_contested_stance,
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
        `SELECT id, agent_id, cognition_key, kind, stance, basis, status,
                pre_contested_stance, summary_text, record_json, source_event_id, updated_at
         FROM private_cognition_current
         WHERE agent_id = ? AND cognition_key = ? AND kind = 'evaluation'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(agentId, cognitionKey.normalize("NFC")) as CognitionCurrentRow | null;
    if (!row) return null;
    return this.toCanonicalEvaluation(row);
  }

  getCommitmentByKey(agentId: string, cognitionKey: string): CanonicalCommitmentRow | null {
    const row = this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, kind, stance, basis, status,
                pre_contested_stance, summary_text, record_json, source_event_id, updated_at
         FROM private_cognition_current
         WHERE agent_id = ? AND cognition_key = ? AND kind = 'commitment'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(agentId, cognitionKey.normalize("NFC")) as CognitionCurrentRow | null;
    if (!row) return null;
    return this.toCanonicalCommitment(row);
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
    if (!row.stance) {
      return null;
    }
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
      stance: row.stance,
      basis: row.basis ?? null,
      preContestedStance: row.pre_contested_stance,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private syncAssertionCurrentProjection(input: {
    agentId: string;
    cognitionKey: string;
    stance: AssertionStance;
    basis: AssertionBasis | null;
    preContestedStance: AssertionStance | null;
    recordJson: string;
    sourceEventId: number;
    updatedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO private_cognition_current (
           agent_id,
           cognition_key,
           kind,
           stance,
           basis,
           status,
           pre_contested_stance,
           summary_text,
           record_json,
           source_event_id,
           updated_at
         ) VALUES (?, ?, 'assertion', ?, ?, 'active', ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, cognition_key) DO UPDATE SET
           kind = 'assertion',
           stance = excluded.stance,
           basis = excluded.basis,
           status = 'active',
           pre_contested_stance = excluded.pre_contested_stance,
           summary_text = excluded.summary_text,
           record_json = excluded.record_json,
           source_event_id = excluded.source_event_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.agentId,
        input.cognitionKey,
        input.stance,
        input.basis,
        input.preContestedStance,
        safeParseJson(input.recordJson).predicate as string | undefined
          ? `${String(safeParseJson(input.recordJson).predicate)}: ${String(safeParseJson(input.recordJson).sourcePointerKey ?? "?")} → ${String(safeParseJson(input.recordJson).targetPointerKey ?? "?")}`
          : null,
        input.recordJson,
        input.sourceEventId,
        input.updatedAt,
      );
  }

  private toCanonicalAssertionFromProjection(row: CognitionCurrentRow): CanonicalAssertionRow | null {
    if (!row.stance) {
      return null;
    }
    const parsed = safeParseJson(row.record_json) as AssertionProjectionRecord;
    const sourceEntityId = typeof parsed.sourcePointerKey === "string"
      ? this.resolveEntityByPointerKey(parsed.sourcePointerKey, row.agent_id)
      : null;
    const targetEntityId = typeof parsed.targetPointerKey === "string"
      ? this.resolveEntityByPointerKey(parsed.targetPointerKey, row.agent_id)
      : null;
    if (sourceEntityId == null || targetEntityId == null || typeof parsed.predicate !== "string") {
      return null;
    }

    const projectionRecord = safeParseJson(row.record_json);
    return {
      id: row.id,
      agentId: row.agent_id,
      sourceEntityId,
      targetEntityId,
      predicate: parsed.predicate,
      cognitionKey: row.cognition_key,
      settlementId: typeof projectionRecord.settlementId === "string" ? projectionRecord.settlementId : null,
      opIndex: typeof projectionRecord.opIndex === "number" ? projectionRecord.opIndex : null,
      provenance: typeof parsed.provenance === "string" ? parsed.provenance : null,
      sourceEventRef: null,
      stance: row.stance,
      basis: row.basis ?? null,
      preContestedStance: row.pre_contested_stance,
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    };
  }

  private toCanonicalEvaluation(row: CognitionCurrentRow): CanonicalEvaluationRow {
    const parsed = safeParseJson(row.record_json);
    return {
      id: row.id,
      agentId: row.agent_id,
      cognitionKey: row.cognition_key,
      settlementId: typeof parsed.settlementId === "string" ? parsed.settlementId : null,
      opIndex: typeof parsed.opIndex === "number" ? parsed.opIndex : null,
      salience: typeof parsed.salience === "number" ? parsed.salience : null,
      targetEntityId: typeof parsed.targetEntityId === "number" ? parsed.targetEntityId : null,
      dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions : [],
      emotionTags: Array.isArray(parsed.emotionTags) ? parsed.emotionTags : [],
      notes: typeof parsed.notes === "string" ? parsed.notes : null,
      status: row.status,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : row.updated_at,
      updatedAt: row.updated_at,
    };
  }

  private toCanonicalCommitment(row: CognitionCurrentRow): CanonicalCommitmentRow {
    const parsed = safeParseJson(row.record_json);
    return {
      id: row.id,
      agentId: row.agent_id,
      cognitionKey: row.cognition_key,
      settlementId: typeof parsed.settlementId === "string" ? parsed.settlementId : null,
      opIndex: typeof parsed.opIndex === "number" ? parsed.opIndex : null,
      salience: typeof parsed.salience === "number" ? parsed.salience : null,
      targetEntityId: typeof parsed.targetEntityId === "number" ? parsed.targetEntityId : null,
      mode: asCommitmentMode(parsed.mode),
      target: parsed.target,
      commitmentStatus: asCommitmentStatus(parsed.status),
      priority: typeof parsed.priority === "number" ? parsed.priority : null,
      horizon: asCommitmentHorizon(parsed.horizon),
      status: row.status,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : row.updated_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Search doc sync ──────────────────────────────────────────────────

  private updateCognitionSearchDocStance(
    agentId: string,
    refKind: "assertion" | "evaluation" | "commitment",
    cognitionKey: string,
    newStance: AssertionStance,
    now: number,
  ): void {
    if (refKind === "evaluation" || refKind === "commitment") {
      const eventRows = this.db
        .prepare(
          `SELECT c.id FROM private_cognition_current c
           WHERE c.agent_id = ? AND c.cognition_key = ? AND c.kind = ?`,
        )
        .all(agentId, cognitionKey, refKind) as { id: number }[];

      for (const row of eventRows) {
        // Try canonical ref first, then legacy compat ref — handles transition period
        for (const sourceRef of [`${refKind}:${row.id}`, `private_event:${row.id}`]) {
          this.db
            .prepare(
              `UPDATE search_docs_cognition SET stance = ?, updated_at = ? WHERE source_ref = ? AND agent_id = ?`,
            )
            .run(newStance, now, sourceRef, agentId);
        }
      }
    }

    if (refKind === "assertion") {
      const rows = this.db
        .prepare(
          `SELECT f.id FROM agent_fact_overlay f
           WHERE f.agent_id = ? AND f.cognition_key = ?`,
        )
        .all(agentId, cognitionKey) as { id: number }[];

      for (const row of rows) {
        // Try canonical ref first, then legacy compat ref — handles transition period
        for (const sourceRef of [`assertion:${row.id}`, `private_belief:${row.id}`]) {
          this.db
            .prepare(
              `UPDATE search_docs_cognition SET stance = ?, updated_at = ? WHERE source_ref = ? AND agent_id = ?`,
            )
            .run(newStance, now, sourceRef, agentId);
        }
      }
    }
  }

  private syncCognitionSearchDoc(params: {
    overlayId: number;
    agentId: string;
    kind: CognitionKind;
    content: string;
    stance: AssertionStance | null;
    basis: AssertionBasis | null;
    sourceRefKind: "assertion" | "evaluation" | "commitment";
    now: number;
  }): void {
    const sourceRef = `${params.sourceRefKind}:${params.overlayId}`;
    const docType = params.sourceRefKind;

    const existing = this.db
      .prepare(`SELECT id FROM search_docs_cognition WHERE source_ref = ? AND agent_id = ?`)
      .get(sourceRef, params.agentId) as { id: number } | null;

    const result = this.db
      .prepare(
        `INSERT OR REPLACE INTO search_docs_cognition
         (id, doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        existing?.id ?? null,
        docType,
        sourceRef,
        params.agentId,
        params.kind,
        params.basis ?? null,
        params.stance ?? null,
        params.content,
        params.now,
        params.now,
      );

    const docId = existing?.id ?? Number(result.lastInsertRowid);
    this.db.prepare(`DELETE FROM search_docs_cognition_fts WHERE rowid = ?`).run(docId);
    this.db
      .prepare(`INSERT INTO search_docs_cognition_fts(rowid, content) VALUES (?, ?)`)
      .run(docId, params.content);
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
