import type {
  CoreMemoryBlockRepo,
  PersonaSnapshotInit,
} from "../storage/domain-repos/contracts/core-memory-block-repo.js";
import type {
  AppendResult,
  CoreMemoryBlock,
  CoreMemoryLabel,
  ReplaceResult,
} from "./types.js";

export class CoreMemoryService {
  constructor(private readonly repo: CoreMemoryBlockRepo) {}

  async initializeBlocks(agentId: string): Promise<void> {
    return this.repo.initializeBlocks(agentId);
  }

  async getBlock(
    agentId: string,
    label: CoreMemoryLabel,
  ): Promise<CoreMemoryBlock & { chars_current: number; chars_limit: number }> {
    return this.repo.getBlock(agentId, label);
  }

  async getAllBlocks(
    agentId: string,
  ): Promise<Array<CoreMemoryBlock & { chars_current: number }>> {
    return this.repo.getAllBlocks(agentId);
  }

  async appendBlock(
    agentId: string,
    label: CoreMemoryLabel,
    content: string,
    callerRole?: string,
  ): Promise<AppendResult> {
    return this.repo.appendBlock(agentId, label, content, callerRole);
  }

  async replaceBlock(
    agentId: string,
    label: CoreMemoryLabel,
    oldText: string,
    newText: string,
    callerRole?: string,
  ): Promise<ReplaceResult> {
    return this.repo.replaceBlock(agentId, label, oldText, newText, callerRole);
  }

  async initializeFromPersonaSnapshot(
    agentId: string,
    init: PersonaSnapshotInit,
  ): Promise<boolean> {
    return this.repo.writePersonaSnapshot(agentId, init);
  }
}
