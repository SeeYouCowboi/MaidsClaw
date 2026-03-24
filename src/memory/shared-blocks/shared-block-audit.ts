type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  transaction<T>(fn: () => T): T;
};

export type BlockPatchEntry = {
  patchSeq: number;
  op: string;
  sectionPath: string | null;
  targetPath: string | null;
  content: string | null;
  beforeValue: string | null;
  afterValue: string | null;
  sourceRef: string;
  appliedByAgentId: string;
  appliedAt: number;
};

export type BlockSnapshotMeta = {
  snapshotSeq: number;
  createdAt: number;
};

export type BlockSnapshot = BlockSnapshotMeta & {
  contentJson: string;
};

export type BlockAuditView = {
  blockId: number;
  title: string;
  createdByAgentId: string;
  createdAt: number;
  updatedAt: number;
  totalPatches: number;
  latestPatchSeq: number | null;
  totalSnapshots: number;
  latestSnapshotSeq: number | null;
  recentPatches: BlockPatchEntry[];
};

type PatchRow = {
  patch_seq: number;
  op: string;
  section_path: string | null;
  target_path: string | null;
  content: string | null;
  before_value: string | null;
  after_value: string | null;
  source_ref: string;
  applied_by_agent_id: string;
  applied_at: number;
};

type SnapshotMetaRow = {
  snapshot_seq: number;
  created_at: number;
};

type SnapshotRow = SnapshotMetaRow & {
  content_json: string;
};

type BlockRow = {
  id: number;
  title: string;
  created_by_agent_id: string;
  created_at: number;
  updated_at: number;
};

type CountRow = {
  cnt: number;
  max_seq: number | null;
};

export class SharedBlockAuditFacade {
  constructor(private readonly db: DbLike) {}

  listBlockPatches(blockId: number, options?: { limit?: number; sinceSeq?: number }): BlockPatchEntry[] {
    const limit = options?.limit ?? 1000;
    const sinceSeq = options?.sinceSeq ?? 0;

    const rows = this.db
      .prepare(
        `SELECT patch_seq, op, section_path, target_path, content, before_value, after_value, source_ref, applied_by_agent_id, applied_at FROM shared_block_patch_log WHERE block_id = ? AND patch_seq > ? ORDER BY patch_seq ASC LIMIT ?`,
      )
      .all(blockId, sinceSeq, limit) as PatchRow[];

    return rows.map((r) => ({
      patchSeq: r.patch_seq,
      op: r.op,
      sectionPath: r.section_path,
      targetPath: r.target_path,
      content: r.content,
      beforeValue: r.before_value,
      afterValue: r.after_value,
      sourceRef: r.source_ref,
      appliedByAgentId: r.applied_by_agent_id,
      appliedAt: r.applied_at,
    }));
  }

  listBlockSnapshots(blockId: number, options?: { limit?: number }): BlockSnapshotMeta[] {
    const limit = options?.limit ?? 1000;

    const rows = this.db
      .prepare(
        `SELECT snapshot_seq, created_at FROM shared_block_snapshots WHERE block_id = ? ORDER BY snapshot_seq ASC LIMIT ?`,
      )
      .all(blockId, limit) as SnapshotMetaRow[];

    return rows.map((r) => ({
      snapshotSeq: r.snapshot_seq,
      createdAt: r.created_at,
    }));
  }

  getBlockSnapshot(blockId: number, snapshotSeq: number): BlockSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT snapshot_seq, content_json, created_at FROM shared_block_snapshots WHERE block_id = ? AND snapshot_seq = ?`,
      )
      .get(blockId, snapshotSeq) as SnapshotRow | undefined;

    if (!row) return null;

    return {
      snapshotSeq: row.snapshot_seq,
      createdAt: row.created_at,
      contentJson: row.content_json,
    };
  }

  getBlockAuditView(blockId: number): BlockAuditView {
    const block = this.db
      .prepare(`SELECT id, title, created_by_agent_id, created_at, updated_at FROM shared_blocks WHERE id = ?`)
      .get(blockId) as BlockRow | undefined;

    if (!block) {
      throw new Error(`Block ${blockId} not found`);
    }

    const patchStats = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt, MAX(patch_seq) AS max_seq FROM shared_block_patch_log WHERE block_id = ?`,
      )
      .get(blockId) as CountRow;

    const snapshotStats = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt, MAX(snapshot_seq) AS max_seq FROM shared_block_snapshots WHERE block_id = ?`,
      )
      .get(blockId) as CountRow;

    const recentPatchRows = this.db
      .prepare(
        `SELECT patch_seq, op, section_path, target_path, content, before_value, after_value, source_ref, applied_by_agent_id, applied_at FROM shared_block_patch_log WHERE block_id = ? ORDER BY patch_seq DESC LIMIT 5`,
      )
      .all(blockId) as PatchRow[];

    const recentPatches: BlockPatchEntry[] = recentPatchRows
      .reverse()
      .map((r) => ({
        patchSeq: r.patch_seq,
        op: r.op,
        sectionPath: r.section_path,
        targetPath: r.target_path,
        content: r.content,
        beforeValue: r.before_value,
        afterValue: r.after_value,
        sourceRef: r.source_ref,
        appliedByAgentId: r.applied_by_agent_id,
        appliedAt: r.applied_at,
      }));

    return {
      blockId: block.id,
      title: block.title,
      createdByAgentId: block.created_by_agent_id,
      createdAt: block.created_at,
      updatedAt: block.updated_at,
      totalPatches: patchStats.cnt,
      latestPatchSeq: patchStats.max_seq,
      totalSnapshots: snapshotStats.cnt,
      latestSnapshotSeq: snapshotStats.max_seq,
      recentPatches,
    };
  }
}
