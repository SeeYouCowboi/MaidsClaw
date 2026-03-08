import { MaidsClawError } from "../core/errors.js";
import type { InteractionRecord } from "./contracts.js";
import type { InteractionStore } from "./store.js";

const VALID_ACTOR_TYPES: readonly string[] = [
  "user",
  "rp_agent",
  "maiden",
  "task_agent",
  "system",
  "autonomy",
];

const VALID_RECORD_TYPES: readonly string[] = [
  "message",
  "tool_call",
  "tool_result",
  "delegation",
  "task_result",
  "schedule_trigger",
  "status",
];

export type CommitInput = Omit<InteractionRecord, "recordId" | "recordIndex" | "committedAt">;

export class CommitService {
  private readonly store: InteractionStore;

  constructor(store: InteractionStore) {
    this.store = store;
  }

  commit(input: CommitInput): InteractionRecord {
    if (!VALID_ACTOR_TYPES.includes(input.actorType)) {
      throw new MaidsClawError({
        code: "INTERACTION_INVALID_FIELD",
        message: `Invalid actorType: ${input.actorType}`,
        retriable: false,
        details: { field: "actorType", value: input.actorType },
      });
    }

    if (!VALID_RECORD_TYPES.includes(input.recordType)) {
      throw new MaidsClawError({
        code: "INTERACTION_INVALID_FIELD",
        message: `Invalid recordType: ${input.recordType}`,
        retriable: false,
        details: { field: "recordType", value: input.recordType },
      });
    }

    const recordId = crypto.randomUUID();
    const recordIndex = this.getNextIndex(input.sessionId);
    const committedAt = Date.now();

    const record: InteractionRecord = {
      sessionId: input.sessionId,
      recordId,
      recordIndex,
      actorType: input.actorType,
      recordType: input.recordType,
      payload: input.payload,
      committedAt,
    };

    if (input.correlatedTurnId !== undefined) {
      record.correlatedTurnId = input.correlatedTurnId;
    }

    this.store.commit(record);
    return record;
  }

  private getNextIndex(sessionId: string): number {
    const maxIndex = this.store.getMaxIndex(sessionId);
    return maxIndex === undefined ? 0 : maxIndex + 1;
  }
}
