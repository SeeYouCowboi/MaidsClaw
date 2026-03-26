type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  transaction<T>(fn: () => T): T;
};

export type SharedBlock = {
  id: number;
  title: string;
  createdByAgentId: string;
  retrievalOnly: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SharedBlockSection = {
  id: number;
  blockId: number;
  sectionPath: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
};

export type SharedBlockSnapshot = {
  id: number;
  blockId: number;
  snapshotSeq: number;
  contentJson: string;
  createdAt: number;
};

export class SharedBlockRepo {
  constructor(private readonly db: DbLike) {}

  createBlock(title: string, createdByAgentId: string, options?: { retrievalOnly?: boolean }): SharedBlock {
    const now = Date.now();
    const retrievalOnly = options?.retrievalOnly ?? false;
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO shared_blocks (title, created_by_agent_id, retrieval_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(title, createdByAgentId, retrievalOnly ? 1 : 0, now, now);
      const blockId = Number(result.lastInsertRowid);

      this.db
        .prepare(
          `INSERT INTO shared_block_snapshots (block_id, snapshot_seq, content_json, created_at) VALUES (?, 0, '{}', ?)`,
        )
        .run(blockId, now);

      return {
        id: blockId,
        title,
        createdByAgentId,
        retrievalOnly,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  getBlock(blockId: number): SharedBlock | undefined {
    const row = this.db
      .prepare(`SELECT id, title, created_by_agent_id, retrieval_only, created_at, updated_at FROM shared_blocks WHERE id = ?`)
      .get(blockId) as
      | { id: number; title: string; created_by_agent_id: string; retrieval_only: number; created_at: number; updated_at: number }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      createdByAgentId: row.created_by_agent_id,
      retrievalOnly: row.retrieval_only !== 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getSections(blockId: number): SharedBlockSection[] {
    const rows = this.db
      .prepare(
        `SELECT id, block_id, section_path, title, content, created_at, updated_at FROM shared_block_sections WHERE block_id = ? ORDER BY section_path`,
      )
      .all(blockId) as Array<{
      id: number;
      block_id: number;
      section_path: string;
      title: string;
      content: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      blockId: r.block_id,
      sectionPath: r.section_path,
      title: r.title,
      content: r.content,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  getSection(blockId: number, sectionPath: string): SharedBlockSection | undefined {
    const row = this.db
      .prepare(
        `SELECT id, block_id, section_path, title, content, created_at, updated_at FROM shared_block_sections WHERE block_id = ? AND section_path = ?`,
      )
      .get(blockId, sectionPath) as
      | {
          id: number;
          block_id: number;
          section_path: string;
          title: string;
          content: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      blockId: row.block_id,
      sectionPath: row.section_path,
      title: row.title,
      content: row.content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertSection(blockId: number, sectionPath: string, content: string, title = ""): void {
    const now = Date.now();
    const existing = this.db
      .prepare(`SELECT id FROM shared_block_sections WHERE block_id = ? AND section_path = ?`)
      .get(blockId, sectionPath) as { id: number } | undefined;

    if (existing) {
      this.db
        .prepare(`UPDATE shared_block_sections SET content = ?, title = ?, updated_at = ? WHERE id = ?`)
        .run(content, title, now, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO shared_block_sections (block_id, section_path, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(blockId, sectionPath, title, content, now, now);
    }
    this.touchBlock(blockId, now);
  }

  deleteSection(blockId: number, sectionPath: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM shared_block_sections WHERE block_id = ? AND section_path = ?`)
      .run(blockId, sectionPath);
    if ((result as unknown as { changes: number }).changes > 0) {
      this.touchBlock(blockId);
      return true;
    }
    return false;
  }

  renameSection(blockId: number, fromPath: string, toPath: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE shared_block_sections SET section_path = ?, updated_at = ? WHERE block_id = ? AND section_path = ?`,
      )
      .run(toPath, now, blockId, fromPath);
    if ((result as unknown as { changes: number }).changes > 0) {
      this.touchBlock(blockId, now);
      return true;
    }
    return false;
  }

  setTitle(blockId: number, title: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE shared_blocks SET title = ?, updated_at = ? WHERE id = ?`).run(title, now, blockId);
  }

  sectionExists(blockId: number, sectionPath: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM shared_block_sections WHERE block_id = ? AND section_path = ?`)
      .get(blockId, sectionPath);
    return row !== undefined && row !== null;
  }

  buildSnapshotJson(blockId: number): string {
    const sections = this.getSections(blockId);
    const map: Record<string, string> = {};
    for (const s of sections) {
      map[s.sectionPath] = s.content;
    }
    return JSON.stringify(map);
  }

  writeSnapshot(blockId: number, snapshotSeq: number): void {
    const contentJson = this.buildSnapshotJson(blockId);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO shared_block_snapshots (block_id, snapshot_seq, content_json, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(blockId, snapshotSeq, contentJson, now);
  }

  private touchBlock(blockId: number, now?: number): void {
    this.db.prepare(`UPDATE shared_blocks SET updated_at = ? WHERE id = ?`).run(now ?? Date.now(), blockId);
  }
}
