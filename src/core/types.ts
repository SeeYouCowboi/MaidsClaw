// Core shared runtime types for MaidsClaw
// These types are the source of truth for ALL runtime contracts

import type { AgentProfile } from "../agents/profile.js";

// Gateway event (SSE events sent to clients)
export type GatewayEventType =
  | "status"
  | "delta"
  | "tool_call"
  | "tool_result"
  | "delegate"
  | "done"
  | "error";

export type GatewayEvent = {
  session_id: string;
  request_id: string;
  event_id: string;
  ts: number;
  type: GatewayEventType;
  data: unknown;
};

// Projection appendix — carried in InteractionRecord.payload for projection-eligible records
export type EventCategory = "speech" | "action" | "observation" | "state_change";
export type ProjectionClass = "area_candidate" | "non_projectable";

export type ProjectionAppendix = {
  publicSummarySeed: string;         // Pre-generated public summary text (no LLM reparsing)
  primaryActorEntityId: string;      // Entity ID of the primary actor
  locationEntityId: string;          // Entity ID of the location
  eventCategory: EventCategory;      // Only "speech" for assistant message direct projection
  projectionClass: ProjectionClass;  // area_candidate = eligible for projection
  sourceRecordId: string;            // Stable ID linking to at most one area_visible event
};

// Run context — per-agent-run metadata
export type RunContext = {
  runId: string;
  sessionId: string;
  agentId: string;
  profile: AgentProfile;
  requestId: string;
  delegationDepth: number;
  parentRunId?: string;
  parentAgentId?: string;
};

// Delegation context
export type DelegationContext = {
  delegationId: string;
  fromAgentId: string;
  toAgentId: string;
  toProfileId: string;
  requestId: string;
  sessionId: string;
  taskInput?: unknown;
  createdAt: number;
};

// MemoryFlushRequest — T27a produces these, T28a dispatches them
export type FlushMode = "dialogue_slice" | "session_close" | "manual" | "autonomous_run";

export type MemoryFlushRequest = {
  sessionId: string;
  agentId: string;
  rangeStart: number;   // Monotonic recordIndex start (inclusive)
  rangeEnd: number;     // Monotonic recordIndex end (inclusive)
  flushMode: FlushMode;
  idempotencyKey: string;
};

// Viewer context — auto-injected by ToolExecutor, never passed by agents
// Canonical shape lives in src/memory/types.ts; re-exported here for src/core/ consumers.
export type { ViewerContext, ViewerRole } from "../memory/types.js";
