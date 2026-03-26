import { SharedBlockPermissions } from "./shared-block-permissions.js";

type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

export type SharedBlockAttachment = {
  id: number;
  blockId: number;
  targetKind: "agent";
  targetId: string;
  attachedByAgentId: string;
  attachedAt: number;
};

export class SharedBlockAttachService {
  private readonly permissions: SharedBlockPermissions;

  constructor(private readonly db: DbLike) {
    this.permissions = new SharedBlockPermissions(db);
  }

  attachBlock(blockId: number, targetId: string, attachedByAgentId: string): SharedBlockAttachment {
    const block = this.db.prepare(`SELECT id FROM shared_blocks WHERE id = ?`).get(blockId);
    if (!block) throw new Error(`Shared block ${blockId} not found`);

    if (!this.permissions.isAdmin(blockId, attachedByAgentId)) {
      throw new Error(`Agent ${attachedByAgentId} is not admin of block ${blockId}`);
    }

    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO shared_block_attachments (block_id, target_kind, target_id, attached_by_agent_id, attached_at) VALUES (?, 'agent', ?, ?, ?)`,
      )
      .run(blockId, targetId, attachedByAgentId, now);

    const id = Number(result.lastInsertRowid);
    if (id === 0) {
      const existing = this.db
        .prepare(
          `SELECT id, block_id, target_kind, target_id, attached_by_agent_id, attached_at FROM shared_block_attachments WHERE block_id = ? AND target_kind = 'agent' AND target_id = ?`,
        )
        .get(blockId, targetId) as {
        id: number;
        block_id: number;
        target_kind: "agent";
        target_id: string;
        attached_by_agent_id: string;
        attached_at: number;
      };
      return toAttachment(existing);
    }

    return {
      id,
      blockId,
      targetKind: "agent",
      targetId,
      attachedByAgentId,
      attachedAt: now,
    };
  }

  detachBlock(blockId: number, targetId: string, requestingAgentId: string): boolean {
    if (!this.permissions.isAdmin(blockId, requestingAgentId)) {
      throw new Error(`Agent ${requestingAgentId} is not admin of block ${blockId}`);
    }

    const result = this.db
      .prepare(
        `DELETE FROM shared_block_attachments WHERE block_id = ? AND target_kind = 'agent' AND target_id = ?`,
      )
      .run(blockId, targetId);
    return result.changes > 0;
  }

  getAttachments(targetKind: "agent", targetId: string): SharedBlockAttachment[] {
    const rows = this.db
      .prepare(
        `SELECT id, block_id, target_kind, target_id, attached_by_agent_id, attached_at FROM shared_block_attachments WHERE target_kind = ? AND target_id = ?`,
      )
      .all(targetKind, targetId) as Array<{
      id: number;
      block_id: number;
      target_kind: "agent";
      target_id: string;
      attached_by_agent_id: string;
      attached_at: number;
    }>;
    return rows.map(toAttachment);
  }
}

function toAttachment(row: {
  id: number;
  block_id: number;
  target_kind: "agent";
  target_id: string;
  attached_by_agent_id: string;
  attached_at: number;
}): SharedBlockAttachment {
  return {
    id: row.id,
    blockId: row.block_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    attachedByAgentId: row.attached_by_agent_id,
    attachedAt: row.attached_at,
  };
}
