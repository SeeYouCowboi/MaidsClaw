type DbLike = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
  };
};

export class SharedBlockPermissions {
  constructor(private readonly db: DbLike) {}

  isOwner(blockId: number, agentId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM shared_blocks WHERE id = ? AND created_by_agent_id = ?`)
      .get(blockId, agentId);
    return row !== undefined && row !== null;
  }

  isAdmin(blockId: number, agentId: string): boolean {
    if (this.isOwner(blockId, agentId)) return true;
    const row = this.db
      .prepare(`SELECT 1 FROM shared_block_admins WHERE block_id = ? AND agent_id = ?`)
      .get(blockId, agentId);
    return row !== undefined && row !== null;
  }

  canEdit(blockId: number, agentId: string): boolean {
    return this.isAdmin(blockId, agentId);
  }

  canRead(blockId: number, agentId: string): boolean {
    if (this.isAdmin(blockId, agentId)) return true;
    const row = this.db
      .prepare(
        `SELECT 1 FROM shared_block_attachments WHERE block_id = ? AND target_kind = 'agent' AND target_id = ?`,
      )
      .get(blockId, agentId);
    return row !== undefined && row !== null;
  }
}
