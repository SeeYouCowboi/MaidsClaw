import {
  SharedBlockRepo as SqliteSharedBlockRepo,
  type SharedBlock,
  type SharedBlockSection,
} from "../../../memory/shared-blocks/shared-block-repo.js";
import type { Db } from "../../database.js";
import type { SharedBlockRepo, SharedBlockAttachment } from "../contracts/shared-block-repo.js";

export class SqliteSharedBlockRepoAdapter implements SharedBlockRepo {
  constructor(
    private readonly impl: SqliteSharedBlockRepo,
    private readonly db: Db,
  ) {}

  async createBlock(title: string, createdByAgentId: string, options?: { retrievalOnly?: boolean }): Promise<SharedBlock> {
    return Promise.resolve(this.impl.createBlock(title, createdByAgentId, options));
  }

  async getBlock(blockId: number): Promise<SharedBlock | undefined> {
    return Promise.resolve(this.impl.getBlock(blockId));
  }

  async getSections(blockId: number): Promise<SharedBlockSection[]> {
    return Promise.resolve(this.impl.getSections(blockId));
  }

  async getSection(blockId: number, sectionPath: string): Promise<SharedBlockSection | undefined> {
    return Promise.resolve(this.impl.getSection(blockId, sectionPath));
  }

  async upsertSection(blockId: number, sectionPath: string, content: string, title = ""): Promise<void> {
    return Promise.resolve(this.impl.upsertSection(blockId, sectionPath, content, title));
  }

  async deleteSection(blockId: number, sectionPath: string): Promise<boolean> {
    return Promise.resolve(this.impl.deleteSection(blockId, sectionPath));
  }

  async renameSection(blockId: number, fromPath: string, toPath: string): Promise<boolean> {
    return Promise.resolve(this.impl.renameSection(blockId, fromPath, toPath));
  }

  async setTitle(blockId: number, title: string): Promise<void> {
    return Promise.resolve(this.impl.setTitle(blockId, title));
  }

  async sectionExists(blockId: number, sectionPath: string): Promise<boolean> {
    return Promise.resolve(this.impl.sectionExists(blockId, sectionPath));
  }

  async buildSnapshotJson(blockId: number): Promise<string> {
    return Promise.resolve(this.impl.buildSnapshotJson(blockId));
  }

  async writeSnapshot(blockId: number, snapshotSeq: number): Promise<void> {
    return Promise.resolve(this.impl.writeSnapshot(blockId, snapshotSeq));
  }

  async getAttachedBlockIds(targetKind: string, targetId: string): Promise<number[]> {
    const rows = this.db.query<{ block_id: number }>(
      `SELECT block_id FROM shared_block_attachments WHERE target_kind = ? AND target_id = ?`,
      [targetKind, targetId],
    );
    return Promise.resolve(rows.map((r) => r.block_id));
  }

  async isBlockAdmin(blockId: number, agentId: string): Promise<boolean> {
    const ownerRow = this.db.get<{ x: number }>(
      `SELECT 1 AS x FROM shared_blocks WHERE id = ? AND created_by_agent_id = ?`,
      [blockId, agentId],
    );
    if (ownerRow !== undefined) return true;

    const adminRow = this.db.get<{ x: number }>(
      `SELECT 1 AS x FROM shared_block_admins WHERE block_id = ? AND agent_id = ?`,
      [blockId, agentId],
    );
    return adminRow !== undefined;
  }

  async attachBlock(
    blockId: number,
    targetId: string,
    attachedByAgentId: string,
  ): Promise<SharedBlockAttachment> {
    const now = Date.now();
    const result = this.db.run(
      `INSERT OR IGNORE INTO shared_block_attachments (block_id, target_kind, target_id, attached_by_agent_id, attached_at) VALUES (?, 'agent', ?, ?, ?)`,
      [blockId, targetId, attachedByAgentId, now],
    );

    const id = Number(result.lastInsertRowid);
    if (id === 0) {
      const existing = this.db.get<{
        id: number;
        block_id: number;
        target_kind: string;
        target_id: string;
        attached_by_agent_id: string;
        attached_at: number;
      }>(
        `SELECT id, block_id, target_kind, target_id, attached_by_agent_id, attached_at FROM shared_block_attachments WHERE block_id = ? AND target_kind = 'agent' AND target_id = ?`,
        [blockId, targetId],
      );
      if (!existing) throw new Error(`Attachment for block ${blockId} and target ${targetId} not found after INSERT OR IGNORE`);
      return {
        id: existing.id,
        blockId: existing.block_id,
        targetKind: "agent",
        targetId: existing.target_id,
        attachedByAgentId: existing.attached_by_agent_id,
        attachedAt: existing.attached_at,
      };
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

  async detachBlock(blockId: number, targetId: string): Promise<boolean> {
    const result = this.db.run(
      `DELETE FROM shared_block_attachments WHERE block_id = ? AND target_kind = 'agent' AND target_id = ?`,
      [blockId, targetId],
    );
    return result.changes > 0;
  }

  async getAttachments(targetKind: "agent", targetId: string): Promise<SharedBlockAttachment[]> {
    const rows = this.db.query<{
      id: number;
      block_id: number;
      target_kind: string;
      target_id: string;
      attached_by_agent_id: string;
      attached_at: number;
    }>(
      `SELECT id, block_id, target_kind, target_id, attached_by_agent_id, attached_at FROM shared_block_attachments WHERE target_kind = ? AND target_id = ?`,
      [targetKind, targetId],
    );
    return rows.map((row) => ({
      id: row.id,
      blockId: row.block_id,
      targetKind: "agent" as const,
      targetId: row.target_id,
      attachedByAgentId: row.attached_by_agent_id,
      attachedAt: row.attached_at,
    }));
  }
}
