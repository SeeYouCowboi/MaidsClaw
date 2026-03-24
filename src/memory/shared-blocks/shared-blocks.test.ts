import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMemorySchema } from "../schema.js";
import { SharedBlockAttachService } from "./shared-block-attach-service.js";
import { SharedBlockAuditFacade } from "./shared-block-audit.js";
import { MoveTargetConflictError, PatchSeqConflictError, SharedBlockPatchService } from "./shared-block-patch-service.js";
import { SharedBlockPermissions } from "./shared-block-permissions.js";
import type { SharedBlockRole } from "./shared-block-permissions.js";
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

  it("upsertSection supports title field", () => {
    const repo = new SharedBlockRepo(db);
    const block = repo.createBlock("B", OWNER);

    repo.upsertSection(block.id, "profile", "content-1", "Profile Title");
    const section = repo.getSection(block.id, "profile");
    expect(section?.title).toBe("Profile Title");
    expect(section?.content).toBe("content-1");

    repo.upsertSection(block.id, "profile", "content-2", "Updated Title");
    expect(repo.getSection(block.id, "profile")?.title).toBe("Updated Title");

    repo.upsertSection(block.id, "no-title", "data");
    expect(repo.getSection(block.id, "no-title")?.title).toBe("");
  });

  it("getSections returns title for each section", () => {
    const repo = new SharedBlockRepo(db);
    const block = repo.createBlock("B", OWNER);

    repo.upsertSection(block.id, "a", "aaa", "Section A");
    repo.upsertSection(block.id, "b", "bbb");
    const sections = repo.getSections(block.id);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("Section A");
    expect(sections[1].title).toBe("");
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
  it("set_section upserts content and logs patch with audit columns", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    const result = patchService.applyPatch(block.id, "set_section", { sectionPath: "profile", content: "hello" }, OWNER, "turn:t-1");
    expect(result.patchSeq).toBe(1);
    expect(result.snapshotTaken).toBe(false);
    expect(repo.getSection(block.id, "profile")?.content).toBe("hello");

    const log = rawDb
      .prepare(`SELECT op, section_path, content, before_value, after_value, source_ref, applied_by_agent_id FROM shared_block_patch_log WHERE block_id = ?`)
      .get(block.id) as { op: string; section_path: string; content: string; before_value: string | null; after_value: string | null; source_ref: string; applied_by_agent_id: string };
    expect(log.op).toBe("set_section");
    expect(log.section_path).toBe("profile");
    expect(log.content).toBe("hello");
    expect(log.before_value).toBeNull();
    expect(log.after_value).toBe("hello");
    expect(log.source_ref).toBe("turn:t-1");
    expect(log.applied_by_agent_id).toBe(OWNER);

    patchService.applyPatch(block.id, "set_section", { sectionPath: "profile", content: "updated" }, OWNER);
    const log2 = rawDb
      .prepare(`SELECT before_value, after_value, source_ref FROM shared_block_patch_log WHERE block_id = ? AND patch_seq = 2`)
      .get(block.id) as { before_value: string | null; after_value: string | null; source_ref: string };
    expect(log2.before_value).toBe("hello");
    expect(log2.after_value).toBe("updated");
    expect(log2.source_ref).toBe("system");
  });

  it("delete_section removes section and logs with before_value", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    patchService.applyPatch(block.id, "set_section", { sectionPath: "temp", content: "data" }, OWNER);
    patchService.applyPatch(block.id, "delete_section", { sectionPath: "temp" }, OWNER);

    expect(repo.getSection(block.id, "temp")).toBeUndefined();

    const logs = rawDb
      .prepare(`SELECT op, before_value, after_value FROM shared_block_patch_log WHERE block_id = ? ORDER BY patch_seq`)
      .all(block.id) as Array<{ op: string; before_value: string | null; after_value: string | null }>;
    expect(logs.map((l) => l.op)).toEqual(["set_section", "delete_section"]);
    expect(logs[1].before_value).toBe("data");
    expect(logs[1].after_value).toBeNull();
  });

  it("move_section renames path and logs before/after", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("B", OWNER);

    patchService.applyPatch(block.id, "set_section", { sectionPath: "old", content: "data" }, OWNER);
    patchService.applyPatch(block.id, "move_section", { sectionPath: "old", targetPath: "new-path" }, OWNER);

    expect(repo.getSection(block.id, "old")).toBeUndefined();
    expect(repo.getSection(block.id, "new-path")?.content).toBe("data");

    const log = rawDb
      .prepare(`SELECT before_value, after_value FROM shared_block_patch_log WHERE block_id = ? AND op = 'move_section'`)
      .get(block.id) as { before_value: string | null; after_value: string | null };
    expect(log.before_value).toBe("old");
    expect(log.after_value).toBe("new-path");
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

  it("set_title updates block title and logs before/after", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const block = repo.createBlock("Old Title", OWNER);

    patchService.applyPatch(block.id, "set_title", { title: "New Title" }, OWNER);
    expect(repo.getBlock(block.id)?.title).toBe("New Title");

    const log = rawDb
      .prepare(`SELECT before_value, after_value FROM shared_block_patch_log WHERE block_id = ? AND op = 'set_title'`)
      .get(block.id) as { before_value: string | null; after_value: string | null };
    expect(log.before_value).toBe("Old Title");
    expect(log.after_value).toBe("New Title");
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

// ── SharedBlockAuditFacade ──

describe("SharedBlockAuditFacade", () => {
  it("listBlockPatches returns patches in order with correct fields", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const audit = new SharedBlockAuditFacade(db);
    const block = repo.createBlock("Audit Test", OWNER);

    patchService.applyPatch(block.id, "set_section", { sectionPath: "a", content: "v1" }, OWNER, "turn:t-1");
    patchService.applyPatch(block.id, "set_section", { sectionPath: "b", content: "v2" }, OWNER, "turn:t-2");
    patchService.applyPatch(block.id, "set_title", { title: "New Title" }, OWNER, "turn:t-3");

    const patches = audit.listBlockPatches(block.id);
    expect(patches).toHaveLength(3);
    expect(patches[0].patchSeq).toBe(1);
    expect(patches[0].op).toBe("set_section");
    expect(patches[0].sectionPath).toBe("a");
    expect(patches[0].content).toBe("v1");
    expect(patches[0].sourceRef).toBe("turn:t-1");
    expect(patches[0].appliedByAgentId).toBe(OWNER);
    expect(patches[0].appliedAt).toBeGreaterThan(0);
    expect(patches[1].patchSeq).toBe(2);
    expect(patches[2].patchSeq).toBe(3);
    expect(patches[2].op).toBe("set_title");
  });

  it("listBlockPatches supports limit and sinceSeq options", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const audit = new SharedBlockAuditFacade(db);
    const block = repo.createBlock("B", OWNER);

    for (let i = 1; i <= 5; i++) {
      patchService.applyPatch(block.id, "set_section", { sectionPath: `s-${i}`, content: `v${i}` }, OWNER);
    }

    const limited = audit.listBlockPatches(block.id, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].patchSeq).toBe(1);
    expect(limited[1].patchSeq).toBe(2);

    const sinceSeq = audit.listBlockPatches(block.id, { sinceSeq: 3 });
    expect(sinceSeq).toHaveLength(2);
    expect(sinceSeq[0].patchSeq).toBe(4);
    expect(sinceSeq[1].patchSeq).toBe(5);

    const combined = audit.listBlockPatches(block.id, { sinceSeq: 2, limit: 1 });
    expect(combined).toHaveLength(1);
    expect(combined[0].patchSeq).toBe(3);
  });

  it("listBlockPatches returns empty array for non-existent block", () => {
    const audit = new SharedBlockAuditFacade(db);
    expect(audit.listBlockPatches(9999)).toEqual([]);
  });

  it("listBlockSnapshots returns snapshot metadata without content", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const audit = new SharedBlockAuditFacade(db);
    const block = repo.createBlock("B", OWNER);

    for (let i = 1; i <= 25; i++) {
      patchService.applyPatch(block.id, "set_section", { sectionPath: `s-${i}`, content: `v${i}` }, OWNER);
    }

    const snapshots = audit.listBlockSnapshots(block.id);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].snapshotSeq).toBe(0);
    expect(snapshots[0].createdAt).toBeGreaterThan(0);
    expect(snapshots[1].snapshotSeq).toBe(25);
    expect((snapshots[0] as Record<string, unknown>)["contentJson"]).toBeUndefined();
  });

  it("listBlockSnapshots supports limit option", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const audit = new SharedBlockAuditFacade(db);
    const block = repo.createBlock("B", OWNER);

    for (let i = 1; i <= 25; i++) {
      patchService.applyPatch(block.id, "set_section", { sectionPath: `s-${i}`, content: `v${i}` }, OWNER);
    }

    const limited = audit.listBlockSnapshots(block.id, { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].snapshotSeq).toBe(0);
  });

  it("getBlockSnapshot returns full snapshot with contentJson", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const audit = new SharedBlockAuditFacade(db);
    const block = repo.createBlock("B", OWNER);

    for (let i = 1; i <= 25; i++) {
      patchService.applyPatch(block.id, "set_section", { sectionPath: `s-${i}`, content: `v${i}` }, OWNER);
    }

    const snapshot = audit.getBlockSnapshot(block.id, 25);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.snapshotSeq).toBe(25);
    expect(snapshot!.createdAt).toBeGreaterThan(0);
    const parsed = JSON.parse(snapshot!.contentJson);
    expect(Object.keys(parsed)).toHaveLength(25);
    expect(parsed["s-1"]).toBe("v1");

    const baseline = audit.getBlockSnapshot(block.id, 0);
    expect(baseline).not.toBeNull();
    expect(baseline!.contentJson).toBe("{}");
  });

  it("getBlockSnapshot returns null for missing snapshot", () => {
    const repo = new SharedBlockRepo(db);
    const audit = new SharedBlockAuditFacade(db);
    const block = repo.createBlock("B", OWNER);

    expect(audit.getBlockSnapshot(block.id, 999)).toBeNull();
    expect(audit.getBlockSnapshot(9999, 0)).toBeNull();
  });

  it("getBlockAuditView returns comprehensive audit view", () => {
    const repo = new SharedBlockRepo(db);
    const patchService = new SharedBlockPatchService(db);
    const audit = new SharedBlockAuditFacade(db);
    const block = repo.createBlock("Audit Block", OWNER);

    for (let i = 1; i <= 7; i++) {
      patchService.applyPatch(block.id, "set_section", { sectionPath: `s-${i}`, content: `v${i}` }, OWNER, `ref:${i}`);
    }

    const view = audit.getBlockAuditView(block.id);
    expect(view.blockId).toBe(block.id);
    expect(view.title).toBe("Audit Block");
    expect(view.createdByAgentId).toBe(OWNER);
    expect(view.createdAt).toBeGreaterThan(0);
    expect(view.updatedAt).toBeGreaterThanOrEqual(view.createdAt);
    expect(view.totalPatches).toBe(7);
    expect(view.latestPatchSeq).toBe(7);
    expect(view.totalSnapshots).toBe(1);
    expect(view.latestSnapshotSeq).toBe(0);
    expect(view.recentPatches).toHaveLength(5);
    expect(view.recentPatches[0].patchSeq).toBe(3);
    expect(view.recentPatches[4].patchSeq).toBe(7);
  });

  it("getBlockAuditView handles block with no patches", () => {
    const repo = new SharedBlockRepo(db);
    const audit = new SharedBlockAuditFacade(db);
    const block = repo.createBlock("Empty Block", OWNER);

    const view = audit.getBlockAuditView(block.id);
    expect(view.blockId).toBe(block.id);
    expect(view.title).toBe("Empty Block");
    expect(view.totalPatches).toBe(0);
    expect(view.latestPatchSeq).toBeNull();
    expect(view.totalSnapshots).toBe(1);
    expect(view.latestSnapshotSeq).toBe(0);
    expect(view.recentPatches).toHaveLength(0);
  });

  it("getBlockAuditView throws for non-existent block", () => {
    const audit = new SharedBlockAuditFacade(db);
    expect(() => audit.getBlockAuditView(9999)).toThrow();
  });
});

// ── Permission Matrix ──

const MEMBER = "agent-member";
const NON_MEMBER = "agent-nobody";

describe("SharedBlockPermissions — permission matrix", () => {
  it("owner can read, edit, and grant admin", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const block = repo.createBlock("B", OWNER);

    expect(perms.canRead(block.id, OWNER)).toBe(true);
    expect(perms.canEdit(block.id, OWNER)).toBe(true);
    expect(perms.canGrantAdmin(block.id, OWNER)).toBe(true);
  });

  it("admin can read and edit, but cannot grant admin", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const block = repo.createBlock("B", OWNER);
    grantAdmin(block.id, ADMIN, OWNER);

    expect(perms.canRead(block.id, ADMIN)).toBe(true);
    expect(perms.canEdit(block.id, ADMIN)).toBe(true);
    expect(perms.canGrantAdmin(block.id, ADMIN)).toBe(false);
  });

  it("member can read but cannot edit or grant admin", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const attachService = new SharedBlockAttachService(db);
    const block = repo.createBlock("B", OWNER);
    attachService.attachBlock(block.id, MEMBER, OWNER);

    expect(perms.canRead(block.id, MEMBER)).toBe(true);
    expect(perms.canEdit(block.id, MEMBER)).toBe(false);
    expect(perms.canGrantAdmin(block.id, MEMBER)).toBe(false);
  });

  it("non-member cannot read, edit, or grant admin", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const block = repo.createBlock("B", OWNER);

    expect(perms.canRead(block.id, NON_MEMBER)).toBe(false);
    expect(perms.canEdit(block.id, NON_MEMBER)).toBe(false);
    expect(perms.canGrantAdmin(block.id, NON_MEMBER)).toBe(false);
  });

  it("isMember returns true for attached agent, false for admin-only", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const attachService = new SharedBlockAttachService(db);
    const block = repo.createBlock("B", OWNER);

    attachService.attachBlock(block.id, MEMBER, OWNER);
    grantAdmin(block.id, ADMIN, OWNER);

    expect(perms.isMember(block.id, MEMBER)).toBe(true);
    expect(perms.isMember(block.id, ADMIN)).toBe(false);
    expect(perms.isMember(block.id, NON_MEMBER)).toBe(false);
  });

  it("getRole returns correct role for each agent type", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const attachService = new SharedBlockAttachService(db);
    const block = repo.createBlock("B", OWNER);

    grantAdmin(block.id, ADMIN, OWNER);
    attachService.attachBlock(block.id, MEMBER, OWNER);

    expect(perms.getRole(block.id, OWNER)).toBe("owner" satisfies SharedBlockRole);
    expect(perms.getRole(block.id, ADMIN)).toBe("admin" satisfies SharedBlockRole);
    expect(perms.getRole(block.id, MEMBER)).toBe("member" satisfies SharedBlockRole);
    expect(perms.getRole(block.id, NON_MEMBER)).toBe("none" satisfies SharedBlockRole);
  });
});

// ── retrieval_only ──

describe("SharedBlockPermissions — retrieval_only", () => {
  it("isRetrievalOnly returns false for normal blocks", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const block = repo.createBlock("Normal", OWNER);

    expect(perms.isRetrievalOnly(block.id)).toBe(false);
  });

  it("isRetrievalOnly returns true for retrieval_only blocks", () => {
    const repo = new SharedBlockRepo(db);
    const perms = new SharedBlockPermissions(db);
    const block = repo.createBlock("Retrieval", OWNER, { retrievalOnly: true });

    expect(perms.isRetrievalOnly(block.id)).toBe(true);
    expect(block.retrievalOnly).toBe(true);
  });

  it("isRetrievalOnly returns false for non-existent block", () => {
    const perms = new SharedBlockPermissions(db);
    expect(perms.isRetrievalOnly(9999)).toBe(false);
  });

  it("createBlock defaults retrieval_only to false", () => {
    const repo = new SharedBlockRepo(db);
    const block = repo.createBlock("Default", OWNER);
    expect(block.retrievalOnly).toBe(false);

    const fetched = repo.getBlock(block.id);
    expect(fetched!.retrievalOnly).toBe(false);
  });

  it("getBlock reads retrieval_only correctly", () => {
    const repo = new SharedBlockRepo(db);
    const block = repo.createBlock("RO", OWNER, { retrievalOnly: true });
    const fetched = repo.getBlock(block.id);
    expect(fetched!.retrievalOnly).toBe(true);
  });
});

// ── Concurrent Patch Conflict ──

describe("SharedBlockPatchService — concurrent patch conflict", () => {
  it("throws PatchSeqConflictError when patch_seq collides", () => {
    const repo = new SharedBlockRepo(db);
    const block = repo.createBlock("B", OWNER);

    rawDb
      .prepare(
        `INSERT INTO shared_block_patch_log (block_id, patch_seq, op, section_path, content, before_value, after_value, source_ref, applied_by_agent_id, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(block.id, 1, "set_section", "pre-inserted", "conflict", null, "conflict", "system", OWNER, Date.now());

    const staleDb = {
      prepare(sql: string) {
        const stmt = rawDb.prepare(sql);
        const isSeqQuery = sql.includes("COALESCE(MAX(patch_seq)");
        return {
          run(...params: unknown[]) {
            return stmt.run(...(params as Parameters<typeof stmt.run>));
          },
          all(...params: unknown[]) {
            return stmt.all(...(params as Parameters<typeof stmt.all>));
          },
          get(...params: unknown[]) {
            if (isSeqQuery) return { next_seq: 1 };
            return stmt.get(...(params as Parameters<typeof stmt.get>));
          },
        };
      },
      transaction<T>(fn: () => T): T {
        return rawDb.transaction(fn)();
      },
    };

    const patchService = new SharedBlockPatchService(staleDb);

    let caught: unknown;
    try {
      patchService.applyPatch(block.id, "set_section", { sectionPath: "b", content: "v2" }, OWNER);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect((caught as PatchSeqConflictError).name).toBe("PatchSeqConflictError");
    expect((caught as PatchSeqConflictError).retryable).toBe(true);
    expect((caught as PatchSeqConflictError).message).toContain("patch_seq collision");
  });
});
