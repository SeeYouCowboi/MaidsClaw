import { assertSectionPath } from "./section-path-validator.js";
import { SharedBlockRepo } from "./shared-block-repo.js";
import { SharedBlockPermissions } from "./shared-block-permissions.js";

const AUTO_SNAPSHOT_INTERVAL = 25;

type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  transaction<T>(fn: () => T): T;
};

export type PatchOp = "set_section" | "delete_section" | "move_section" | "set_title";

export type PatchParams = {
  sectionPath?: string;
  targetPath?: string;
  content?: string;
  title?: string;
};

export type PatchResult = {
  patchSeq: number;
  snapshotTaken: boolean;
};

export class MoveTargetConflictError extends Error {
  readonly retryable = true;
  constructor(blockId: number, targetPath: string) {
    super(`move_section conflict: target path "${targetPath}" already exists in block ${blockId}`);
    this.name = "MoveTargetConflictError";
  }
}

export class SharedBlockPatchService {
  private readonly repo: SharedBlockRepo;
  private readonly permissions: SharedBlockPermissions;

  constructor(private readonly db: DbLike) {
    this.repo = new SharedBlockRepo(db);
    this.permissions = new SharedBlockPermissions(db);
  }

  applyPatch(
    blockId: number,
    op: PatchOp,
    params: PatchParams,
    appliedByAgentId: string,
    sourceRef = "system",
  ): PatchResult {
    if (!this.permissions.canEdit(blockId, appliedByAgentId)) {
      throw new Error(`Agent ${appliedByAgentId} cannot edit block ${blockId}`);
    }

    return this.db.transaction(() => {
      let beforeValue: string | null = null;
      let afterValue: string | null = null;

      if (op === "set_section" && params.sectionPath) {
        const existing = this.repo.getSection(blockId, params.sectionPath);
        beforeValue = existing?.content ?? null;
      } else if (op === "delete_section" && params.sectionPath) {
        const existing = this.repo.getSection(blockId, params.sectionPath);
        beforeValue = existing?.content ?? null;
      } else if (op === "move_section" && params.sectionPath) {
        beforeValue = params.sectionPath;
      } else if (op === "set_title") {
        const block = this.repo.getBlock(blockId);
        beforeValue = block?.title ?? null;
      }

      this.applyOp(blockId, op, params);

      if (op === "set_section") {
        afterValue = params.content ?? "";
      } else if (op === "delete_section") {
        afterValue = null;
      } else if (op === "move_section") {
        afterValue = params.targetPath ?? null;
      } else if (op === "set_title") {
        afterValue = params.title ?? null;
      }

      const nextSeq = this.getNextPatchSeq(blockId);

      this.db
        .prepare(
          `INSERT INTO shared_block_patch_log (block_id, patch_seq, op, section_path, target_path, content, before_value, after_value, source_ref, applied_by_agent_id, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          blockId,
          nextSeq,
          op,
          params.sectionPath ?? null,
          params.targetPath ?? null,
          op === "set_title" ? (params.title ?? null) : (params.content ?? null),
          beforeValue,
          afterValue,
          sourceRef,
          appliedByAgentId,
          Date.now(),
        );

      let snapshotTaken = false;
      if (nextSeq % AUTO_SNAPSHOT_INTERVAL === 0) {
        this.repo.writeSnapshot(blockId, nextSeq);
        snapshotTaken = true;
      }

      return { patchSeq: nextSeq, snapshotTaken };
    });
  }

  private applyOp(blockId: number, op: PatchOp, params: PatchParams): void {
    switch (op) {
      case "set_section": {
        if (!params.sectionPath) throw new Error("set_section requires sectionPath");
        assertSectionPath(params.sectionPath);
        this.repo.upsertSection(blockId, params.sectionPath, params.content ?? "");
        break;
      }
      case "delete_section": {
        if (!params.sectionPath) throw new Error("delete_section requires sectionPath");
        this.repo.deleteSection(blockId, params.sectionPath);
        break;
      }
      case "move_section": {
        if (!params.sectionPath) throw new Error("move_section requires sectionPath");
        if (!params.targetPath) throw new Error("move_section requires targetPath");
        assertSectionPath(params.sectionPath);
        assertSectionPath(params.targetPath);
        if (this.repo.sectionExists(blockId, params.targetPath)) {
          throw new MoveTargetConflictError(blockId, params.targetPath);
        }
        this.repo.renameSection(blockId, params.sectionPath, params.targetPath);
        break;
      }
      case "set_title": {
        if (params.title === undefined) throw new Error("set_title requires title");
        this.repo.setTitle(blockId, params.title);
        break;
      }
      default:
        throw new Error(`Unknown patch op: ${op}`);
    }
  }

  private getNextPatchSeq(blockId: number): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(patch_seq), 0) + 1 AS next_seq FROM shared_block_patch_log WHERE block_id = ?`)
      .get(blockId) as { next_seq: number };
    return row.next_seq;
  }
}
