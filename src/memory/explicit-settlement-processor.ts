import type { Database } from "bun:sqlite";
import { MaidsClawError } from "../core/errors.js";
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
import type { TurnSettlementPayload } from "../interaction/contracts.js";
import { CognitionRepository } from "./cognition/cognition-repo.js";
import { makeNodeRef } from "./schema.js";
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

type ExistingContextLoader = (agentId: string) => { entities: unknown[]; privateBeliefs: unknown[] };
type CallOneApplier = (flushRequest: MemoryFlushRequest, toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>, created: CreatedState) => void;

const V3_BASIS_TO_V4: Record<string, AssertionBasis> = {
  observation: "first_hand",
  inference: "inference",
  suspicion: "inference",
  introspection: "introspection",
  communication: "hearsay",
};

export class ExplicitSettlementProcessor {
  private readonly cognitionRepo: CognitionRepository;

  constructor(
    db: Database,
    private readonly storage: GraphStorageService,
    private readonly modelProvider: Pick<MemoryTaskModelProvider, "chat">,
    private readonly loadExistingContext: ExistingContextLoader,
    private readonly applyCallOneToolCalls: CallOneApplier,
  ) {
    this.cognitionRepo = new CognitionRepository(db);
  }

  async process(
    flushRequest: MemoryFlushRequest,
    ingest: IngestionInput,
    created: CreatedState,
    explicitSupportTools: ChatToolDefinition[],
  ): Promise<void> {
    for (const explicitMeta of ingest.explicitSettlements) {
      const explicitIngest = this.buildExplicitIngest(ingest, explicitMeta.requestId);
      const explicitContext = this.loadExistingContext(explicitMeta.ownerAgentId);
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

      this.applyCallOneToolCalls(
        {
          ...flushRequest,
          agentId: explicitMeta.ownerAgentId,
        },
        explicitSupportCall,
        created,
      );

      const settlementPayload = this.findSettlementPayload(ingest.attachments, explicitMeta.settlementId);
      const currentLocationEntityId = settlementPayload?.viewerSnapshot.currentLocationEntityId;
      const commitRefs = this.commitCognitionOps(
        explicitMeta.ownerAgentId,
        explicitMeta.privateCommit.ops,
        explicitMeta.settlementId,
        currentLocationEntityId,
      );
      created.changedNodeRefs.push(...commitRefs);
      this.collectExplicitSettlementRefs(explicitMeta.ownerAgentId, explicitMeta.settlementId, explicitMeta.privateCommit.ops, created);
    }
  }

  private commitCognitionOps(
    agentId: string,
    ops: CognitionOp[],
    settlementId: string,
    currentLocationEntityId?: number,
  ): NodeRef[] {
    const refs: NodeRef[] = [];
    const unresolvedKeys: string[] = [];

    for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
      const op = ops[opIndex] as CognitionOp;
      if (op.op === "upsert") {
        try {
          refs.push(this.commitUpsert(op.record, agentId, settlementId, opIndex, currentLocationEntityId));
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
        this.cognitionRepo.retractCognition(agentId, op.target.key, op.target.kind);
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

    return refs;
  }

  private commitUpsert(
    record: CognitionRecord,
    agentId: string,
    settlementId: string,
    opIndex: number,
    currentLocationEntityId?: number,
  ): NodeRef {
    if (record.kind === "assertion") {
      const sourcePointerKey = this.resolvePointerKey(record.proposition.subject, currentLocationEntityId, agentId);
      const targetPointerKey = this.resolvePointerKey(record.proposition.object.ref, currentLocationEntityId, agentId);
      const basis = this.normalizeAssertionBasis(record.basis);
      const preContestedStance = "preContestedStance" in record
        ? (record as AssertionRecordV4).preContestedStance
        : undefined;

      const result = this.cognitionRepo.upsertAssertion({
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
      return makeNodeRef("private_belief", result.id);
    }

    if (record.kind === "evaluation") {
      const targetEntityId = this.resolveTargetEntityId(record, agentId, currentLocationEntityId);
      const result = this.cognitionRepo.upsertEvaluation({
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
      return makeNodeRef("private_event", result.id);
    }

    const commitmentRecord = record as CommitmentRecord;
    const targetEntityId = this.resolveCommitmentTargetEntityId(commitmentRecord, agentId, currentLocationEntityId);
    const result = this.cognitionRepo.upsertCommitment({
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
    return makeNodeRef("private_event", result.id);
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

  private collectExplicitSettlementRefs(agentId: string, settlementId: string, ops: CognitionOp[], created: CreatedState): void {
    const evaluations = this.cognitionRepo
      .getEvaluations(agentId, { activeOnly: false })
      .filter((row) => row.settlementId === settlementId);
    for (const row of evaluations) {
      created.privateEventIds.push(row.id);
      created.changedNodeRefs.push(makeNodeRef("private_event", row.id));
    }

    const commitments = this.cognitionRepo
      .getCommitments(agentId, { activeOnly: false })
      .filter((row) => row.settlementId === settlementId);
    for (const row of commitments) {
      created.privateEventIds.push(row.id);
      created.changedNodeRefs.push(makeNodeRef("private_event", row.id));
    }

    const assertions = this.cognitionRepo
      .getAssertions(agentId, { activeOnly: false })
      .filter((row) => row.settlementId === settlementId);
    for (const row of assertions) {
      created.privateBeliefIds.push(row.id);
      created.changedNodeRefs.push(makeNodeRef("private_belief", row.id));
    }

    for (const op of ops) {
      if (op.op !== "retract") {
        continue;
      }
      if (op.target.kind === "assertion") {
        const row = this.cognitionRepo.getAssertionByKey(agentId, op.target.key);
        if (row) {
          created.privateBeliefIds.push(row.id);
          created.changedNodeRefs.push(makeNodeRef("private_belief", row.id));
        }
        continue;
      }

      const row =
        op.target.kind === "evaluation"
          ? this.cognitionRepo.getEvaluationByKey(agentId, op.target.key)
          : this.cognitionRepo.getCommitmentByKey(agentId, op.target.key);
      if (row) {
        created.privateEventIds.push(row.id);
        created.changedNodeRefs.push(makeNodeRef("private_event", row.id));
      }
    }
  }
}
