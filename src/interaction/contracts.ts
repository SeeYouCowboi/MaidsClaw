// Interaction contracts — types for the append-only interaction log
// These are the ONLY interaction types allowed in the system

import type { ProjectionAppendix } from "../core/types.js";
import type { PrivateCognitionCommit } from "../runtime/rp-turn-contract.js";

// Actor types — who produced an interaction record
// EXACTLY 6 actor types allowed
export type ActorType =
  | "user"
  | "rp_agent"
  | "maiden"
  | "task_agent"
  | "system"
  | "autonomy";

// Record types — what kind of event this is
// EXACTLY 8 record types allowed
export type RecordType =
  | "message"
  | "tool_call"
  | "tool_result"
  | "delegation"
  | "task_result"
  | "schedule_trigger"
  | "status"
  | "turn_settlement";

// The core interaction record — append-only log entry
export type InteractionRecord = {
  sessionId: string;
  recordId: string;
  recordIndex: number;         // Monotonic, session-scoped
  actorType: ActorType;
  recordType: RecordType;
  payload: unknown;            // Schema varies by recordType (see PayloadSchemas below)
  correlatedTurnId?: string;   // Links back to the user-turn request ID
  committedAt: number;         // Unix ms timestamp
};

// Payload schemas by record type (normative, not runtime-validated in V1)

export type MessagePayload = {
  role: "user" | "assistant";
  content: string;
  projectionAppendix?: ProjectionAppendix; // Present only when projection-eligible
};

export type ToolCallPayload = {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
};

export type ToolResultPayload = {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
  projectionAppendix?: ProjectionAppendix; // For structured tool results that are projection-eligible
};

export type DelegationPayload = {
  delegationId: string;
  fromAgentId: string;
  toAgentId: string;
  input: unknown;
  status: "started" | "completed" | "failed";
};

export type TaskResultPayload = {
  taskId: string;
  agentId: string;
  result: unknown;
  schema?: unknown;
  projectionAppendix?: ProjectionAppendix; // For durable task results
};

export type StatusPayload = {
  event: string;
  details?: unknown;
};

export type TurnSettlementPayload = {
  settlementId: string;
  requestId: string;
  sessionId: string;
  ownerAgentId: string;
  publicReply: string;
  hasPublicReply: boolean;
  viewerSnapshot: {
    selfPointerKey: string;
    userPointerKey: string;
    currentLocationEntityId?: number;
  };
  privateCommit?: PrivateCognitionCommit;
};

export type AssistantMessagePayloadV3 = MessagePayload & {
  settlementId?: string;
};
