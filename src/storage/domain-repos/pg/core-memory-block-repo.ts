import type postgres from "postgres";
import type {
  CoreMemoryBlockRepo,
  PersonaSnapshotInit,
} from "../contracts/core-memory-block-repo.js";
import type {
  AppendResult,
  CoreMemoryBlock,
  CoreMemoryLabel,
  ReplaceResult,
} from "../../../memory/types.js";

/** Labels that are read-only for RP agents (index, pinned_index, user). */
const RP_READ_ONLY: ReadonlySet<CoreMemoryLabel> = new Set([
  "index",
  "pinned_index",
  "user",
]);

const BLOCK_DEFAULTS: ReadonlyArray<{
  label: CoreMemoryLabel;
  description: string;
  char_limit: number;
  read_only: number;
}> = [
  {
    label: "user",
    description: "Information about the user (legacy, read-only)",
    char_limit: 3000,
    read_only: 1,
  },
  {
    label: "index",
    description: "Memory index with pointer addresses",
    char_limit: 1500,
    read_only: 1,
  },
  {
    label: "pinned_summary",
    description: "Pinned character summary (canonical)",
    char_limit: 4000,
    read_only: 0,
  },
  {
    label: "pinned_index",
    description: "Pinned memory index (canonical, no RP direct-write)",
    char_limit: 1500,
    read_only: 1,
  },
  {
    label: "persona",
    description: "Agent persona, identity, and behavioral traits",
    char_limit: 4000,
    read_only: 0,
  },
];

type CoreMemoryRow = {
  id: string;
  agent_id: string;
  label: string;
  description: string | null;
  value: string;
  char_limit: string | number;
  read_only: string | number;
  updated_at: string;
  snapshot_source?: string | null;
  snapshot_source_id?: string | null;
  snapshot_captured_at?: string | number | null;
};

function normalizeRow(row: CoreMemoryRow): CoreMemoryBlock {
  return {
    id: Number(row.id),
    agent_id: row.agent_id,
    label: row.label as CoreMemoryLabel,
    description: row.description,
    value: row.value,
    char_limit: Number(row.char_limit),
    read_only: Number(row.read_only),
    updated_at: Number(row.updated_at),
    snapshot_source: row.snapshot_source ?? null,
    snapshot_source_id: row.snapshot_source_id ?? null,
    snapshot_captured_at:
      row.snapshot_captured_at != null
        ? Number(row.snapshot_captured_at)
        : null,
  };
}

function isReadOnlyForRp(label: CoreMemoryLabel): boolean {
  return RP_READ_ONLY.has(label);
}

export class PgCoreMemoryBlockRepo implements CoreMemoryBlockRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async initializeBlocks(agentId: string): Promise<void> {
    const now = Date.now();
    for (const def of BLOCK_DEFAULTS) {
      await this.sql`
        INSERT INTO core_memory_blocks
          (agent_id, label, description, value, char_limit, read_only, updated_at)
        VALUES
          (${agentId}, ${def.label}, ${def.description}, '', ${def.char_limit}, ${def.read_only}, ${now})
        ON CONFLICT (agent_id, label) DO NOTHING
      `;
    }
  }

  async getBlock(
    agentId: string,
    label: CoreMemoryLabel,
  ): Promise<CoreMemoryBlock & { chars_current: number; chars_limit: number }> {
    const rows = await this.sql<CoreMemoryRow[]>`
      SELECT id, agent_id, label, description, value, char_limit, read_only, updated_at,
             snapshot_source, snapshot_source_id, snapshot_captured_at
      FROM core_memory_blocks
      WHERE agent_id = ${agentId} AND label = ${label}
      LIMIT 1
    `;

    if (rows.length === 0) {
      throw new Error(`Block not found: ${agentId}/${label}`);
    }

    const block = normalizeRow(rows[0]);
    return {
      ...block,
      chars_current: block.value.length,
      chars_limit: block.char_limit,
    };
  }

  async getAllBlocks(
    agentId: string,
  ): Promise<Array<CoreMemoryBlock & { chars_current: number }>> {
    const rows = await this.sql<CoreMemoryRow[]>`
      SELECT id, agent_id, label, description, value, char_limit, read_only, updated_at,
             snapshot_source, snapshot_source_id, snapshot_captured_at
      FROM core_memory_blocks
      WHERE agent_id = ${agentId}
      ORDER BY label
    `;

    return rows.map((row) => {
      const block = normalizeRow(row);
      return {
        ...block,
        chars_current: block.value.length,
      };
    });
  }

  async appendBlock(
    agentId: string,
    label: CoreMemoryLabel,
    content: string,
    callerRole?: string,
  ): Promise<AppendResult> {
    const block = await this.getBlock(agentId, label);

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

    await this.sql`
      UPDATE core_memory_blocks
      SET value = ${newValue}, updated_at = ${Date.now()}
      WHERE agent_id = ${agentId} AND label = ${label}
    `;

    return {
      success: true,
      chars_current: newValue.length,
      chars_limit: block.char_limit,
    };
  }

  async replaceBlock(
    agentId: string,
    label: CoreMemoryLabel,
    oldText: string,
    newText: string,
    callerRole?: string,
  ): Promise<ReplaceResult> {
    const block = await this.getBlock(agentId, label);

    if (isReadOnlyForRp(label) && callerRole !== "task-agent") {
      return {
        success: false,
        reason: `${label} block is read-only for RP Agent`,
      };
    }

    if (!block.value.includes(oldText)) {
      return { success: false, reason: "old_content not found in block" };
    }

    // First occurrence only
    const newValue = block.value.replace(oldText, newText);

    if (newValue.length > block.char_limit) {
      return { success: false, reason: "replacement would exceed char_limit" };
    }

    await this.sql`
      UPDATE core_memory_blocks
      SET value = ${newValue}, updated_at = ${Date.now()}
      WHERE agent_id = ${agentId} AND label = ${label}
    `;

    return {
      success: true,
      chars_current: newValue.length,
    };
  }

  async writePersonaSnapshot(
    agentId: string,
    init: PersonaSnapshotInit,
  ): Promise<boolean> {
    const rows = await this.sql<CoreMemoryRow[]>`
      SELECT id, value
      FROM core_memory_blocks
      WHERE agent_id = ${agentId} AND label = 'persona'
      LIMIT 1
    `;

    if (rows.length === 0) {
      return false;
    }

    if (rows[0].value.length > 0) {
      return false;
    }

    const truncated = init.content.slice(0, 4000);
    await this.sql`
      UPDATE core_memory_blocks
      SET value = ${truncated},
          snapshot_source = ${init.snapshot_source},
          snapshot_source_id = ${init.snapshot_source_id},
          snapshot_captured_at = ${init.snapshot_captured_at},
          updated_at = ${Date.now()}
      WHERE agent_id = ${agentId} AND label = 'persona' AND value = ''
    `;

    return true;
  }
}
