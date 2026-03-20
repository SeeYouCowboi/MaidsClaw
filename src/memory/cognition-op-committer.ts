import { MaidsClawError } from "../core/errors.js";
import type {
  AssertionBasis,
  CognitionEntityRef,
  CognitionOp,
  CognitionRecord,
  CognitionSelector,
  CommitmentRecord,
  EvaluationRecord,
} from "../runtime/rp-turn-contract.js";
import type { GraphStorageService } from "./storage.js";
import type { NodeRef } from "./types.js";

export class CognitionOpCommitter {
  constructor(
    private readonly storage: GraphStorageService,
    private readonly agentId: string,
    private readonly currentLocationEntityId?: number,
  ) {}

  commit(ops: CognitionOp[], settlementId: string): NodeRef[] {
    const refs: NodeRef[] = [];
    const unresolvedKeys: string[] = [];
    for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
      const op = ops[opIndex] as CognitionOp | { op: string; record?: CognitionRecord; target?: CognitionSelector };
      if (op.op === "touch") {
        throw new MaidsClawError({
          code: "COGNITION_OP_UNSUPPORTED",
          message: "touch is not supported in V3 baseline",
          retriable: false,
        });
      }

      if (op.op === "upsert" && op.record) {
        try {
          refs.push(this.commitUpsert(op.record, settlementId, opIndex));
        } catch (err) {
          if (err instanceof MaidsClawError && err.code === "COGNITION_UNRESOLVED_REFS") {
            unresolvedKeys.push(op.record.key);
          } else {
            throw err;
          }
        }
        continue;
      }

      if (op.op === "retract" && op.target) {
        if (this.isAlreadyRetracted(op.target)) {
          continue;
        }
        this.storage.retractExplicitCognition(this.agentId, op.target.key, op.target.kind);
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

  private commitUpsert(record: CognitionRecord, settlementId: string, opIndex: number): NodeRef {
    if (record.kind === "assertion") {
      const sourcePointerKey = this.resolveEntityPointerKey(record.proposition.subject);
      const targetPointerKey = this.resolveEntityPointerKey(record.proposition.object.ref);

      const result = this.storage.upsertExplicitAssertion({
        agentId: this.agentId,
        cognitionKey: record.key,
        settlementId,
        opIndex,
        sourcePointerKey,
        predicate: record.proposition.predicate,
        targetPointerKey,
        stance: record.stance,
        basis: this.normalizeAssertionBasis(record.basis),
        preContestedStance: "preContestedStance" in record ? record.preContestedStance : undefined,
        provenance: record.provenance,
      });
      return result.ref;
    }

    if (record.kind === "evaluation") {
      const result = this.storage.upsertExplicitEvaluation({
        agentId: this.agentId,
        cognitionKey: record.key,
        settlementId,
        opIndex,
        targetEntityId: this.resolveEvaluationTargetEntityId(record),
        salience: record.salience,
        dimensions: record.dimensions,
        emotionTags: record.emotionTags,
        notes: record.notes,
      });
      return result.ref;
    }

    const result = this.storage.upsertExplicitCommitment({
      agentId: this.agentId,
      cognitionKey: record.key,
      settlementId,
      opIndex,
      targetEntityId: this.resolveCommitmentTargetEntityId(record),
      salience: record.salience,
      mode: record.mode,
      target: record.target,
      status: record.status,
      priority: record.priority,
      horizon: record.horizon,
    });
    return result.ref;
  }

  private resolveEvaluationTargetEntityId(record: EvaluationRecord): number | undefined {
    if (this.isCognitionSelector(record.target)) {
      return undefined;
    }

    const pointerKey = this.resolveEntityPointerKey(record.target);
    const entityId = this.storage.resolveEntityByPointerKey(pointerKey, this.agentId);
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

  private resolveCommitmentTargetEntityId(record: CommitmentRecord): number | undefined {
    if ("action" in record.target) {
      if (!record.target.target) {
        return undefined;
      }

      const pointerKey = this.resolveEntityPointerKey(record.target.target);
      const entityId = this.storage.resolveEntityByPointerKey(pointerKey, this.agentId);
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

    const pointerKey = this.resolveEntityPointerKey(record.target.subject);
    const entityId = this.storage.resolveEntityByPointerKey(pointerKey, this.agentId);
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

  private resolveEntityPointerKey(ref: CognitionEntityRef): string {
    if (ref.kind === "pointer_key") {
      return ref.value;
    }

    if (ref.value === "self") {
      return "__self__";
    }
    if (ref.value === "user") {
      return "__user__";
    }

    if (this.currentLocationEntityId !== undefined) {
      const entity = this.storage.getEntityById(this.currentLocationEntityId);
      if (entity) return entity.pointerKey;
    }

    const pointerKey = "__current_location__";
    if (this.storage.resolveEntityByPointerKey(pointerKey, this.agentId) === null) {
      throw new MaidsClawError({
        code: "COGNITION_UNRESOLVED_REFS",
        message: `Unresolved entity ref for current_location: ${pointerKey}`,
        retriable: true,
        details: { unresolvedPointerKeys: [pointerKey] },
      });
    }
    return pointerKey;
  }

  private isCognitionSelector(value: CognitionEntityRef | CognitionSelector): value is CognitionSelector {
    return value.kind === "assertion" || value.kind === "evaluation" || value.kind === "commitment";
  }

  private normalizeAssertionBasis(value: unknown): AssertionBasis | undefined {
    if (value === "first_hand" || value === "hearsay" || value === "inference" || value === "introspection" || value === "belief") {
      return value;
    }
    if (value === "observation") {
      return "first_hand";
    }
    if (value === "communication") {
      return "hearsay";
    }
    if (value === "suspicion") {
      return "inference";
    }
    return undefined;
  }

  private isAlreadyRetracted(target: CognitionSelector): boolean {
    const cognitionRepo = (this.storage as unknown as {
      cognitionRepo?: {
        getAssertionByKey(agentId: string, cognitionKey: string): { stance: string } | null;
        getEvaluationByKey(agentId: string, cognitionKey: string): { status: string } | null;
        getCommitmentByKey(agentId: string, cognitionKey: string): { status: string } | null;
      };
    }).cognitionRepo;
    if (!cognitionRepo) {
      return false;
    }

    if (target.kind === "assertion") {
      const row = cognitionRepo.getAssertionByKey(this.agentId, target.key);
      return row !== null && (row.stance === "rejected" || row.stance === "abandoned");
    }

    const row =
      target.kind === "evaluation"
        ? cognitionRepo.getEvaluationByKey(this.agentId, target.key)
        : cognitionRepo.getCommitmentByKey(this.agentId, target.key);
    return row?.status === "retracted";
  }
}
