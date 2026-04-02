import type {
  AppendResult,
  CoreMemoryBlock,
  CoreMemoryLabel,
  ReplaceResult,
} from "../../../memory/types.js";

export interface CoreMemoryBlockRepo {
  initializeBlocks(agentId: string): Promise<void>;
  getBlock(
    agentId: string,
    label: CoreMemoryLabel,
  ): Promise<CoreMemoryBlock & { chars_current: number; chars_limit: number }>;
  getAllBlocks(agentId: string): Promise<Array<CoreMemoryBlock & { chars_current: number }>>;
  appendBlock(agentId: string, label: CoreMemoryLabel, content: string, callerRole?: string): Promise<AppendResult>;
  replaceBlock(
    agentId: string,
    label: CoreMemoryLabel,
    oldText: string,
    newText: string,
    callerRole?: string,
  ): Promise<ReplaceResult>;
}
