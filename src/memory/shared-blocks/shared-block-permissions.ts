type DbLike = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
  };
};

export type SharedBlockRole = "owner" | "admin" | "member" | "none";

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

  isMember(blockId: number, agentId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM shared_block_attachments WHERE block_id = ? AND target_kind = 'agent' AND target_id = ?`,
      )
      .get(blockId, agentId);
    return row !== undefined && row !== null;
  }

  canEdit(blockId: number, agentId: string): boolean {
    return this.isAdmin(blockId, agentId);
  }

  canRead(blockId: number, agentId: string): boolean {
    if (this.isAdmin(blockId, agentId)) return true;
    return this.isMember(blockId, agentId);
  }

  /**
   * Only the owner (not admins) can grant admin privileges on a shared block.
   */
  canGrantAdmin(blockId: number, agentId: string): boolean {
    return this.isOwner(blockId, agentId);
  }

  /**
   * Returns the role of an agent for a given shared block.
   *
   * Precedence: owner > admin > member > none
   */
  getRole(blockId: number, agentId: string): SharedBlockRole {
    if (this.isOwner(blockId, agentId)) return "owner";
    // Check admin table directly (not isAdmin, which includes owner)
    const adminRow = this.db
      .prepare(`SELECT 1 FROM shared_block_admins WHERE block_id = ? AND agent_id = ?`)
      .get(blockId, agentId);
    if (adminRow !== undefined && adminRow !== null) return "admin";
    if (this.isMember(blockId, agentId)) return "member";
    return "none";
  }

  /**
   * Check whether a shared block is marked as retrieval-only.
   *
   * Retrieval-only blocks are **not** injected into prompts; they are
   * only available via explicit retrieval queries.
   */
  isRetrievalOnly(blockId: number): boolean {
    const row = this.db
      .prepare(`SELECT retrieval_only FROM shared_blocks WHERE id = ?`)
      .get(blockId) as { retrieval_only: number } | undefined | null;
    if (!row) return false;
    return row.retrieval_only !== 0;
  }
}
