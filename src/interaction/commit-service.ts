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
  "turn_settlement",
];

export type CommitInput = Omit<InteractionRecord, "recordId" | "recordIndex" | "committedAt">;

export class CommitService {
  private readonly store: InteractionStore;

  constructor(store: InteractionStore) {
    this.store = store;
  }

  commit(input: CommitInput): InteractionRecord {
    return this.commitInternal(input);
  }

  commitWithId(input: CommitInput & { recordId: string }): InteractionRecord {
    return this.commitInternal(input, input.recordId);
  }

  commitBatch(inputs: CommitInput[]): InteractionRecord[] {
    if (inputs.length === 0) {
      return [];
    }

    return this.store.runInTransaction(() => {
      const nextIndexBySession = new Map<string, number>();
      const records: InteractionRecord[] = [];

      for (const input of inputs) {
        this.validateInput(input);

        if (!nextIndexBySession.has(input.sessionId)) {
          nextIndexBySession.set(input.sessionId, this.getNextIndex(input.sessionId));
        }

        const recordIndex = nextIndexBySession.get(input.sessionId)!;
        nextIndexBySession.set(input.sessionId, recordIndex + 1);

        const record = this.buildRecord(input, crypto.randomUUID(), recordIndex);
        this.store.commit(record);
        records.push(record);
      }

      return records;
    });
  }

  private commitInternal(input: CommitInput, recordIdOverride?: string): InteractionRecord {
    this.validateInput(input);

    if (recordIdOverride !== undefined && input.recordType !== "turn_settlement") {
      throw new MaidsClawError({
        code: "INTERACTION_INVALID_FIELD",
        message: "Custom recordId is only allowed for turn_settlement records",
        retriable: false,
        details: { field: "recordId", recordType: input.recordType },
      });
    }

    const recordId = recordIdOverride ?? crypto.randomUUID();
    const recordIndex = this.getNextIndex(input.sessionId);

    const record = this.buildRecord(input, recordId, recordIndex);
    this.store.commit(record);
    return record;
  }

  private validateInput(input: CommitInput): void {
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
  }

  private buildRecord(input: CommitInput, recordId: string, recordIndex: number): InteractionRecord {
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

    return record;
  }

  private getNextIndex(sessionId: string): number {
    const maxIndex = this.store.getMaxIndex(sessionId);
    return maxIndex === undefined ? 0 : maxIndex + 1;
  }
}
