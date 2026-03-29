import {
  SharedBlockRepo as SqliteSharedBlockRepo,
  type SharedBlock,
  type SharedBlockSection,
} from "../../../memory/shared-blocks/shared-block-repo.js";
import type { Db } from "../../database.js";
import type { SharedBlockRepo } from "../contracts/shared-block-repo.js";

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
}
