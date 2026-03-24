import type { Db } from "../storage/database.js";
import type { CoreMemoryBlock, CoreMemoryLabel, AppendResult, ReplaceResult } from "./types.js";
import { COMPAT_ALIAS_MAP, READ_ONLY_LABELS } from "./types.js";

const BLOCK_DEFAULTS: ReadonlyArray<{
  label: CoreMemoryLabel;
  description: string;
  char_limit: number;
  read_only: number;
}> = [
  { label: "character", description: "Agent persona and identity (legacy, read-only)", char_limit: 4000, read_only: 1 },
  { label: "user", description: "Information about the user (legacy, read-only)", char_limit: 3000, read_only: 1 },
  { label: "index", description: "Memory index with pointer addresses", char_limit: 1500, read_only: 1 },
  { label: "pinned_summary", description: "Pinned character summary (canonical)", char_limit: 4000, read_only: 0 },
  { label: "pinned_index", description: "Pinned memory index (canonical, no RP direct-write)", char_limit: 1500, read_only: 1 },
  { label: "persona", description: "Agent persona, identity, and behavioral traits", char_limit: 4000, read_only: 0 },
];

function isReadOnlyForRp(label: CoreMemoryLabel): boolean {
  return READ_ONLY_LABELS.includes(label);
}

export function resolveCanonicalLabel(label: CoreMemoryLabel): CoreMemoryLabel {
  return (COMPAT_ALIAS_MAP as Record<string, CoreMemoryLabel>)[label] ?? label;
}

export class CoreMemoryService {
  constructor(private readonly db: Db) {}

  initializeBlocks(agentId: string): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO core_memory_blocks (agent_id, label, description, value, char_limit, read_only, updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?)`,
    );
    const now = Date.now();
    for (const def of BLOCK_DEFAULTS) {
      stmt.run(agentId, def.label, def.description, def.char_limit, def.read_only, now);
    }
  }

  getBlock(
    agentId: string,
    label: CoreMemoryLabel,
  ): CoreMemoryBlock & { chars_current: number; chars_limit: number } {
    const row = this.db
      .prepare(`SELECT * FROM core_memory_blocks WHERE agent_id = ? AND label = ?`)
      .get(agentId, label) as CoreMemoryBlock | null;

    if (!row) {
      throw new Error(`Block not found: ${agentId}/${label}`);
    }

    return {
      ...row,
      chars_current: row.value.length,
      chars_limit: row.char_limit,
    };
  }

  getAllBlocks(agentId: string): Array<CoreMemoryBlock & { chars_current: number }> {
    const rows = this.db
      .prepare(`SELECT * FROM core_memory_blocks WHERE agent_id = ? ORDER BY label`)
      .all(agentId) as CoreMemoryBlock[];

    return rows.map((row) => ({
      ...row,
      chars_current: row.value.length,
    }));
  }

  appendBlock(
    agentId: string,
    label: CoreMemoryLabel,
    content: string,
    callerRole?: string,
  ): AppendResult {
    const block = this.getBlock(agentId, label);

    if (isReadOnlyForRp(label) && callerRole !== "task-agent") {
      return {
        success: false,
        remaining: 0,
        limit: block.char_limit,
        current: block.value.length,
      };
    }

    const newValue = block.value + content;

    if (newValue.length > block.char_limit) {
      return {
        success: false,
        remaining: block.char_limit - block.value.length,
        limit: block.char_limit,
        current: block.value.length,
      };
    }

    this.db
      .prepare(
        `UPDATE core_memory_blocks SET value = ?, updated_at = ? WHERE agent_id = ? AND label = ?`,
      )
      .run(newValue, Date.now(), agentId, label);

    return {
      success: true,
      chars_current: newValue.length,
      chars_limit: block.char_limit,
    };
  }

  replaceBlock(
    agentId: string,
    label: CoreMemoryLabel,
    oldText: string,
    newText: string,
    callerRole?: string,
  ): ReplaceResult {
    const block = this.getBlock(agentId, label);

    if (isReadOnlyForRp(label) && callerRole !== "task-agent") {
      return { success: false, reason: `${label} block is read-only for RP Agent` };
    }

    if (!block.value.includes(oldText)) {
      return { success: false, reason: "old_content not found in block" };
    }

    // First occurrence only
    const newValue = block.value.replace(oldText, newText);

    if (newValue.length > block.char_limit) {
      return { success: false, reason: "replacement would exceed char_limit" };
    }

    this.db
      .prepare(
        `UPDATE core_memory_blocks SET value = ?, updated_at = ? WHERE agent_id = ? AND label = ?`,
      )
      .run(newValue, Date.now(), agentId, label);

    return {
      success: true,
      chars_current: newValue.length,
    };
  }
}
