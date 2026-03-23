import { MaidsClawError } from "../../core/errors.js";
import {
  BELIEF_TYPE_TO_BASIS,
  EPISTEMIC_STATUS_TO_STANCE,
  type AssertionBasis,
  type AssertionStance,
} from "../../runtime/rp-turn-contract.js";
import type { CognitionKind } from "../../runtime/rp-turn-contract.js";
import { CognitionEventRepo } from "./cognition-event-repo.js";
import { RelationBuilder } from "./relation-builder.js";

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

const TERMINAL_STANCES: ReadonlySet<AssertionStance> = new Set(["rejected", "abandoned"]);

const ALLOWED_STANCE_TRANSITIONS: ReadonlyMap<AssertionStance, ReadonlySet<AssertionStance>> = new Map([
  ["hypothetical", new Set(["tentative", "accepted", "contested", "rejected", "abandoned"])],
  ["tentative", new Set(["accepted", "contested", "rejected", "abandoned"])],
  ["accepted", new Set(["confirmed", "contested", "rejected", "abandoned", "tentative"])],
  ["confirmed", new Set(["accepted", "contested"])],
  ["contested", new Set(["rejected"])],
  ["rejected", new Set()],
  ["abandoned", new Set()],
]);

const ALLOWED_BASIS_UPGRADES = new Set<string>([
  "belief->inference",
  "belief->first_hand",
  "inference->first_hand",
  "hearsay->first_hand",
]);

type ExistingAssertionState = {
  id: number;
  stance: AssertionStance | null;
  basis: AssertionBasis | null;
  preContestedStance: AssertionStance | null;
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

    const legacyStatus = STANCE_TO_EPISTEMIC_STATUS[params.stance];
    const legacyBeliefType = params.basis ? BASIS_TO_BELIEF_TYPE[params.basis] : null;

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
        this.assertLegalStanceTransition(existing, params.stance, cognitionKey);
      }

      if (existing) {
        this.assertBasisUpgradeOnly(existing.basis, params.basis, cognitionKey);
      }

      if (existing) {
        return this.runInTransaction(() => {
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
          this.syncCognitionSearchDoc({
            overlayId: existing.id,
            agentId: params.agentId,
            kind: "assertion",
            content: `${params.predicate}: ${params.sourcePointerKey} → ${params.targetPointerKey}`,
            stance: params.stance,
            basis: params.basis ?? null,
            sourceRefKind: "private_belief",
            now,
          });
          if (params.stance === "contested") {
            this.relationBuilder.writeContestRelations(
              `private_belief:${existing.id}`,
              [],
              params.settlementId,
            );
          }
          this.eventRepo.append({
            agentId: params.agentId,
            cognitionKey,
            kind: "assertion",
            op: "upsert",
            recordJson,
            settlementId: params.settlementId,
            committedTime: now,
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
        const insertedId = Number(result.lastInsertRowid);
        this.syncCognitionSearchDoc({
          overlayId: insertedId,
          agentId: params.agentId,
          kind: "assertion",
          content: `${params.predicate}: ${params.sourcePointerKey} → ${params.targetPointerKey}`,
          stance: params.stance,
          basis: params.basis ?? null,
          sourceRefKind: "private_belief",
          now,
        });
        if (params.stance === "contested") {
          this.relationBuilder.writeContestRelations(
            `private_belief:${insertedId}`,
            [],
            params.settlementId,
          );
        }
        this.eventRepo.append({
          agentId: params.agentId,
          cognitionKey,
          kind: "assertion",
          op: "upsert",
          recordJson,
          settlementId: params.settlementId,
          committedTime: now,
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
      const insertedId = Number(result.lastInsertRowid);
      this.syncCognitionSearchDoc({
        overlayId: insertedId,
        agentId: params.agentId,
        kind: "assertion",
        content: `${params.predicate}: ${params.sourcePointerKey} → ${params.targetPointerKey}`,
        stance: params.stance,
        basis: params.basis ?? null,
        sourceRefKind: "private_belief",
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

  private assertLegalStanceTransition(
    existing: ExistingAssertionState,
    nextStance: AssertionStance,
    cognitionKey: string,
  ): void {
    const currentStance = existing.stance;
    if (!currentStance) {
      return;
    }

    if (currentStance === "contested" && nextStance !== "rejected") {
      if (!existing.preContestedStance) {
        throw new MaidsClawError({
          code: "COGNITION_MISSING_PRE_CONTESTED_STANCE",
          message: "contested rollback requires pre_contested_stance on existing assertion",
          retriable: false,
          details: { cognitionKey, currentStance, targetStance: nextStance },
        });
      }
      if (nextStance === existing.preContestedStance) {
        return;
      }
      throw new MaidsClawError({
        code: "COGNITION_ILLEGAL_STANCE_TRANSITION",
        message: "illegal stance transition",
        retriable: false,
        details: {
          cognitionKey,
          currentStance,
          targetStance: nextStance,
          preContestedStance: existing.preContestedStance,
        },
      });
    }

    const legalTargets = ALLOWED_STANCE_TRANSITIONS.get(currentStance);
    if (legalTargets?.has(nextStance)) {
      return;
    }

    throw new MaidsClawError({
      code: "COGNITION_ILLEGAL_STANCE_TRANSITION",
      message: "illegal stance transition",
      retriable: false,
      details: { cognitionKey, currentStance, targetStance: nextStance },
    });
  }

  private assertBasisUpgradeOnly(
    currentBasis: AssertionBasis | null,
    nextBasis: AssertionBasis | undefined,
    cognitionKey: string,
  ): void {
    if (!currentBasis || !nextBasis || currentBasis === nextBasis) {
      return;
    }

    if (ALLOWED_BASIS_UPGRADES.has(`${currentBasis}->${nextBasis}`)) {
      return;
    }

    throw new MaidsClawError({
      code: "COGNITION_ILLEGAL_BASIS_DOWNGRADE",
      message: "assertion basis change is not an allowed upgrade",
      retriable: false,
      details: { cognitionKey, currentBasis, targetBasis: nextBasis },
    });
  }

  upsertEvaluation(params: UpsertEvaluationParams): { id: number } {
    const now = Date.now();
    const cognitionKey = params.cognitionKey?.normalize("NFC");
    const metadataJson = JSON.stringify({
      dimensions: params.dimensions,
      emotionTags: params.emotionTags ?? [],
      notes: params.notes ?? null,
    });

    const eventRecordJson = JSON.stringify({
      dimensions: params.dimensions,
      emotionTags: params.emotionTags ?? [],
      notes: params.notes ?? null,
      salience: params.salience ?? null,
      targetEntityId: params.targetEntityId ?? null,
    });

    if (cognitionKey) {
      const existing = this.db
        .prepare(
          `SELECT id FROM agent_event_overlay
           WHERE agent_id = ? AND cognition_key = ? AND cognition_status = 'active'`,
        )
        .get(params.agentId, cognitionKey) as { id: number } | null;
      if (existing) {
        return this.runInTransaction(() => {
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
          this.syncCognitionSearchDoc({
            overlayId: existing.id,
            agentId: params.agentId,
            kind: "evaluation",
            content: `evaluation: ${params.notes ?? ""}`,
            stance: null,
            basis: null,
            sourceRefKind: "private_event",
            now,
          });
          this.eventRepo.append({
            agentId: params.agentId,
            cognitionKey,
            kind: "evaluation",
            op: "upsert",
            recordJson: eventRecordJson,
            settlementId: params.settlementId,
            committedTime: now,
          });
          return { id: existing.id };
        });
      }
    }

    return this.runInTransaction(() => {
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
      const evalId = Number(result.lastInsertRowid);
      this.syncCognitionSearchDoc({
        overlayId: evalId,
        agentId: params.agentId,
        kind: "evaluation",
        content: `evaluation: ${params.notes ?? ""}`,
        stance: null,
        basis: null,
        sourceRefKind: "private_event",
        now,
      });
      const effectiveKey = cognitionKey ?? `__anon_evaluation_${evalId}`;
      this.eventRepo.append({
        agentId: params.agentId,
        cognitionKey: effectiveKey,
        kind: "evaluation",
        op: "upsert",
        recordJson: eventRecordJson,
        settlementId: params.settlementId,
        committedTime: now,
      });
      return { id: evalId };
    });
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

    const eventRecordJson = JSON.stringify({
      mode: params.mode,
      target: params.target,
      status: params.status,
      priority: params.priority ?? null,
      horizon: params.horizon ?? null,
      salience: params.salience ?? null,
      targetEntityId: params.targetEntityId ?? null,
    });

    if (cognitionKey) {
      const existing = this.db
        .prepare(
          `SELECT id FROM agent_event_overlay
           WHERE agent_id = ? AND cognition_key = ? AND cognition_status = 'active'`,
        )
        .get(params.agentId, cognitionKey) as { id: number } | null;
      if (existing) {
        return this.runInTransaction(() => {
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
          this.syncCognitionSearchDoc({
            overlayId: existing.id,
            agentId: params.agentId,
            kind: "commitment",
            content: `${params.mode}: ${JSON.stringify(params.target)}`,
            stance: null,
            basis: null,
            sourceRefKind: "private_event",
            now,
          });
          this.eventRepo.append({
            agentId: params.agentId,
            cognitionKey,
            kind: "commitment",
            op: "upsert",
            recordJson: eventRecordJson,
            settlementId: params.settlementId,
            committedTime: now,
          });
          return { id: existing.id };
        });
      }
    }

    return this.runInTransaction(() => {
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
      const commitId = Number(result.lastInsertRowid);
      this.syncCognitionSearchDoc({
        overlayId: commitId,
        agentId: params.agentId,
        kind: "commitment",
        content: `${params.mode}: ${JSON.stringify(params.target)}`,
        stance: null,
        basis: null,
        sourceRefKind: "private_event",
        now,
      });
      const effectiveKey = cognitionKey ?? `__anon_commitment_${commitId}`;
      this.eventRepo.append({
        agentId: params.agentId,
        cognitionKey: effectiveKey,
        kind: "commitment",
        op: "upsert",
        recordJson: eventRecordJson,
        settlementId: params.settlementId,
        committedTime: now,
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
        this.db
          .prepare(
            `UPDATE agent_fact_overlay
             SET stance = 'rejected',
                 epistemic_status = 'retracted',
                 updated_at = ?
             WHERE agent_id = ? AND cognition_key = ?`,
          )
          .run(now, agentId, normalizedKey);
        this.updateCognitionSearchDocStance(agentId, "private_belief", normalizedKey, "rejected", now);
        this.eventRepo.append({
          agentId,
          cognitionKey: normalizedKey,
          kind: "assertion",
          op: "retract",
          recordJson: null,
          settlementId: effectiveSettlementId,
          committedTime: now,
        });
      });
      return;
    }

    if (kind === "evaluation" || kind === "commitment") {
      this.runInTransaction(() => {
        this.db
          .prepare(
            `UPDATE agent_event_overlay
             SET cognition_status = 'retracted',
                 updated_at = ?
             WHERE agent_id = ? AND cognition_key = ? AND explicit_kind = ?`,
          )
          .run(now, agentId, normalizedKey, kind);
        this.updateCognitionSearchDocStance(agentId, "private_event", normalizedKey, "abandoned", now);
        this.eventRepo.append({
          agentId,
          cognitionKey: normalizedKey,
          kind,
          op: "retract",
          recordJson: null,
          settlementId: effectiveSettlementId,
          committedTime: now,
        });
      });
      return;
    }

    this.runInTransaction(() => {
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
      this.updateCognitionSearchDocStance(agentId, "private_belief", normalizedKey, "rejected", now);
      this.updateCognitionSearchDocStance(agentId, "private_event", normalizedKey, "abandoned", now);
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

    let mapped = rows
      .map((row) => this.toCanonicalAssertion(row))
      .filter((row): row is CanonicalAssertionRow => row !== null);

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

  getCommitments(
    agentId: string,
    options?: { activeOnly?: boolean; mode?: string },
  ): CanonicalCommitmentRow[] {
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

  // ── Search doc sync ──────────────────────────────────────────────────

  private updateCognitionSearchDocStance(
    agentId: string,
    refKind: "private_belief" | "private_event",
    cognitionKey: string,
    newStance: AssertionStance,
    now: number,
  ): void {
    const rows = this.db
      .prepare(
        `SELECT f.id FROM agent_fact_overlay f
         WHERE f.agent_id = ? AND f.cognition_key = ?`,
      )
      .all(agentId, cognitionKey) as { id: number }[];

    if (refKind === "private_event") {
      const eventRows = this.db
        .prepare(
          `SELECT e.id FROM agent_event_overlay e
           WHERE e.agent_id = ? AND e.cognition_key = ?`,
        )
        .all(agentId, cognitionKey) as { id: number }[];

      for (const row of eventRows) {
        const sourceRef = `private_event:${row.id}`;
        this.db
          .prepare(
            `UPDATE search_docs_cognition SET stance = ?, updated_at = ? WHERE source_ref = ? AND agent_id = ?`,
          )
          .run(newStance, now, sourceRef, agentId);
      }
    }

    if (refKind === "private_belief") {
      for (const row of rows) {
        const sourceRef = `private_belief:${row.id}`;
        this.db
          .prepare(
            `UPDATE search_docs_cognition SET stance = ?, updated_at = ? WHERE source_ref = ? AND agent_id = ?`,
          )
          .run(newStance, now, sourceRef, agentId);
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
    sourceRefKind: "private_belief" | "private_event";
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
