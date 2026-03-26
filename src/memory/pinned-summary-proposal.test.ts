import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySchema, runMemoryMigrations } from "./schema.js";
import { openDatabase } from "../storage/database.js";
import { PinnedSummaryProposalService } from "./pinned-summary-proposal.js";

function freshDb() {
  const db = openDatabase({ path: ":memory:" });
  createMemorySchema(db.raw);
  runMemoryMigrations(db);
  return db;
}

function freshFileDb() {
  const dbPath = join(tmpdir(), `maidsclaw-psp-test-${randomUUID()}.db`);
  const db = openDatabase({ path: dbPath });
  createMemorySchema(db.raw);
  runMemoryMigrations(db);
  return { db, dbPath };
}

function cleanupFileDb(dbPath: string) {
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  } catch {}
}

describe("PinnedSummaryProposalService (DB-backed)", () => {
  describe("basic CRUD", () => {
    it("storeProposal creates a pending proposal", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      svc.storeProposal("stl:1", "agent-1", { proposedText: "Summary text", rationale: "Good reason" });

      const pending = svc.getPendingProposals("agent-1");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.proposal.proposedText).toBe("Summary text");
      expect(pending[0]!.proposal.rationale).toBe("Good reason");
      expect(pending[0]!.applied).toBe(false);
      expect(pending[0]!.status).toBe("pending");
      expect(pending[0]!.agentId).toBe("agent-1");
      expect(pending[0]!.settlementId).toBe("stl:1");
      expect(pending[0]!.id).toBeGreaterThan(0);
      expect(pending[0]!.storedAt).toBeGreaterThan(0);
      db.close();
    });

    it("storeProposal without rationale stores null rationale", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      svc.storeProposal("stl:1", "agent-1", { proposedText: "No rationale" });

      const pending = svc.getPendingProposals("agent-1");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.proposal.rationale).toBeUndefined();
      db.close();
    });

    it("getPendingProposals returns only pending for the given agent", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      svc.storeProposal("stl:1", "agent-1", { proposedText: "A" });
      svc.storeProposal("stl:2", "agent-2", { proposedText: "B" });

      expect(svc.getPendingProposals("agent-1")).toHaveLength(1);
      expect(svc.getPendingProposals("agent-2")).toHaveLength(1);
      expect(svc.getPendingProposals("agent-3")).toHaveLength(0);
      db.close();
    });

    it("getPendingProposals orders by created_at ASC", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      svc.storeProposal("stl:1", "agent-1", { proposedText: "First" });
      svc.storeProposal("stl:2", "agent-1", { proposedText: "Second" });
      svc.storeProposal("stl:3", "agent-1", { proposedText: "Third" });

      const pending = svc.getPendingProposals("agent-1");
      expect(pending).toHaveLength(3);
      expect(pending[0]!.proposal.proposedText).toBe("First");
      expect(pending[2]!.proposal.proposedText).toBe("Third");
      db.close();
    });

    it("getLatestPending returns the most recent pending", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      svc.storeProposal("stl:1", "agent-1", { proposedText: "First" });
      svc.storeProposal("stl:2", "agent-1", { proposedText: "Second" });

      const latest = svc.getLatestPending("agent-1");
      expect(latest).toBeDefined();
      expect(latest!.proposal.proposedText).toBe("Second");
      db.close();
    });

    it("getLatestPending returns undefined when no pending", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      expect(svc.getLatestPending("agent-1")).toBeUndefined();
      db.close();
    });
  });

  describe("state machine: pending → applied", () => {
    it("markApplied transitions proposal to applied", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      svc.storeProposal("stl:1", "agent-1", { proposedText: "Apply me" });

      expect(svc.markApplied("agent-1", "stl:1")).toBe(true);
      expect(svc.getPendingProposals("agent-1")).toHaveLength(0);
      db.close();
    });

    it("markApplied returns false for non-existent proposal", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      expect(svc.markApplied("agent-1", "stl:999")).toBe(false);
      db.close();
    });

    it("markApplied does not affect already-applied proposals", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      svc.storeProposal("stl:1", "agent-1", { proposedText: "Once" });
      svc.markApplied("agent-1", "stl:1");

      // Second call should return false — already applied
      expect(svc.markApplied("agent-1", "stl:1")).toBe(false);
      db.close();
    });
  });

  describe("state machine: pending → rejected", () => {
    it("markRejected transitions proposal to rejected", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      svc.storeProposal("stl:1", "agent-1", { proposedText: "Reject me" });

      expect(svc.markRejected("agent-1", "stl:1")).toBe(true);
      expect(svc.getPendingProposals("agent-1")).toHaveLength(0);
      db.close();
    });

    it("markRejected returns false for non-existent proposal", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      expect(svc.markRejected("agent-1", "stl:999")).toBe(false);
      db.close();
    });

    it("markRejected does not affect already-rejected proposals", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      svc.storeProposal("stl:1", "agent-1", { proposedText: "Once" });
      svc.markRejected("agent-1", "stl:1");

      expect(svc.markRejected("agent-1", "stl:1")).toBe(false);
      db.close();
    });

    it("markRejected does not affect applied proposals", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      svc.storeProposal("stl:1", "agent-1", { proposedText: "Applied" });
      svc.markApplied("agent-1", "stl:1");

      expect(svc.markRejected("agent-1", "stl:1")).toBe(false);
      db.close();
    });
  });

  describe("clearAll", () => {
    it("removes all proposals for the given agent", () => {
      const db = freshDb();
      const svc = new PinnedSummaryProposalService(db);
      svc.storeProposal("stl:1", "agent-1", { proposedText: "A" });
      svc.storeProposal("stl:2", "agent-1", { proposedText: "B" });
      svc.storeProposal("stl:1", "agent-2", { proposedText: "C" });

      svc.clearAll("agent-1");
      expect(svc.getPendingProposals("agent-1")).toHaveLength(0);
      expect(svc.getPendingProposals("agent-2")).toHaveLength(1);
      db.close();
    });
  });

  describe("persistence across restart", () => {
    it("pending proposals survive process restart (new service instance, same DB)", () => {
      const { db, dbPath } = freshFileDb();

      // Session 1: store proposals
      const svc1 = new PinnedSummaryProposalService(db);
      svc1.storeProposal("stl:1", "agent-1", { proposedText: "Persistent proposal", rationale: "Survives restart" });
      svc1.storeProposal("stl:2", "agent-1", { proposedText: "Second proposal" });
      expect(svc1.getPendingProposals("agent-1")).toHaveLength(2);
      db.close();

      // Session 2: reopen same DB file — simulates process restart
      const db2 = openDatabase({ path: dbPath });
      createMemorySchema(db2.raw);
      runMemoryMigrations(db2);
      const svc2 = new PinnedSummaryProposalService(db2);

      const pending = svc2.getPendingProposals("agent-1");
      expect(pending).toHaveLength(2);
      expect(pending[0]!.proposal.proposedText).toBe("Persistent proposal");
      expect(pending[0]!.proposal.rationale).toBe("Survives restart");
      expect(pending[1]!.proposal.proposedText).toBe("Second proposal");
      db2.close();

      cleanupFileDb(dbPath);
    });

    it("applied proposals do not appear as pending after restart", () => {
      const { db, dbPath } = freshFileDb();

      const svc1 = new PinnedSummaryProposalService(db);
      svc1.storeProposal("stl:1", "agent-1", { proposedText: "Will be applied" });
      svc1.markApplied("agent-1", "stl:1");
      db.close();

      const db2 = openDatabase({ path: dbPath });
      createMemorySchema(db2.raw);
      runMemoryMigrations(db2);
      const svc2 = new PinnedSummaryProposalService(db2);

      expect(svc2.getPendingProposals("agent-1")).toHaveLength(0);
      db2.close();

      cleanupFileDb(dbPath);
    });

    it("rejected proposals do not appear as pending after restart", () => {
      const { db, dbPath } = freshFileDb();

      const svc1 = new PinnedSummaryProposalService(db);
      svc1.storeProposal("stl:1", "agent-1", { proposedText: "Will be rejected" });
      svc1.markRejected("agent-1", "stl:1");
      db.close();

      const db2 = openDatabase({ path: dbPath });
      createMemorySchema(db2.raw);
      runMemoryMigrations(db2);
      const svc2 = new PinnedSummaryProposalService(db2);

      expect(svc2.getPendingProposals("agent-1")).toHaveLength(0);
      db2.close();

      cleanupFileDb(dbPath);
    });
  });
});
