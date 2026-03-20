import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMemorySchema } from "../schema.js";
import { SharedBlockAttachService } from "./shared-block-attach-service.js";
import { MoveTargetConflictError, SharedBlockPatchService } from "./shared-block-patch-service.js";
import { SharedBlockPermissions } from "./shared-block-permissions.js";
import { SharedBlockRepo } from "./shared-block-repo.js";

let rawDb: Database;
let db: ReturnType<typeof wrapDb>;

function wrapDb(raw: Database) {
  return {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        run(...params: unknown[]) {
          return stmt.run(...(params as Parameters<typeof stmt.run>));
        },
        all(...params: unknown[]) {
          return stmt.all(...(params as Parameters<typeof stmt.all>));
        },
        get(...params: unknown[]) {
          return stmt.get(...(params as Parameters<typeof stmt.get>));
        },
      };
    },
    transaction<T>(fn: () => T): T {
      return raw.transaction(fn)();
    },
  };
}

beforeEach(() => {
  rawDb = new Database(":memory:");
  rawDb.exec("PRAGMA foreign_keys=ON");
  createMemorySchema(rawDb);
  db = wrapDb(rawDb);
});

afterEach(() => {
  rawDb.close();
});

const OWNER = "agent-owner";
const OTHER = "agent-other";
const ADMIN = "agent-admin";

function grantAdmin(blockId: number, agentId: string, grantedBy: string) {
  rawDb
    .prepare(
      `INSERT INTO shared_block_admins (block_id, agent_id, granted_by_agent_id, granted_at) VALUES (?, ?, ?, ?)`,
    )
    .run(blockId, agentId, grantedBy, Date.now());
}

// ── SharedBlockRepo ──

describe("SharedBlockRepo", () => {
  it("createBlock returns metadata and creates baseline snapshot", () => {
    const repo = new SharedBlockRepo(db);
    const block = repo.createBlock("Test Block", OWNER);

    expect(block.id).toBeGreaterThan(0);
    expect(block.title).toBe("Test Block");
    expect(block.createdByAgentId).toBe(OWNER);

    const snapshot = rawDb
      .prepare(`SELECT snapshot_seq, content_json FROM shared_block_snapshots WHERE block_id = ?`)
      .get(block.id) as { snapshot_seq: number; content_json: string };
    expect(snapshot.snapshot_seq).toBe(0);
    expect(snapshot.content_json).toBe("{}");
  });

  it("getBlock returns undefined for missing block", () => {
    const repo = new SharedBlockRepo(db);
    expect(repo.getBlock(999)).toBeUndefined();
  });

  it("getBlock returns existing block", () => {
    const repo = new SharedBlockRepo(db);
    const created = repo.createBlock("X", OWNER);
    const fetched = repo.getBlock(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe("X");
    expect(fetched!.createdByAgentId).toBe(OWNER);
  });

  it("getSections returns empty for new block", () => {
    const repo = new SharedBlockRepo(db);
    const block = repo.createBlock("B", OWNER);
    expect(repo.getSections(block.id)).toHaveLength(0);
  });

  it("upsertSection creates and updates sections", () => {
    const repo = new SharedBlockRepo(db);
    const block = repo.createBlock("B", OWNER);

    repo.upsertSection(block.id, "profile", "v1");
    expect(repo.getSection(block.id, "profile")?.content).toBe("v1");

    repo.upsertSection(block.id, "profile", "v2");
    expect(repo.getSection(block.id, "profile")?.content).toBe("v2");
    expect(repo.getSections(block.id)).toHaveLength(1);
  });

  it("deleteSection removes section", () => {
    const repo = new SharedBlockRepo(db);
    const block = repo.createBlock("B", OWNER);
    repo.upsertSection(block.id, "temp", "data");
    expect(repo.deleteSection(block.id, "temp")).toBe(true);
    expect(repo.getSection(block.id, "temp")).toBeUndefined();
    expect(repo.deleteSection(block.id, "temp")).toBe(false);
  });

  it("renameSection moves path", () => {
    const repo = new SharedBlockRepo(db);
    const block = repo.createBlock("B", OWNER);
    repo.upsertSection(block.id, "old-path", "content");
    expect(repo.renameSection(block.id, "old-path", "new-path")).toBe(true);
    expect(repo.getSection(block.id, "old-path")).toBeUndefined();
    expect(repo.getSection(block.id, "new-path")?.content).toBe("content");
  });

  it("buildSnapshotJson captures all sections", () => {
    const repo = new SharedBlockRepo(db);
    const block = repo.createBlock("B", OWNER);
    repo.upsertSection(block.id, "a", "aaa");
    repo.upsertSection(block.id, "b/c", "bcc");
    const json = JSON.parse(repo.buildSnapshotJson(block.id));
    expect(json).toEqual({ a: "aaa", "b/c": "bcc" });
  });
});

// ── SharedBlockPermissions ──

describe("SharedBlockPermissions", () => {
  it("isOwner returns true for creator", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const block = repo.createBlock("B", OWNER);
    expect(perms.isOwner(block.id, OWNER)).toBe(true);
    expect(perms.isOwner(block.id, OTHER)).toBe(false);
  });

  it("isAdmin returns true for owner and granted admin", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const block = repo.createBlock("B", OWNER);

    expect(perms.isAdmin(block.id, OWNER)).toBe(true);
    expect(perms.isAdmin(block.id, ADMIN)).toBe(false);

    grantAdmin(block.id, ADMIN, OWNER);
    expect(perms.isAdmin(block.id, ADMIN)).toBe(true);
  });

  it("canEdit delegates to isAdmin", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const block = repo.createBlock("B", OWNER);
    expect(perms.canEdit(block.id, OWNER)).toBe(true);
    expect(perms.canEdit(block.id, OTHER)).toBe(false);
  });

  it("canRead returns true for attached agent or admin", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const attachService = new SharedBlockAttachService(db);
    const block = repo.createBlock("B", OWNER);

    expect(perms.canRead(block.id, OTHER)).toBe(false);

    attachService.attachBlock(block.id, OTHER, OWNER);
    expect(perms.canRead(block.id, OTHER)).toBe(true);
    expect(perms.canRead(block.id, OWNER)).toBe(true);
  });
});

// ── SharedBlockAttachService ──

describe("SharedBlockAttachService", () => {
  it("attachBlock creates attachment (agent-only)", () => {
    const repo = new SharedBlockRepo(db);
    const attachService = new SharedBlockAttachService(db);
    const block = repo.createBlock("B", OWNER);

    const attachment = attachService.attachBlock(block.id, OTHER, OWNER);
    expect(attachment.blockId).toBe(block.id);
    expect(attachment.targetKind).toBe("agent");
    expect(attachment.targetId).toBe(OTHER);
  });

  it("attachBlock is idempotent", () => {
    const repo = new SharedBlockRepo(db);
    const attachService = new SharedBlockAttachService(db);
    const block = repo.createBlock("B", OWNER);

    const a1 = attachService.attachBlock(block.id, OTHER, OWNER);
    const a2 = attachService.attachBlock(block.id, OTHER, OWNER);
    expect(a1.blockId).toBe(a2.blockId);
    expect(a1.targetId).toBe(a2.targetId);
  });

  it("attachBlock rejects non-admin", () => {
    const repo = new SharedBlockRepo(db);
    const attachService = new SharedBlockAttachService(db);
    const block = repo.createBlock("B", OWNER);

    expect(() => attachService.attachBlock(block.id, OTHER, OTHER)).toThrow(/not admin/);
  });

  it("attachBlock throws for missing block", () => {
    const attachService = new SharedBlockAttachService(db);
    expect(() => attachService.attachBlock(999, OTHER, OWNER)).toThrow(/not found/);
  });

  it("detachBlock removes attachment", () => {
    const repo = new SharedBlockRepo(db);
    const attachService = new SharedBlockAttachService(db);
    const block = repo.createBlock("B", OWNER);

    attachService.attachBlock(block.id, OTHER, OWNER);
    expect(attachService.detachBlock(block.id, OTHER, OWNER)).toBe(true);

    const perms = new SharedBlockPermissions(db);
    expect(perms.canRead(block.id, OTHER)).toBe(false);
  });

  it("detachBlock rejects non-admin", () => {
    const repo = new SharedBlockRepo(db);
    const attachService = new SharedBlockAttachService(db);
    const block = repo.createBlock("B", OWNER);
    attachService.attachBlock(block.id, OTHER, OWNER);

    expect(() => attachService.detachBlock(block.id, OTHER, OTHER)).toThrow(/not admin/);
  });

  it("getAttachments lists by target", () => {
    const repo = new SharedBlockRepo(db);
    const attachService = new SharedBlockAttachService(db);
    const b1 = repo.createBlock("B1", OWNER);
    const b2 = repo.createBlock("B2", OWNER);

    attachService.attachBlock(b1.id, OTHER, OWNER);
    attachService.attachBlock(b2.id, OTHER, OWNER);

    const attachments = attachService.getAttachments("agent", OTHER);
    expect(attachments).toHaveLength(2);
  });
});

// ── SharedBlockPatchService ──

describe("SharedBlockPatchService", () => {
  it("set_section upserts content and logs patch", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    const result = patchService.applyPatch(block.id, "set_section", { sectionPath: "profile", content: "hello" }, OWNER);
    expect(result.patchSeq).toBe(1);
    expect(result.snapshotTaken).toBe(false);
    expect(repo.getSection(block.id, "profile")?.content).toBe("hello");

    const log = rawDb
      .prepare(`SELECT op, section_path, content, applied_by_agent_id FROM shared_block_patch_log WHERE block_id = ?`)
      .get(block.id) as { op: string; section_path: string; content: string; applied_by_agent_id: string };
    expect(log.op).toBe("set_section");
    expect(log.section_path).toBe("profile");
    expect(log.content).toBe("hello");
    expect(log.applied_by_agent_id).toBe(OWNER);
  });

  it("delete_section removes section and logs", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    patchService.applyPatch(block.id, "set_section", { sectionPath: "temp", content: "data" }, OWNER);
    patchService.applyPatch(block.id, "delete_section", { sectionPath: "temp" }, OWNER);

    expect(repo.getSection(block.id, "temp")).toBeUndefined();

    const logs = rawDb
      .prepare(`SELECT op FROM shared_block_patch_log WHERE block_id = ? ORDER BY patch_seq`)
      .all(block.id) as Array<{ op: string }>;
    expect(logs.map((l) => l.op)).toEqual(["set_section", "delete_section"]);
  });

  it("move_section renames path", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    patchService.applyPatch(block.id, "set_section", { sectionPath: "old", content: "data" }, OWNER);
    patchService.applyPatch(block.id, "move_section", { sectionPath: "old", targetPath: "new-path" }, OWNER);

    expect(repo.getSection(block.id, "old")).toBeUndefined();
    expect(repo.getSection(block.id, "new-path")?.content).toBe("data");
  });

  it("move_section throws MoveTargetConflictError on collision", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    patchService.applyPatch(block.id, "set_section", { sectionPath: "a", content: "x" }, OWNER);
    patchService.applyPatch(block.id, "set_section", { sectionPath: "b", content: "y" }, OWNER);

    let caught: unknown;
    try {
      patchService.applyPatch(block.id, "move_section", { sectionPath: "a", targetPath: "b" }, OWNER);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as MoveTargetConflictError).retryable).toBe(true);
    expect((caught as MoveTargetConflictError).name).toBe("MoveTargetConflictError");
  });

  it("set_title updates block title", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("Old Title", OWNER);

    patchService.applyPatch(block.id, "set_title", { title: "New Title" }, OWNER);
    expect(repo.getBlock(block.id)?.title).toBe("New Title");
  });

  it("set_section rejects invalid path", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    expect(() =>
      patchService.applyPatch(block.id, "set_section", { sectionPath: "INVALID/Path", content: "x" }, OWNER),
    ).toThrow(/Invalid section path/);
  });

  it("move_section rejects invalid target path", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);
    patchService.applyPatch(block.id, "set_section", { sectionPath: "valid", content: "x" }, OWNER);

    expect(() =>
      patchService.applyPatch(block.id, "move_section", { sectionPath: "valid", targetPath: "BAD PATH" }, OWNER),
    ).toThrow(/Invalid section path/);
  });

  it("rejects patch from non-admin agent", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    expect(() =>
      patchService.applyPatch(block.id, "set_section", { sectionPath: "x", content: "y" }, OTHER),
    ).toThrow(/cannot edit/);
  });

  it("patch_seq increments monotonically", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    const r1 = patchService.applyPatch(block.id, "set_section", { sectionPath: "a", content: "1" }, OWNER);
    const r2 = patchService.applyPatch(block.id, "set_section", { sectionPath: "b", content: "2" }, OWNER);
    const r3 = patchService.applyPatch(block.id, "set_section", { sectionPath: "c", content: "3" }, OWNER);

    expect(r1.patchSeq).toBe(1);
    expect(r2.patchSeq).toBe(2);
    expect(r3.patchSeq).toBe(3);
  });

  it("auto-snapshot triggers at every 25 patches", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    for (let i = 1; i <= 25; i++) {
      const result = patchService.applyPatch(
        block.id,
        "set_section",
        { sectionPath: `s-${i}`, content: `val-${i}` },
        OWNER,
      );
      if (i < 25) {
        expect(result.snapshotTaken).toBe(false);
      } else {
        expect(result.snapshotTaken).toBe(true);
        expect(result.patchSeq).toBe(25);
      }
    }

    const snapshots = rawDb
      .prepare(`SELECT snapshot_seq FROM shared_block_snapshots WHERE block_id = ? ORDER BY snapshot_seq`)
      .all(block.id) as Array<{ snapshot_seq: number }>;
    expect(snapshots.map((s) => s.snapshot_seq)).toEqual([0, 25]);

    const snapshotContent = rawDb
      .prepare(`SELECT content_json FROM shared_block_snapshots WHERE block_id = ? AND snapshot_seq = 25`)
      .get(block.id) as { content_json: string };
    const parsed = JSON.parse(snapshotContent.content_json);
    expect(Object.keys(parsed)).toHaveLength(25);
    expect(parsed["s-1"]).toBe("val-1");
    expect(parsed["s-25"]).toBe("val-25");
  });

  it("patch log records all operations", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    patchService.applyPatch(block.id, "set_section", { sectionPath: "a", content: "x" }, OWNER);
    patchService.applyPatch(block.id, "set_title", { title: "T2" }, OWNER);
    patchService.applyPatch(block.id, "move_section", { sectionPath: "a", targetPath: "b" }, OWNER);
    patchService.applyPatch(block.id, "delete_section", { sectionPath: "b" }, OWNER);

    const logs = rawDb
      .prepare(`SELECT patch_seq, op, section_path, target_path FROM shared_block_patch_log WHERE block_id = ? ORDER BY patch_seq`)
      .all(block.id) as Array<{ patch_seq: number; op: string; section_path: string | null; target_path: string | null }>;

    expect(logs).toHaveLength(4);
    expect(logs[0].patch_seq).toBe(1);
    expect(logs[0].op).toBe("set_section");
    expect(logs[0].section_path).toBe("a");
    expect(logs[1].patch_seq).toBe(2);
    expect(logs[1].op).toBe("set_title");
    expect(logs[2].patch_seq).toBe(3);
    expect(logs[2].op).toBe("move_section");
    expect(logs[2].section_path).toBe("a");
    expect(logs[2].target_path).toBe("b");
    expect(logs[3].patch_seq).toBe(4);
    expect(logs[3].op).toBe("delete_section");
    expect(logs[3].section_path).toBe("b");
  });
});
