import type { PinnedSummaryProposal } from "../runtime/rp-turn-contract.js";

export type StoredProposal = {
  settlementId: string;
  agentId: string;
  proposal: PinnedSummaryProposal;
  storedAt: number;
  applied: boolean;
};

export class PinnedSummaryProposalService {
  private readonly proposals: Map<string, StoredProposal[]> = new Map();

  storeProposal(
    settlementId: string,
    agentId: string,
    proposal: PinnedSummaryProposal,
  ): void {
    const key = agentId;
    const list = this.proposals.get(key) ?? [];
    list.push({
      settlementId,
      agentId,
      proposal,
      storedAt: Date.now(),
      applied: false,
    });
    this.proposals.set(key, list);
  }

  getPendingProposals(agentId: string): StoredProposal[] {
    return (this.proposals.get(agentId) ?? []).filter((p) => !p.applied);
  }

  getLatestPending(agentId: string): StoredProposal | undefined {
    const pending = this.getPendingProposals(agentId);
    return pending.length > 0 ? pending[pending.length - 1] : undefined;
  }

  markApplied(agentId: string, settlementId: string): boolean {
    const list = this.proposals.get(agentId);
    if (!list) return false;

    const found = list.find(
      (p) => p.settlementId === settlementId && !p.applied,
    );
    if (!found) return false;

    found.applied = true;
    return true;
  }

  clearAll(agentId: string): void {
    this.proposals.delete(agentId);
  }
}
