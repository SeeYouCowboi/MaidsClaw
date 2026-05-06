/**
 * Alias Backfill — seeds known canonical pointer-key aliases into
 * `entity_aliases` via the lifecycle-aware path on AliasRepo.
 *
 * Why this exists
 * ---------------
 * The runtime canonicalizer (`src/runtime/canonicalize-pointer-keys.ts`)
 * relies on `AliasRepo.resolveAlias()` to converge surface forms (e.g.
 * `flower_garden`, `loc:flower_garden`, `花房`) onto a single canonical
 * pointer key (e.g. `loc:花房`) before pointer-key arrays are persisted on
 * episode/cognition rows. Without DB-backed aliases, two surface forms for
 * the same place become two distinct entity references and break multi-hop
 * graph retrieval (e.g. T88 "花房那个人有没有见过我 → Alice").
 *
 * This utility is intentionally *deterministic* and *idempotent*:
 *   - It only inserts aliases for canonical pointer keys that already exist
 *     as `entity_nodes` rows. It NEVER creates entities.
 *   - Re-running the backfill produces no duplicate `status='active'` rows
 *     thanks to `idx_entity_aliases_active_unique` and the lifecycle-aware
 *     `createAliasWithLifecycle()` path which short-circuits when an active
 *     row already points to the same canonical entity.
 *   - If a target canonical pointer key is missing, the backfill records it
 *     under `missingTargets` and SKIPS the insert (no invented entities, no
 *     dangling `pending_review` rows with bogus canonical_id).
 *
 * Distinct watches: gold (`item:金怀表`) and silver (`item:银怀表`) are seeded
 * as SEPARATE canonical entities. Their alias sets MUST NOT overlap.
 */

import type postgres from "postgres";
import { PgAliasRepo } from "../storage/domain-repos/pg/alias-repo.js";
import type { AliasRepo, AliasLifecycleStatusValue } from "../storage/domain-repos/contracts/alias-repo.js";

/** A single seed alias mapping: surface alias string → canonical pointer key. */
export type AliasSeed = {
  /** The surface form to register as an alias (e.g. `flower_garden`, `花房`). */
  alias: string;
  /**
   * The canonical pointer key of the target `entity_nodes` row.
   * Backfill resolves this to a canonical_id via `findEntityByPointerKey`.
   */
  canonicalPointerKey: string;
  /** Memory scope of the target entity. Defaults to `shared_public`. */
  memoryScope?: string;
  /** Optional alias type tag (e.g. `loc`, `char`, `item`). */
  aliasType?: string;
  /** Optional owner agent (private alias). When omitted, alias is shared. */
  ownerAgentId?: string;
};

export type AliasBackfillResult = {
  /** Aliases that ended up as `status='active'` (either pre-existing or freshly inserted). */
  activated: AliasSeed[];
  /**
   * Aliases that conflicted with an existing active mapping pointing to a
   * DIFFERENT canonical_id. These were appended as `status='conflicted'` rows
   * by the lifecycle-aware createAlias path; the existing active mapping is
   * preserved untouched.
   */
  conflicted: AliasSeed[];
  /**
   * Aliases whose target canonical pointer key did NOT resolve to an existing
   * entity_nodes row. These are SKIPPED (no insert) — backfill MUST NOT invent
   * entities. Surface them upstream for review.
   */
  missingTargets: AliasSeed[];
};

/**
 * Default canonical pointer-key alias seeds for the maid household world.
 *
 * Grouped by canonical entity:
 *   - loc:花房          ← flower_garden, 花房, loc:flower_garden
 *   - char:管家         ← 管家, char:管家
 *   - loc:茶室          ← 茶室, loc:茶室
 *   - item:银怀表       ← silver_pocket_watch, item:silver_pocket_watch, 银怀表
 *   - item:金怀表       ← 金怀表
 *
 * INVARIANT: gold (`item:金怀表`) and silver (`item:银怀表`) are SEPARATE
 * canonical entities. Their alias sets are intentionally disjoint.
 */
export const DEFAULT_ALIAS_SEEDS: readonly AliasSeed[] = Object.freeze([
  { alias: "loc:flower_garden", canonicalPointerKey: "loc:花房", aliasType: "loc" },
  { alias: "flower_garden", canonicalPointerKey: "loc:花房", aliasType: "loc" },
  { alias: "花房", canonicalPointerKey: "loc:花房", aliasType: "loc" },
  { alias: "管家", canonicalPointerKey: "char:管家", aliasType: "char" },
  { alias: "char:管家", canonicalPointerKey: "char:管家", aliasType: "char" },
  { alias: "loc:茶室", canonicalPointerKey: "loc:茶室", aliasType: "loc" },
  { alias: "茶室", canonicalPointerKey: "loc:茶室", aliasType: "loc" },
  { alias: "silver_pocket_watch", canonicalPointerKey: "item:银怀表", aliasType: "item" },
  { alias: "item:silver_pocket_watch", canonicalPointerKey: "item:银怀表", aliasType: "item" },
  { alias: "银怀表", canonicalPointerKey: "item:银怀表", aliasType: "item" },
  { alias: "金怀表", canonicalPointerKey: "item:金怀表", aliasType: "item" },
]);

/**
 * Backfill seed aliases through the lifecycle-aware AliasRepo path.
 *
 * Behaviour per seed:
 *   1. Resolve `canonicalPointerKey` → entity_nodes row via
 *      `findEntityByPointerKey(pointerKey, scope)`. If missing → record under
 *      `missingTargets` and SKIP (no insert, no invented entity).
 *   2. Otherwise call `createAliasWithLifecycle({...status: 'active'})`. The
 *      lifecycle path will:
 *        - return early (idempotent) if an active row already points to the
 *          same canonical_id;
 *        - append a `status='conflicted'` row (preserving the existing active
 *          mapping) when a different active canonical_id is registered.
 *   3. Re-read the lifecycle status to classify the outcome (`active` →
 *      activated; `conflicted` → conflicted).
 */
export async function backfillCanonicalAliases(
  aliasRepo: AliasRepo,
  seeds: readonly AliasSeed[] = DEFAULT_ALIAS_SEEDS,
): Promise<AliasBackfillResult> {
  const result: AliasBackfillResult = {
    activated: [],
    conflicted: [],
    missingTargets: [],
  };

  for (const seed of seeds) {
    const scope = seed.memoryScope ?? "shared_public";
    const target = await aliasRepo.findEntityByPointerKey(
      seed.canonicalPointerKey,
      scope,
      seed.ownerAgentId,
    );

    if (!target) {
      result.missingTargets.push(seed);
      continue;
    }

    await aliasRepo.createAliasWithLifecycle({
      canonicalId: target.id,
      alias: seed.alias,
      aliasType: seed.aliasType,
      ownerAgentId: seed.ownerAgentId,
      status: "active",
      sourceKind: "alias_backfill",
      sourceRef: `seed:${seed.canonicalPointerKey}`,
    });

    const status: AliasLifecycleStatusValue | undefined = (
      await aliasRepo.getAliasLifecycleStatus(seed.alias, seed.ownerAgentId)
    )?.status;

    if (status === "active") {
      const resolvedId = await aliasRepo.resolveAlias(seed.alias, seed.ownerAgentId);
      if (resolvedId === target.id) {
        result.activated.push(seed);
      } else {
        result.conflicted.push(seed);
      }
    } else {
      result.conflicted.push(seed);
    }
  }

  return result;
}

/**
 * Convenience wrapper that constructs a PgAliasRepo from a postgres handle
 * and runs the backfill with the default seed set. Returns the structured
 * report for caller-side logging / verification.
 */
export async function runDefaultAliasBackfill(
  sql: postgres.Sql,
  seeds: readonly AliasSeed[] = DEFAULT_ALIAS_SEEDS,
): Promise<AliasBackfillResult> {
  const repo = new PgAliasRepo(sql);
  return backfillCanonicalAliases(repo, seeds);
}
