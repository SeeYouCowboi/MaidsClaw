import { CoreMemoryService } from "../../../memory/core-memory.js";
import type {
  AppendResult,
  CoreMemoryBlock,
  CoreMemoryLabel,
  ReplaceResult,
} from "../../../memory/types.js";
import type { CoreMemoryBlockRepo } from "../contracts/core-memory-block-repo.js";

export class SqliteCoreMemoryBlockRepoAdapter implements CoreMemoryBlockRepo {
  constructor(private readonly impl: CoreMemoryService) {}

  async initializeBlocks(agentId: string): Promise<void> {
    return Promise.resolve(this.impl.initializeBlocks(agentId));
  }

  async getBlock(
    agentId: string,
    label: CoreMemoryLabel,
  ): Promise<CoreMemoryBlock & { chars_current: number; chars_limit: number }> {
    return Promise.resolve(this.impl.getBlock(agentId, label));
  }

  async getAllBlocks(agentId: string): Promise<Array<CoreMemoryBlock & { chars_current: number }>> {
    return Promise.resolve(this.impl.getAllBlocks(agentId));
  }

  async appendBlock(agentId: string, label: CoreMemoryLabel, content: string, callerRole?: string): Promise<AppendResult> {
    return Promise.resolve(this.impl.appendBlock(agentId, label, content, callerRole));
  }

  async replaceBlock(
    agentId: string,
    label: CoreMemoryLabel,
    oldText: string,
    newText: string,
    callerRole?: string,
  ): Promise<ReplaceResult> {
    return Promise.resolve(this.impl.replaceBlock(agentId, label, oldText, newText, callerRole));
  }
}
