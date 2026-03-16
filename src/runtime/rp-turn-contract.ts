export type CognitionEntityRef =
  | { kind: "pointer_key"; value: string }
  | { kind: "special"; value: "self" | "user" | "current_location" };

export type EntityProposition = {
  subject: CognitionEntityRef;
  predicate: string;
  object: { kind: "entity"; ref: CognitionEntityRef };
};

export type CognitionKind = "assertion" | "evaluation" | "commitment";

export type CognitionRecordBase = {
  kind: CognitionKind;
  key: string;
  salience?: number;
  confidence?: number;
  provenance?: string;
  ttlTurns?: number;
};

export type CognitionSelector = {
  kind: CognitionKind;
  key: string;
};

export type AssertionRecord = CognitionRecordBase & {
  kind: "assertion";
  proposition: EntityProposition;
  stance: "accepted" | "tentative" | "hypothetical" | "rejected";
  basis?: "observation" | "inference" | "suspicion" | "introspection" | "communication";
};

export type EvaluationRecord = CognitionRecordBase & {
  kind: "evaluation";
  target: CognitionEntityRef | CognitionSelector;
  dimensions: Array<{ name: string; value: number }>;
  emotionTags?: string[];
  notes?: string;
};

export type CommitmentRecord = CognitionRecordBase & {
  kind: "commitment";
  mode: "goal" | "intent" | "plan" | "constraint" | "avoidance";
  target: EntityProposition | { action: string; target?: CognitionEntityRef };
  status: "active" | "paused" | "fulfilled" | "abandoned";
  priority?: number;
  horizon?: "immediate" | "near" | "long";
};

export type CognitionRecord = AssertionRecord | EvaluationRecord | CommitmentRecord;

export type CognitionOp =
  | { op: "upsert"; record: CognitionRecord }
  | { op: "retract"; target: CognitionSelector };

export type PrivateCognitionCommit = {
  schemaVersion: "rp_private_cognition_v3";
  summary?: string;
  ops: CognitionOp[];
};

export type RpTurnOutcomeSubmission = {
  schemaVersion: "rp_turn_outcome_v3";
  publicReply: string;
  latentScratchpad?: string;
  privateCommit?: PrivateCognitionCommit;
};

export type RpBufferedExecutionResult =
  | { outcome: RpTurnOutcomeSubmission }
  | { error: string };

export function validateRpTurnOutcome(raw: unknown): RpTurnOutcomeSubmission {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error("rp_turn_outcome must be a non-null object");
  }

  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== "rp_turn_outcome_v3") {
    throw new Error(
      `schemaVersion must be "rp_turn_outcome_v3", got ${JSON.stringify(obj.schemaVersion)}`
    );
  }

  if (typeof obj.publicReply !== "string") {
    throw new Error(
      `publicReply must be a string, got ${typeof obj.publicReply}`
    );
  }

  if (obj.privateCommit !== undefined) {
    if (obj.privateCommit === null || typeof obj.privateCommit !== "object") {
      throw new Error("privateCommit must be an object if present");
    }
    const commit = obj.privateCommit as Record<string, unknown>;
    if (!Array.isArray(commit.ops)) {
      throw new Error("privateCommit.ops must be an array");
    }
  }

  const publicReply = obj.publicReply as string;
  const privateCommit = obj.privateCommit as PrivateCognitionCommit | undefined;

  if (publicReply === "" && (!privateCommit || privateCommit.ops.length === 0)) {
    throw new Error(
      "empty turn: publicReply is empty and privateCommit has no ops"
    );
  }

  return obj as unknown as RpTurnOutcomeSubmission;
}
