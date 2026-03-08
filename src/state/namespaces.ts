/**
 * Blackboard Namespace Contract — V1
 *
 * Defines the 5 active V1 namespaces plus 1 reserved namespace.
 * Each namespace has an owner task, allowed writers, and a merge rule.
 *
 * From plan § Blackboard Namespace Contract:
 *   session.*        — Owner: T27a (system)        — last-write-wins
 *   delegation.*     — Owner: T20a (Maiden)         — replace-by-delegation-id
 *   task.*           — Owner: T28a (Job Runtime)    — per-key owner
 *   agent_runtime.*  — Owner: T10 (Agent Loop)      — last-write-wins
 *   transport.*      — Owner: T26 (Gateway)         — last-write-wins
 *   autonomy.*       — RESERVED (rejected in V1)
 */

// ---------------------------------------------------------------------------
// Merge rules
// ---------------------------------------------------------------------------

/** Merge strategies used by namespace owners. */
export type MergeRule =
  | "last-write-wins"
  | "replace-by-delegation-id"
  | "per-key-owner";

// ---------------------------------------------------------------------------
// Namespace definition
// ---------------------------------------------------------------------------

export interface NamespaceDefinition {
  /** Dot-terminated prefix, e.g. "session." */
  readonly prefix: string;
  /** Owning task identifier (for documentation / future enforcement). */
  readonly owner: string;
  /** Merge strategy applied to writes within this namespace. */
  readonly mergeRule: MergeRule;
  /** If true, all writes are rejected in V1. */
  readonly reserved: boolean;
  /**
   * If non-null, only this caller identity may write to the namespace.
   * `null` means any caller is accepted (ownership is per-key, not namespace-wide).
   */
  readonly singleWriter: string | null;
}

// ---------------------------------------------------------------------------
// V1 namespace registry
// ---------------------------------------------------------------------------

export const V1_NAMESPACES: readonly NamespaceDefinition[] = [
  {
    prefix: "session.",
    owner: "T27a",
    mergeRule: "last-write-wins",
    reserved: false,
    singleWriter: "system",
  },
  {
    prefix: "delegation.",
    owner: "T20a",
    mergeRule: "replace-by-delegation-id",
    reserved: false,
    singleWriter: "maiden",
  },
  {
    prefix: "task.",
    owner: "T28a",
    mergeRule: "per-key-owner",
    reserved: false,
    singleWriter: null, // per-job worker — any caller OK at namespace level
  },
  {
    prefix: "agent_runtime.",
    owner: "T10",
    mergeRule: "last-write-wins",
    reserved: false,
    singleWriter: null, // per-agent — any caller OK at namespace level
  },
  {
    prefix: "transport.",
    owner: "T26",
    mergeRule: "last-write-wins",
    reserved: false,
    singleWriter: "gateway",
  },
  {
    prefix: "autonomy.",
    owner: "T28b",
    mergeRule: "last-write-wins", // irrelevant — reserved
    reserved: true,
    singleWriter: null,
  },
] as const;

/** Set of valid (non-reserved) namespace prefixes for fast lookup. */
export const ACTIVE_PREFIXES: ReadonlySet<string> = new Set(
  V1_NAMESPACES.filter((ns) => !ns.reserved).map((ns) => ns.prefix),
);

/** Set of reserved namespace prefixes. */
export const RESERVED_PREFIXES: ReadonlySet<string> = new Set(
  V1_NAMESPACES.filter((ns) => ns.reserved).map((ns) => ns.prefix),
);

/**
 * Resolve the namespace definition for a given key.
 * Returns `undefined` if the key does not match any known namespace prefix.
 */
export function resolveNamespace(key: string): NamespaceDefinition | undefined {
  for (const ns of V1_NAMESPACES) {
    if (key.startsWith(ns.prefix)) {
      return ns;
    }
  }
  return undefined;
}
