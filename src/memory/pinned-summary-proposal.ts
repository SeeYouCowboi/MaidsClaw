import type { Db } from "../storage/database.js";
import type { PinnedSummaryProposal } from "../runtime/rp-turn-contract.js";

export type StoredProposal = {
  id: number;
  settlementId: string;
  agentId: string;
  proposal: PinnedSummaryProposal;
  storedAt: number;
  applied: boolean;
  status: "pending" | "applied" | "rejected";
};

type ProposalRow = {
  id: number;
  agent_id: string;
  settlement_id: string;
  proposed_text: string;
  rationale: string | null;
  status: "pending" | "applied" | "rejected";
  created_at: number;
  updated_at: number;
};

function rowToStoredProposal(row: ProposalRow): StoredProposal {
  return {
    id: row.id,
    settlementId: row.settlement_id,
    agentId: row.agent_id,
    proposal: {
      proposedText: row.proposed_text,
      ...(row.rationale != null ? { rationale: row.rationale } : {}),
    },
    storedAt: row.created_at,
    applied: row.status === "applied",
    status: row.status,
  };
}

export class PinnedSummaryProposalService {
  constructor(private readonly db: Db) {}

  storeProposal(
    settlementId: string,
    agentId: string,
    proposal: PinnedSummaryProposal,
  ): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO pinned_summary_proposals (agent_id, settlement_id, proposed_text, rationale, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [agentId, settlementId, proposal.proposedText, proposal.rationale ?? null, now, now],
    );
  }

  getPendingProposals(agentId: string): StoredProposal[] {
    const rows = this.db.query<ProposalRow>(
      `SELECT id, agent_id, settlement_id, proposed_text, rationale, status, created_at, updated_at
       FROM pinned_summary_proposals
       WHERE agent_id = ? AND status = 'pending'
       ORDER BY created_at ASC`,
      [agentId],
    );
    return rows.map(rowToStoredProposal);
  }

  getLatestPending(agentId: string): StoredProposal | undefined {
    const pending = this.getPendingProposals(agentId);
    return pending.length > 0 ? pending[pending.length - 1] : undefined;
  }

  markApplied(agentId: string, settlementId: string): boolean {
    const now = Date.now();
    const result = this.db.run(
      `UPDATE pinned_summary_proposals
       SET status = 'applied', updated_at = ?
       WHERE agent_id = ? AND settlement_id = ? AND status = 'pending'`,
      [now, agentId, settlementId],
    );
    return result.changes > 0;
  }

  markRejected(agentId: string, settlementId: string): boolean {
    const now = Date.now();
    const result = this.db.run(
      `UPDATE pinned_summary_proposals
       SET status = 'rejected', updated_at = ?
       WHERE agent_id = ? AND settlement_id = ? AND status = 'pending'`,
      [now, agentId, settlementId],
    );
    return result.changes > 0;
  }

  clearAll(agentId: string): void {
    this.db.run(
      `DELETE FROM pinned_summary_proposals WHERE agent_id = ?`,
      [agentId],
    );
  }
}
