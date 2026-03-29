import type postgres from "postgres";
import type {
  SharedBlockRepo,
} from "../contracts/shared-block-repo.js";
import type {
  SharedBlock,
  SharedBlockSection,
} from "../../../memory/shared-blocks/shared-block-repo.js";

type SharedBlockRow = {
  id: string;
  title: string;
  created_by_agent_id: string;
  retrieval_only: number;
  created_at: string;
  updated_at: string;
};

type SectionRow = {
  id: string;
  block_id: string;
  section_path: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
};

function normalizeBlock(row: SharedBlockRow): SharedBlock {
  return {
    id: Number(row.id),
    title: row.title,
    createdByAgentId: row.created_by_agent_id,
    retrievalOnly: row.retrieval_only !== 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function normalizeSection(row: SectionRow): SharedBlockSection {
  return {
    id: Number(row.id),
    blockId: Number(row.block_id),
    sectionPath: row.section_path,
    title: row.title,
    content: row.content,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PgSharedBlockRepo implements SharedBlockRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async createBlock(
    title: string,
    createdByAgentId: string,
    options?: { retrievalOnly?: boolean },
  ): Promise<SharedBlock> {
    const now = Date.now();
    const retrievalOnly = options?.retrievalOnly ? 1 : 0;

    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO shared_blocks
        (title, created_by_agent_id, retrieval_only, created_at, updated_at)
      VALUES
        (${title}, ${createdByAgentId}, ${retrievalOnly}, ${now}, ${now})
      RETURNING id
    `;
    const blockId = Number(rows[0].id);

    await this.sql`
      INSERT INTO shared_block_snapshots
        (block_id, snapshot_seq, content_json, created_at)
      VALUES
        (${blockId}, 0, ${this.sql.json({} as never)}, ${now})
    `;

    return {
      id: blockId,
      title,
      createdByAgentId,
      retrievalOnly: retrievalOnly !== 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getBlock(blockId: number): Promise<SharedBlock | undefined> {
    const rows = await this.sql<SharedBlockRow[]>`
      SELECT id, title, created_by_agent_id, retrieval_only, created_at, updated_at
      FROM shared_blocks
      WHERE id = ${blockId}
      LIMIT 1
    `;
    if (rows.length === 0) return undefined;
    return normalizeBlock(rows[0]);
  }

  async getSections(blockId: number): Promise<SharedBlockSection[]> {
    const rows = await this.sql<SectionRow[]>`
      SELECT id, block_id, section_path, title, content, created_at, updated_at
      FROM shared_block_sections
      WHERE block_id = ${blockId}
      ORDER BY section_path
    `;
    return rows.map(normalizeSection);
  }

  async getSection(blockId: number, sectionPath: string): Promise<SharedBlockSection | undefined> {
    const rows = await this.sql<SectionRow[]>`
      SELECT id, block_id, section_path, title, content, created_at, updated_at
      FROM shared_block_sections
      WHERE block_id = ${blockId} AND section_path = ${sectionPath}
      LIMIT 1
    `;
    if (rows.length === 0) return undefined;
    return normalizeSection(rows[0]);
  }

  async upsertSection(blockId: number, sectionPath: string, content: string, title = ""): Promise<void> {
    const now = Date.now();
    await this.sql`
      INSERT INTO shared_block_sections
        (block_id, section_path, title, content, created_at, updated_at)
      VALUES
        (${blockId}, ${sectionPath}, ${title}, ${content}, ${now}, ${now})
      ON CONFLICT (block_id, section_path)
      DO UPDATE SET content = ${content}, title = ${title}, updated_at = ${now}
    `;
    await this.touchBlock(blockId, now);
  }

  async deleteSection(blockId: number, sectionPath: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM shared_block_sections
      WHERE block_id = ${blockId} AND section_path = ${sectionPath}
    `;
    if (result.count > 0) {
      await this.touchBlock(blockId);
      return true;
    }
    return false;
  }

  async renameSection(blockId: number, fromPath: string, toPath: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.sql`
      UPDATE shared_block_sections
      SET section_path = ${toPath}, updated_at = ${now}
      WHERE block_id = ${blockId} AND section_path = ${fromPath}
    `;
    if (result.count > 0) {
      await this.touchBlock(blockId, now);
      return true;
    }
    return false;
  }

  async setTitle(blockId: number, title: string): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE shared_blocks
      SET title = ${title}, updated_at = ${now}
      WHERE id = ${blockId}
    `;
  }

  async sectionExists(blockId: number, sectionPath: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT 1 FROM shared_block_sections
      WHERE block_id = ${blockId} AND section_path = ${sectionPath}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async buildSnapshotJson(blockId: number): Promise<string> {
    const sections = await this.getSections(blockId);
    const map: Record<string, string> = {};
    for (const s of sections) {
      map[s.sectionPath] = s.content;
    }
    return JSON.stringify(map);
  }

  async writeSnapshot(blockId: number, snapshotSeq: number): Promise<void> {
    const contentJson = await this.buildSnapshotJson(blockId);
    const now = Date.now();
    await this.sql`
      INSERT INTO shared_block_snapshots
        (block_id, snapshot_seq, content_json, created_at)
      VALUES
        (${blockId}, ${snapshotSeq}, ${this.sql.json(JSON.parse(contentJson) as never)}, ${now})
    `;
  }

  private async touchBlock(blockId: number, now?: number): Promise<void> {
    await this.sql`
      UPDATE shared_blocks
      SET updated_at = ${now ?? Date.now()}
      WHERE id = ${blockId}
    `;
  }
}
