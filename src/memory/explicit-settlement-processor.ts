import type { Database } from "bun:sqlite";
import type { CognitionOp } from "../runtime/rp-turn-contract.js";
import type { TurnSettlementPayload } from "../interaction/contracts.js";
import { CognitionRepository } from "./cognition/cognition-repo.js";
import { CognitionOpCommitter } from "./cognition-op-committer.js";
import { makeNodeRef } from "./schema.js";
import type { GraphStorageService } from "./storage.js";
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
      const commitRefs = new CognitionOpCommitter(this.storage, explicitMeta.ownerAgentId, currentLocationEntityId).commit(
        explicitMeta.privateCommit.ops,
        explicitMeta.settlementId,
      );
      created.changedNodeRefs.push(...commitRefs);
      this.collectExplicitSettlementRefs(explicitMeta.ownerAgentId, explicitMeta.settlementId, explicitMeta.privateCommit.ops, created);
    }
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
