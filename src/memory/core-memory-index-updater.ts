import type { CoreMemoryService } from "./core-memory.js";
import type {
  ChatToolDefinition,
  CreatedState,
  MemoryTaskModelProvider,
  ToolCallResult,
} from "./task-agent.js";

export class CoreMemoryIndexUpdater {
  constructor(
    private readonly coreMemory: CoreMemoryService,
    private readonly modelProvider: Pick<MemoryTaskModelProvider, "chat">,
  ) {}

  async updateIndex(agentId: string, created: CreatedState, callTwoTools: ChatToolDefinition[]): Promise<void> {
    const indexBlock = this.coreMemory.getBlock(agentId, "index");
    const callTwo = await this.modelProvider.chat(
      [
        {
          role: "system",
          content: "Choose index-worthy additions only. Keep concise lines with pointer addresses @pointer_key, #topic, e:id, f:id.",
        },
        {
          role: "user",
          content: JSON.stringify({
            currentIndexText: indexBlock.value,
            createdItems: {
              entityIds: created.entityIds,
              episodeEventIds: created.episodeEventIds,
              assertionIds: created.assertionIds,
              factIds: created.factIds,
            },
          }),
        },
      ],
      callTwoTools,
    );

    const newIndexText = this.extractUpdatedIndex(callTwo, indexBlock.value);
    if (newIndexText !== indexBlock.value) {
      const replaced = this.coreMemory.replaceBlock(agentId, "index", indexBlock.value, newIndexText, "task-agent");
      if (!replaced.success) {
        throw new Error(`Index update failed: ${replaced.reason}`);
      }
    }
  }

  private extractUpdatedIndex(toolCalls: ToolCallResult[], fallback: string): string {
    for (const call of toolCalls) {
      if (call.name !== "update_index_block") {
        continue;
      }
      const newText = typeof call.arguments.new_text === "string" ? call.arguments.new_text : null;
      if (newText !== null) {
        return newText;
      }
    }
    return fallback;
  }
}
