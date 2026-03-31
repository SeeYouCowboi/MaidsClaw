import type { SharedBlockRepo, SharedBlockAttachment } from "../../storage/domain-repos/contracts/shared-block-repo.js";

export type { SharedBlockAttachment } from "../../storage/domain-repos/contracts/shared-block-repo.js";

export class SharedBlockAttachService {
  constructor(private readonly repo: SharedBlockRepo) {}

  async attachBlock(blockId: number, targetId: string, attachedByAgentId: string): Promise<SharedBlockAttachment> {
    const block = await this.repo.getBlock(blockId);
    if (!block) throw new Error(`Shared block ${blockId} not found`);

    const isAdmin = await this.repo.isBlockAdmin(blockId, attachedByAgentId);
    if (!isAdmin) {
      throw new Error(`Agent ${attachedByAgentId} is not admin of block ${blockId}`);
    }

    return this.repo.attachBlock(blockId, targetId, attachedByAgentId);
  }

  async detachBlock(blockId: number, targetId: string, requestingAgentId: string): Promise<boolean> {
    const isAdmin = await this.repo.isBlockAdmin(blockId, requestingAgentId);
    if (!isAdmin) {
      throw new Error(`Agent ${requestingAgentId} is not admin of block ${blockId}`);
    }

    return this.repo.detachBlock(blockId, targetId);
  }

  async getAttachments(targetKind: "agent", targetId: string): Promise<SharedBlockAttachment[]> {
    return this.repo.getAttachments(targetKind, targetId);
  }
}
