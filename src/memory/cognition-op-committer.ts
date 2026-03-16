import { MaidsClawError } from "../core/errors.js";
import type {
  CognitionEntityRef,
  CognitionOp,
  CognitionRecord,
  CognitionSelector,
  CommitmentRecord,
  EvaluationRecord,
} from "../runtime/rp-turn-contract.js";
import { GraphStorageService } from "./storage.js";

export class CognitionOpCommitter {
  constructor(
    private readonly storage: GraphStorageService,
    private readonly agentId: string,
    private readonly currentLocationEntityId?: number,
  ) {}

  commit(ops: CognitionOp[], settlementId: string): void {
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
        this.commitUpsert(op.record, settlementId, opIndex);
        continue;
      }

      if (op.op === "retract" && op.target) {
        this.storage.retractExplicitCognition(this.agentId, op.target.key, op.target.kind);
      }
    }
  }

  private commitUpsert(record: CognitionRecord, settlementId: string, opIndex: number): void {
    if (record.kind === "assertion") {
      const sourcePointerKey = this.resolveEntityPointerKey(record.proposition.subject);
      const targetPointerKey = this.resolveEntityPointerKey(record.proposition.object.ref);

      this.storage.upsertExplicitAssertion({
        agentId: this.agentId,
        cognitionKey: record.key,
        settlementId,
        opIndex,
        sourcePointerKey,
        predicate: record.proposition.predicate,
        targetPointerKey,
        stance: record.stance,
        confidence: record.confidence,
        provenance: record.provenance,
      });
      return;
    }

    if (record.kind === "evaluation") {
      this.storage.upsertExplicitEvaluation({
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
      return;
    }

    this.storage.upsertExplicitCommitment({
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
  }

  private resolveEvaluationTargetEntityId(record: EvaluationRecord): number | undefined {
    if (this.isCognitionSelector(record.target)) {
      return undefined;
    }

    const pointerKey = this.resolveEntityPointerKey(record.target);
    return this.storage.resolveEntityByPointerKey(pointerKey, this.agentId) ?? undefined;
  }

  private resolveCommitmentTargetEntityId(record: CommitmentRecord): number | undefined {
    if ("action" in record.target) {
      if (!record.target.target) {
        return undefined;
      }

      const pointerKey = this.resolveEntityPointerKey(record.target.target);
      return this.storage.resolveEntityByPointerKey(pointerKey, this.agentId) ?? undefined;
    }

    const pointerKey = this.resolveEntityPointerKey(record.target.subject);
    return this.storage.resolveEntityByPointerKey(pointerKey, this.agentId) ?? undefined;
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
      throw new Error("current_location cannot be resolved");
    }
    return pointerKey;
  }

  private isCognitionSelector(value: CognitionEntityRef | CognitionSelector): value is CognitionSelector {
    return value.kind === "assertion" || value.kind === "evaluation" || value.kind === "commitment";
  }
}
