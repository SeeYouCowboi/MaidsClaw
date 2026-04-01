/**
 * Blackboard — Shared Operational State (V1)
 *
 * V1 implementation: simple `Map<string, unknown>` with namespace enforcement.
 * In-memory only (per G1 guardrail).
 *
 * Future versions may add persistence, typed merge strategies, and
 * per-key ownership tracking. The interface is designed to support
 * those upgrades without signature changes.
 */

import { MaidsClawError } from "../core/errors.js";
import {
  type NamespaceDefinition,
  resolveNamespace,
} from "./namespaces.js";

// ---------------------------------------------------------------------------
// Blackboard
// ---------------------------------------------------------------------------

export class Blackboard {
  /** The underlying in-memory store. V1: no persistence. */
  private readonly store = new Map<string, unknown>();

  // -----------------------------------------------------------------------
  // Write
  // -----------------------------------------------------------------------

  /**
   * Set a key on the blackboard.
   *
   * @param key   — Must start with a known, non-reserved namespace prefix.
   * @param value — Arbitrary value (typed consumers cast on read).
   * @param caller — Optional caller identity for namespace ownership enforcement.
   *                 When the namespace has a `singleWriter`, the caller MUST match.
   *
   * @throws MaidsClawError BLACKBOARD_INVALID_NAMESPACE  — key has no known prefix.
   * @throws MaidsClawError BLACKBOARD_NAMESPACE_RESERVED — key belongs to a reserved namespace.
   * @throws MaidsClawError BLACKBOARD_OWNERSHIP_VIOLATION — caller does not match singleWriter.
   */
  set(key: string, value: unknown, caller?: string): void {
    const ns = this.validateKey(key);
    this.validateOwnership(ns, caller);
    this.store.set(key, value);
  }

  // -----------------------------------------------------------------------
  // Read
  // -----------------------------------------------------------------------

  /**
   * Get a value by key.
   * Returns `undefined` if the key does not exist (no namespace validation on reads).
   */
  get(key: string): unknown {
    return this.store.get(key);
  }

  /**
   * Check whether a key exists on the blackboard.
   */
  has(key: string): boolean {
    return this.store.has(key);
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  /**
   * Delete a key from the blackboard.
   * Validates namespace before allowing deletion.
   */
  delete(key: string, caller?: string): boolean {
    const ns = this.validateKey(key);
    this.validateOwnership(ns, caller);
    return this.store.delete(key);
  }

  // -----------------------------------------------------------------------
  // Namespace query
  // -----------------------------------------------------------------------

  /**
   * Return all key-value pairs under the given namespace prefix.
   *
   * @param prefix — Namespace prefix (e.g. "session.", "agent_runtime.").
   * @returns A plain object snapshot of matching entries.
   */
  getNamespace(prefix: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix)) {
        result[k] = v;
      }
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  /** Number of entries currently stored. */
  get size(): number {
    return this.store.size;
  }

  /** Remove all entries. Intended for testing / session reset. */
  clear(): void {
    this.store.clear();
  }

  /** Return all keys (snapshot). */
  keys(): string[] {
    return [...this.store.keys()];
  }

  // -----------------------------------------------------------------------
  // Internal validation
  // -----------------------------------------------------------------------

  /**
   * Validate that a key belongs to a known, non-reserved namespace.
   * @returns The resolved NamespaceDefinition.
   */
  private validateKey(key: string): NamespaceDefinition {
    const ns = resolveNamespace(key);

    if (ns === undefined) {
      throw new MaidsClawError({
        code: "BLACKBOARD_INVALID_NAMESPACE",
        message: `Key "${key}" does not match any known blackboard namespace prefix`,
        retriable: false,
        details: { key },
      });
    }

    if (ns.reserved) {
      throw new MaidsClawError({
        code: "BLACKBOARD_NAMESPACE_RESERVED",
        message: `Namespace "${ns.prefix}" is reserved and cannot be written to in V1`,
        retriable: false,
        details: { key, namespace: ns.prefix },
      });
    }

    return ns;
  }

  /**
   * Validate caller ownership when the namespace defines a singleWriter.
   */
  private validateOwnership(ns: NamespaceDefinition, caller?: string): void {
    if (ns.singleWriter !== null && caller !== ns.singleWriter) {
      throw new MaidsClawError({
        code: "BLACKBOARD_OWNERSHIP_VIOLATION",
        message: `Namespace "${ns.prefix}" requires caller "${ns.singleWriter}", got "${caller ?? '(none)'}"`,
        retriable: false,
        details: {
          namespace: ns.prefix,
          expectedCaller: ns.singleWriter,
          actualCaller: caller ?? null,
        },
      });
    }
  }
}
