/**
 * Location Helpers — Blackboard convenience accessors for agent and object locations.
 *
 * Keys live under the `agent_runtime.*` namespace:
 *   - Agent locations: `agent_runtime.location.{agentId}`
 *   - Object locations: `agent_runtime.location.obj:{objectId}`
 *
 * NOTE (V1 contract — agent_runtime.* restriction):
 *   agent_runtime.* carries RUNTIME state only — run status, active job/lease,
 *   heartbeat, and location tracking. It MUST NOT carry narrative state
 *   (dialogue content, beliefs, memories, persona data, etc.).
 *   This constraint is documentation-level in V1 (no runtime check).
 */

import type { Blackboard } from "./blackboard.js";

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

function agentLocationKey(agentId: string): string {
  return `agent_runtime.location.${agentId}`;
}

function objectLocationKey(objectId: string): string {
  return `agent_runtime.location.obj:${objectId}`;
}

// ---------------------------------------------------------------------------
// Agent location
// ---------------------------------------------------------------------------

/**
 * Set the current location of an agent on the blackboard.
 *
 * @param blackboard    — Target blackboard instance.
 * @param agentId       — The agent whose location to set.
 * @param placeEntityId — The place entity ID (numeric).
 * @param caller        — Optional caller identity (defaults to agent_runtime's open writer).
 */
export function setAgentLocation(
  blackboard: Blackboard,
  agentId: string,
  placeEntityId: number,
  caller?: string,
): void {
  blackboard.set(agentLocationKey(agentId), placeEntityId, caller);
}

/**
 * Get the current location of an agent.
 * Returns `undefined` if no location has been set.
 */
export function getAgentLocation(
  blackboard: Blackboard,
  agentId: string,
): number | undefined {
  const val = blackboard.get(agentLocationKey(agentId));
  return typeof val === "number" ? val : undefined;
}

// ---------------------------------------------------------------------------
// Object location
// ---------------------------------------------------------------------------

/**
 * Set the current location of an object on the blackboard.
 *
 * @param blackboard    — Target blackboard instance.
 * @param objectId      — The object whose location to set.
 * @param placeEntityId — The place entity ID (numeric).
 * @param caller        — Optional caller identity (defaults to agent_runtime's open writer).
 */
export function setObjectLocation(
  blackboard: Blackboard,
  objectId: string,
  placeEntityId: number,
  caller?: string,
): void {
  blackboard.set(objectLocationKey(objectId), placeEntityId, caller);
}

/**
 * Get the current location of an object.
 * Returns `undefined` if no location has been set.
 */
export function getObjectLocation(
  blackboard: Blackboard,
  objectId: string,
): number | undefined {
  const val = blackboard.get(objectLocationKey(objectId));
  return typeof val === "number" ? val : undefined;
}
