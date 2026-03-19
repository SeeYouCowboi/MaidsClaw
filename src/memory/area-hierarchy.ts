/**
 * AreaHierarchyService — manages parent-child relationships between area entities.
 *
 * Areas form a tree (not a DAG). Each area has at most one parent.
 * An agent in a leaf area can observe events scoped to any ancestor area.
 *
 * The hierarchy is stored in the `area_hierarchy` table:
 *   area_entity_id INTEGER PRIMARY KEY → parent_area_id INTEGER
 *
 * Root areas (no parent) have parent_area_id = NULL.
 */

import type { Db } from "../storage/database.js";

const MAX_DEPTH = 16;

export class AreaHierarchyService {
  constructor(private readonly db: Db) {}

  /**
   * Register or update the parent of an area.
   * Pass `null` for `parentAreaId` to make the area a root.
   */
  setParent(areaEntityId: number, parentAreaId: number | null): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO area_hierarchy (area_entity_id, parent_area_id)
         VALUES (?, ?)`,
      )
      .run(areaEntityId, parentAreaId);
  }

  /**
   * Get the direct parent of an area. Returns `null` if root or unregistered.
   */
  getParent(areaEntityId: number): number | null {
    const row = this.db
      .prepare(`SELECT parent_area_id FROM area_hierarchy WHERE area_entity_id = ?`)
      .get(areaEntityId) as { parent_area_id: number | null } | null;
    return row?.parent_area_id ?? null;
  }

  /**
   * Walk up the tree from `areaEntityId` and collect all ancestor IDs (excluding self).
   * Returns them in order: [parent, grandparent, ...].
   * Stops at the root or after MAX_DEPTH to guard against cycles.
   */
  getAncestors(areaEntityId: number): number[] {
    const ancestors: number[] = [];
    let current = areaEntityId;

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const parentId = this.getParent(current);
      if (parentId === null) {
        break;
      }
      ancestors.push(parentId);
      current = parentId;
    }

    return ancestors;
  }

  /**
   * Returns the full set of area IDs visible to an agent located in `areaEntityId`:
   *   [areaEntityId, parent, grandparent, ...]
   *
   * This is the set used for area_visible event filtering.
   */
  getVisibleAreaIds(areaEntityId: number): number[] {
    return [areaEntityId, ...this.getAncestors(areaEntityId)];
  }

  /**
   * Get the direct children of an area.
   */
  getChildren(areaEntityId: number): number[] {
    const rows = this.db
      .prepare(`SELECT area_entity_id FROM area_hierarchy WHERE parent_area_id = ?`)
      .all(areaEntityId) as { area_entity_id: number }[];
    return rows.map((row) => row.area_entity_id);
  }
}
