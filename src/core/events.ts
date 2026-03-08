// V1 Event Map — frozen, typed inter-agent communication signals
// These are the ONLY events allowed in the system (12 total)

import type { InteractionRecord } from "../interaction/contracts.js";
import type { MemoryFlushRequest } from "./types.js";

// Event payload types
export type InteractionCommittedPayload = {
  record: InteractionRecord;
};

export type JobEnqueuedPayload = {
  jobKey: string;
  jobType: string;
  scope: string;
};

export type JobStartedPayload = {
  jobKey: string;
  jobType: string;
  runId: string;
};

export type JobCompletedPayload = {
  jobKey: string;
  jobType: string;
  runId: string;
  success: boolean;
  errorCode?: string;
};

export type ToolCalledPayload = {
  toolName: string;
  agentId: string;
  sessionId: string;
  isLocal: boolean;
};

export type ToolCompletedPayload = {
  toolName: string;
  agentId: string;
  sessionId: string;
  isError: boolean;
  elapsedMs: number;
};

export type DelegateStartedPayload = {
  delegationId: string;
  fromAgentId: string;
  toAgentId: string;
  sessionId: string;
};

export type DelegateCompletedPayload = {
  delegationId: string;
  fromAgentId: string;
  toAgentId: string;
  sessionId: string;
  success: boolean;
};

export type SessionClosedPayload = {
  sessionId: string;
  reason: "explicit" | "idle_timeout" | "error";
};

export type McpConnectedPayload = {
  serverId: string;
  serverName: string;
};

export type McpDisconnectedPayload = {
  serverId: string;
  serverName: string;
  reason?: string;
};

export type MemoryFlushRequestedPayload = {
  request: MemoryFlushRequest;
};

// THE FROZEN V1 EVENT MAP — only these 12 events exist
export type EventMap = {
  "interaction.committed": InteractionCommittedPayload;
  "job.enqueued": JobEnqueuedPayload;
  "job.started": JobStartedPayload;
  "job.completed": JobCompletedPayload;
  "tool.called": ToolCalledPayload;
  "tool.completed": ToolCompletedPayload;
  "delegate.started": DelegateStartedPayload;
  "delegate.completed": DelegateCompletedPayload;
  "session.closed": SessionClosedPayload;
  "mcp.connected": McpConnectedPayload;
  "mcp.disconnected": McpDisconnectedPayload;
  "memory.flush_requested": MemoryFlushRequestedPayload;
};

export type EventName = keyof EventMap;
export type EventPayload<E extends EventName> = EventMap[E];
