/**
 * State module — Shared Operational State / Blackboard
 *
 * Re-exports the Blackboard class, namespace definitions,
 * and location helper functions.
 */

export { Blackboard } from "./blackboard.js";

export {
  type MergeRule,
  type NamespaceDefinition,
  V1_NAMESPACES,
  ACTIVE_PREFIXES,
  RESERVED_PREFIXES,
  resolveNamespace,
} from "./namespaces.js";

export {
  setAgentLocation,
  getAgentLocation,
  setObjectLocation,
  getObjectLocation,
} from "./location-helpers.js";
