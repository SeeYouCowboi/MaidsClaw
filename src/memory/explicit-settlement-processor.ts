import type { AgentRole } from "../agents/profile.js";

export type ExplicitSettlementDbAdapter = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

import { MaidsClawError } from "../core/errors.js";
import { enforceArtifactContracts } from "../core/tools/artifact-contract-policy.js";
import type { TurnSettlementPayload } from "../interaction/contracts.js";
import type { ArtifactContract } from "../core/tools/tool-definition.js";
import type {
  AssertionBasis,
  AssertionRecordV4,
  CognitionEntityRef,
  CognitionOp,
  CognitionRecord,
  CognitionSelector,
  CommitmentRecord,
  EvaluationRecord,
} from "../runtime/rp-turn-contract.js";
import type { CognitionRepository } from "./cognition/cognition-repo.js";
import { normalizeConflictFactorRefs } from "./cognition/private-cognition-current.js";
import type { RelationBuilder } from "./cognition/relation-builder.js";
import {
  materializeRelationIntents,
  resolveConflictFactors,
  resolveLocalRefs,
  validateRelationIntents,
  type SettledArtifacts,
} from "./cognition/relation-intent-resolver.js";
import type { RelationWriteRepo } from "../storage/domain-repos/contracts/relation-write-repo.js";
import type { CognitionProjectionRepo } from "../storage/domain-repos/contracts/cognition-projection-repo.js";
import { enforceWriteTemplate } from "./contracts/write-template.js";
import { makeNodeRef } from "./schema.js";
import type { SettlementLedger } from "./settlement-ledger.js";
import type { GraphStorageService } from "./storage.js";
import type { NodeRef } from "./types.js";
import type {
  ChatToolDefinition,
  CreatedState,
  IngestionAttachment,
  IngestionInput,
  MemoryFlushRequest,
  MemoryTaskModelProvider,
} from "./task-agent.js";
import type { WriteTemplate } from "./contracts/write-template.js";

type ExistingContextLoader = (agentId: string) => Promise<{ entities: unknown[]; privateBeliefs: unknown[] }>;
type CallOneApplier = (flushRequest: MemoryFlushRequest, toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>, created: CreatedState) => Promise<void>;

const V3_BASIS_TO_V4: Record<string, AssertionBasis> = {
  observation: "first_hand",
  inference: "inference",
  suspicion: "inference",
  introspection: "introspection",
  communication: "hearsay",
};

export type ExplicitSettlementProcessorDeps = {
  db: ExplicitSettlementDbAdapter;
  cognitionRepo: Pick<
    CognitionRepository,
    | "upsertAssertion"
    | "upsertEvaluation"
    | "upsertCommitment"
    | "retractCognition"
    | "getEvaluations"
    | "getCommitments"
    | "getAssertions"
    | "getAssertionByKey"
    | "getEvaluationByKey"
    | "getCommitmentByKey"
  >;
  relationBuilder: Pick<RelationBuilder, "writeContestRelations">;
  relationWriteRepo: Pick<RelationWriteRepo, "upsertRelation">;
  cognitionProjectionRepo: Pick<CognitionProjectionRepo, "getCurrent">;
};

export class ExplicitSettlementProcessor {
  private readonly db: ExplicitSettlementDbAdapter;
  private readonly cognitionRepo: ExplicitSettlementProcessorDeps["cognitionRepo"];
  private readonly relationBuilder: ExplicitSettlementProcessorDeps["relationBuilder"];
  private readonly relationWriteRepo: ExplicitSettlementProcessorDeps["relationWriteRepo"];
  private readonly cognitionProjectionRepo: ExplicitSettlementProcessorDeps["cognitionProjectionRepo"];

  constructor(
    deps: ExplicitSettlementProcessorDeps,
    private readonly storage: GraphStorageService,
    private readonly modelProvider: Pick<MemoryTaskModelProvider, "chat">,
    private readonly loadExistingContext: ExistingContextLoader,
    private readonly applyCallOneToolCalls: CallOneApplier,
    private readonly settlementLedger?: SettlementLedger,
  ) {
    this.db = deps.db;
    this.cognitionRepo = deps.cognitionRepo;
    this.relationBuilder = deps.relationBuilder;
    this.relationWriteRepo = deps.relationWriteRepo;
    this.cognitionProjectionRepo = deps.cognitionProjectionRepo;
  }

  async process(
    flushRequest: MemoryFlushRequest,
    ingest: IngestionInput,
    created: CreatedState,
    explicitSupportTools: ChatToolDefinition[],
    options: {
      agentRole: AgentRole;
      writeTemplateOverride?: WriteTemplate;
      agentId?: string;
      artifactContracts?: Record<string, ArtifactContract>;
      skipEnforcement?: boolean;
    },
  ): Promise<void> {
    if (!options.skipEnforcement) {
      enforceWriteTemplate(options.agentRole, "cognition", options.writeTemplateOverride);

      if (options.artifactContracts) {
        enforceArtifactContracts(options.artifactContracts, {
          writingAgentId: options.agentId,
          ownerAgentId: ingest.agentId,
          writeOperation: "append",
        });
      }
    }

    for (const explicitMeta of ingest.explicitSettlements) {
      const ledgerState = this.settlementLedger?.check(explicitMeta.settlementId);
      if (ledgerState === "applied" || ledgerState === "failed") {
        continue;
      }

      this.settlementLedger?.markApplying(
        explicitMeta.settlementId,
        explicitMeta.ownerAgentId,
      );

      try {
        const explicitIngest = this.buildExplicitIngest(ingest, explicitMeta.requestId);
        const explicitContext = await this.loadExistingContext(explicitMeta.ownerAgentId);
        const explicitSupportCall = await this.modelProvider.chat(
          [
            {
              role: "system",
              content:
                "You are a memory migration support engine for authoritative explicit cognition. Use tools only to resolve canonical entities and aliases needed by authoritative explicit ops. Do not invent or rewrite private beliefs/events. Create only supporting entities, aliases, and logic edges when strictly necessary.",
            },
            {
              role: "user",
              content: JSON.stringify({ ingest: explicitIngest, existingContext: explicitContext }),
            },
          ],
          explicitSupportTools,
        );

        await this.applyCallOneToolCalls(
          {
            ...flushRequest,
            agentId: explicitMeta.ownerAgentId,
          },
          explicitSupportCall,
          created,
        );

        const settlementPayload = this.findSettlementPayload(ingest.attachments, explicitMeta.settlementId);
        const currentLocationEntityId = settlementPayload?.viewerSnapshot.currentLocationEntityId;
        const commitResult = await this.commitCognitionOps(
          explicitMeta.ownerAgentId,
          explicitMeta.privateCognition.ops,
          explicitMeta.settlementId,
          currentLocationEntityId,
        );
        created.changedNodeRefs.push(...commitResult.refs);

        if (settlementPayload) {
          const settledArtifacts = this.buildSettledArtifacts(
            settlementPayload,
            explicitMeta.ownerAgentId,
            explicitMeta.settlementId,
            commitResult,
          );
          const resolvedRefs = resolveLocalRefs(settlementPayload, settledArtifacts);
          const relationIntents = settlementPayload.relationIntents ?? [];
          validateRelationIntents(relationIntents, resolvedRefs);
          await materializeRelationIntents(relationIntents, resolvedRefs, this.relationWriteRepo);

          const conflictResult = await resolveConflictFactors(
            settlementPayload.conflictFactors ?? [],
            this.cognitionProjectionRepo,
            {
              settledRefs: resolvedRefs,
              settlementId: explicitMeta.settlementId,
              agentId: explicitMeta.ownerAgentId,
            },
          );

          this.applyContestConflictFactors(
            explicitMeta.ownerAgentId,
            explicitMeta.settlementId,
            commitResult.contestedAssertions,
            conflictResult.resolved.map((factor) => factor.nodeRef),
            conflictResult.unresolved.length,
          );
        }

        await this.collectExplicitSettlementRefs(
          explicitMeta.ownerAgentId,
          explicitMeta.settlementId,
          explicitMeta.privateCognition.ops,
          created,
        );
        this.settlementLedger?.markApplied(explicitMeta.settlementId);
      } catch (error) {
        this.settlementLedger?.markFailed(
          explicitMeta.settlementId,
          error instanceof Error ? error.message : String(error),
          error instanceof MaidsClawError ? error.retriable : false,
        );
        throw error;
      }
    }
  }

  private async commitCognitionOps(
    agentId: string,
    ops: CognitionOp[],
    settlementId: string,
    currentLocationEntityId?: number,
  ): Promise<{
    refs: NodeRef[];
    cognitionByKey: Map<string, { kind: "assertion" | "evaluation" | "commitment"; nodeRef: string }>;
    contestedAssertions: Array<{ cognitionKey: string; nodeRef: string }>;
  }> {
    const refs: NodeRef[] = [];
    const cognitionByKey = new Map<string, { kind: "assertion" | "evaluation" | "commitment"; nodeRef: string }>();
    const contestedAssertions: Array<{ cognitionKey: string; nodeRef: string }> = [];
    const unresolvedKeys: string[] = [];

    for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
      const op = ops[opIndex] as CognitionOp;
      if (op.op === "upsert") {
        try {
          const committed = await this.commitUpsert(op.record, agentId, settlementId, opIndex, currentLocationEntityId);
          refs.push(committed.nodeRef);
          cognitionByKey.set(op.record.key, { kind: op.record.kind, nodeRef: committed.nodeRef });
          if (op.record.kind === "assertion" && op.record.stance === "contested") {
            contestedAssertions.push({ cognitionKey: op.record.key, nodeRef: committed.nodeRef });
          }
        } catch (err) {
          if (err instanceof MaidsClawError && err.code === "COGNITION_UNRESOLVED_REFS") {
            unresolvedKeys.push(op.record.key);
          } else {
            throw err;
          }
        }
        continue;
      }

      if (op.op === "retract") {
        await this.cognitionRepo.retractCognition(agentId, op.target.key, op.target.kind, settlementId);
      }
    }

    if (unresolvedKeys.length > 0) {
      throw new MaidsClawError({
        code: "COGNITION_UNRESOLVED_REFS",
        message: `Explicit settlement ${settlementId} has ${unresolvedKeys.length} unresolved cognition key(s): ${unresolvedKeys.join(", ")}`,
        retriable: true,
        details: { settlementId, unresolvedKeys },
      });
    }

    return { refs, cognitionByKey, contestedAssertions };
  }

  private async commitUpsert(
    record: CognitionRecord,
    agentId: string,
    settlementId: string,
    opIndex: number,
    currentLocationEntityId?: number,
  ): Promise<{ nodeRef: NodeRef }> {
    if (record.kind === "assertion") {
      const sourcePointerKey = this.resolvePointerKey(record.proposition.subject, currentLocationEntityId, agentId);
      const targetPointerKey = this.resolvePointerKey(record.proposition.object.ref, currentLocationEntityId, agentId);
      const basis = this.normalizeAssertionBasis(record.basis);
      const preContestedStance = "preContestedStance" in record
        ? (record as AssertionRecordV4).preContestedStance
        : undefined;

      const result = await this.cognitionRepo.upsertAssertion({
        agentId,
        cognitionKey: record.key,
        settlementId,
        opIndex,
        sourcePointerKey,
        predicate: record.proposition.predicate,
        targetPointerKey,
        stance: record.stance,
        basis,
        preContestedStance,
        provenance: record.provenance,
      });
      return { nodeRef: makeNodeRef("assertion", result.id) };
    }

    if (record.kind === "evaluation") {
      const targetEntityId = this.resolveTargetEntityId(record, agentId, currentLocationEntityId);
      const result = await this.cognitionRepo.upsertEvaluation({
        agentId,
        cognitionKey: record.key,
        settlementId,
        opIndex,
        targetEntityId,
        salience: record.salience,
        dimensions: record.dimensions,
        emotionTags: record.emotionTags,
        notes: record.notes,
      });
      return { nodeRef: makeNodeRef("evaluation", result.id) };
    }

    const commitmentRecord = record as CommitmentRecord;
    const targetEntityId = this.resolveCommitmentTargetEntityId(commitmentRecord, agentId, currentLocationEntityId);
    const result = await this.cognitionRepo.upsertCommitment({
      agentId,
      cognitionKey: record.key,
      settlementId,
      opIndex,
      targetEntityId,
      salience: record.salience,
      mode: commitmentRecord.mode,
      target: commitmentRecord.target,
      status: commitmentRecord.status,
      priority: commitmentRecord.priority,
      horizon: commitmentRecord.horizon,
    });
    return { nodeRef: makeNodeRef("commitment", result.id) };
  }

  private buildSettledArtifacts(
    payload: TurnSettlementPayload,
    agentId: string,
    settlementId: string,
    commitResult: {
      cognitionByKey: Map<string, { kind: "assertion" | "evaluation" | "commitment"; nodeRef: string }>;
    },
  ): SettledArtifacts {
    const localRefIndex = new Map<string, { kind: "episode" | "publication" | "cognition" | "proposal"; nodeRef: string }>();

    const episodeRows = this.db
      .prepare(
        `SELECT id, source_local_ref
         FROM private_episode_events
         WHERE settlement_id = ? AND agent_id = ?`,
      )
      .all(settlementId, agentId) as Array<{ id: number; source_local_ref: string | null }>;
    for (const row of episodeRows) {
      if (!row.source_local_ref) {
        continue;
      }
      localRefIndex.set(row.source_local_ref, {
        kind: "episode",
        nodeRef: `private_episode:${row.id}`,
      });
    }

    const publications = payload.publications ?? [];
    if (publications.length > 0) {
      const publicationRows = this.db
        .prepare(
          `SELECT id, source_pub_index
           FROM event_nodes
           WHERE source_settlement_id = ?`,
        )
        .all(settlementId) as Array<{ id: number; source_pub_index: number | null }>;
      for (const row of publicationRows) {
        if (row.source_pub_index === null || row.source_pub_index === undefined) {
          continue;
        }
        const declaration = publications[row.source_pub_index];
        if (!declaration?.localRef) {
          continue;
        }
        localRefIndex.set(declaration.localRef, {
          kind: "publication",
          nodeRef: `event:${row.id}`,
        });
      }
    }

    return {
      settlementId,
      agentId,
      localRefIndex,
      cognitionByKey: commitResult.cognitionByKey,
    };
  }

  private applyContestConflictFactors(
    agentId: string,
    settlementId: string,
    contestedAssertions: Array<{ cognitionKey: string; nodeRef: string }>,
    resolvedFactorNodeRefs: string[],
    unresolvedCount: number,
  ): void {
    if (contestedAssertions.length === 0) {
      return;
    }

    const { refs: validRefs, dropped } = normalizeConflictFactorRefs(resolvedFactorNodeRefs);
    if (dropped > 0) {
      console.warn(`[settlement] dropped ${dropped} invalid conflict_factor_refs for settlement ${settlementId}`);
    }

    const summary = unresolvedCount > 0
      ? `contested (${validRefs.length} factors resolved, ${unresolvedCount} dropped)`
      : `contested (${validRefs.length} factors)`;

    for (const assertion of contestedAssertions) {
      this.relationBuilder.writeContestRelations(
        assertion.nodeRef,
        validRefs,
        settlementId,
      );

      this.db
        .prepare(
          `UPDATE private_cognition_current
           SET conflict_summary = ?,
               conflict_factor_refs_json = ?,
               updated_at = ?
           WHERE agent_id = ? AND cognition_key = ?`,
        )
        .run(
          summary,
          JSON.stringify(validRefs),
          Date.now(),
          agentId,
          assertion.cognitionKey,
        );
    }
  }

  private resolvePointerKey(
    ref: CognitionEntityRef,
    currentLocationEntityId: number | undefined,
    agentId: string,
  ): string {
    if (ref.kind === "pointer_key") return ref.value;
    if (ref.value === "self") return "__self__";
    if (ref.value === "user") return "__user__";

    if (currentLocationEntityId !== undefined) {
      const entity = this.storage.getEntityById(currentLocationEntityId);
      if (entity) return entity.pointerKey;
    }

    const pointerKey = "__current_location__";
    if (this.storage.resolveEntityByPointerKey(pointerKey, agentId) === null) {
      throw new MaidsClawError({
        code: "COGNITION_UNRESOLVED_REFS",
        message: `Unresolved entity ref for current_location: ${pointerKey}`,
        retriable: true,
        details: { unresolvedPointerKeys: [pointerKey] },
      });
    }
    return pointerKey;
  }

  private resolveTargetEntityId(
    record: EvaluationRecord,
    agentId: string,
    currentLocationEntityId?: number,
  ): number | undefined {
    if (this.isCognitionSelector(record.target)) return undefined;

    const pointerKey = this.resolvePointerKey(record.target, currentLocationEntityId, agentId);
    const entityId = this.storage.resolveEntityByPointerKey(pointerKey, agentId);
    if (entityId === null) {
      throw new MaidsClawError({
        code: "COGNITION_UNRESOLVED_REFS",
        message: `Unresolved entity ref for evaluation target: ${pointerKey}`,
        retriable: true,
        details: { unresolvedPointerKeys: [pointerKey] },
      });
    }
    return entityId;
  }

  private resolveCommitmentTargetEntityId(
    record: CommitmentRecord,
    agentId: string,
    currentLocationEntityId?: number,
  ): number | undefined {
    if ("action" in record.target) {
      if (!record.target.target) return undefined;
      const pointerKey = this.resolvePointerKey(record.target.target, currentLocationEntityId, agentId);
      const entityId = this.storage.resolveEntityByPointerKey(pointerKey, agentId);
      if (entityId === null) {
        throw new MaidsClawError({
          code: "COGNITION_UNRESOLVED_REFS",
          message: `Unresolved entity ref for commitment action target: ${pointerKey}`,
          retriable: true,
          details: { unresolvedPointerKeys: [pointerKey] },
        });
      }
      return entityId;
    }

    const pointerKey = this.resolvePointerKey(record.target.subject, currentLocationEntityId, agentId);
    const entityId = this.storage.resolveEntityByPointerKey(pointerKey, agentId);
    if (entityId === null) {
      throw new MaidsClawError({
        code: "COGNITION_UNRESOLVED_REFS",
        message: `Unresolved entity ref for commitment subject: ${pointerKey}`,
        retriable: true,
        details: { unresolvedPointerKeys: [pointerKey] },
      });
    }
    return entityId;
  }

  private normalizeAssertionBasis(value: unknown): AssertionBasis | undefined {
    if (value === undefined || value === null) return undefined;
    const str = String(value);
    if (str in V3_BASIS_TO_V4) return V3_BASIS_TO_V4[str];
    if (str === "first_hand" || str === "hearsay" || str === "inference" || str === "introspection" || str === "belief") {
      return str;
    }
    return undefined;
  }

  private isCognitionSelector(value: CognitionEntityRef | CognitionSelector): value is CognitionSelector {
    return value.kind === "assertion" || value.kind === "evaluation" || value.kind === "commitment";
  }

  private buildExplicitIngest(ingest: IngestionInput, requestId: string): IngestionInput {
    return {
      ...ingest,
      dialogue: ingest.dialogue.filter((row) => row.correlatedTurnId === requestId),
      attachments: ingest.attachments.filter((attachment) => {
        if (attachment.correlatedTurnId === requestId) {
          return true;
        }
        if (attachment.recordType !== "turn_settlement") {
          return false;
        }
        const payload = attachment.payload as TurnSettlementPayload | undefined;
        return payload?.requestId === requestId;
      }),
      explicitSettlements: ingest.explicitSettlements.filter((meta) => meta.requestId === requestId),
    };
  }

  private findSettlementPayload(attachments: IngestionAttachment[], settlementId: string): TurnSettlementPayload | undefined {
    const settlementAttachment = attachments.find((attachment) => attachment.explicitMeta?.settlementId === settlementId);
    if (!settlementAttachment) {
      return undefined;
    }
    return settlementAttachment.payload as TurnSettlementPayload;
  }

  private async collectExplicitSettlementRefs(agentId: string, settlementId: string, ops: CognitionOp[], created: CreatedState): Promise<void> {
    const evaluations = (await this.cognitionRepo
      .getEvaluations(agentId, { activeOnly: false }))
      .filter((row) => row.settlementId === settlementId);
    for (const row of evaluations) {
      created.episodeEventIds.push(row.id);
      created.changedNodeRefs.push(makeNodeRef("evaluation", row.id));
    }

    const commitments = (await this.cognitionRepo
      .getCommitments(agentId, { activeOnly: false }))
      .filter((row) => row.settlementId === settlementId);
    for (const row of commitments) {
      created.episodeEventIds.push(row.id);
      created.changedNodeRefs.push(makeNodeRef("commitment", row.id));
    }

    const assertions = (await this.cognitionRepo
      .getAssertions(agentId, { activeOnly: false }))
      .filter((row) => row.settlementId === settlementId);
    for (const row of assertions) {
      created.assertionIds.push(row.id);
      created.changedNodeRefs.push(makeNodeRef("assertion", row.id));
    }

    for (const op of ops) {
      if (op.op !== "retract") {
        continue;
      }
      if (op.target.kind === "assertion") {
        const row = await this.cognitionRepo.getAssertionByKey(agentId, op.target.key);
        if (row) {
          created.assertionIds.push(row.id);
          created.changedNodeRefs.push(makeNodeRef("assertion", row.id));
        }
        continue;
      }

      const row = await (
        op.target.kind === "evaluation"
          ? this.cognitionRepo.getEvaluationByKey(agentId, op.target.key)
          : this.cognitionRepo.getCommitmentByKey(agentId, op.target.key)
      );
      if (row) {
        created.episodeEventIds.push(row.id);
        created.changedNodeRefs.push(makeNodeRef(op.target.kind, row.id));
      }
    }
  }
}
