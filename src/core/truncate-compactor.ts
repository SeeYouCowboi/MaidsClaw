import type { ContextCompactor } from "./interfaces/context-compactor.js";
import type { ChatMessage } from "./models/chat-provider.js";

type IndexedMessage = {
  index: number;
  message: ChatMessage;
};

export class TruncateCompactor implements ContextCompactor {
  private flushBoundary = -1;

  setFlushBoundary(recordIndex: number): void {
    this.flushBoundary = recordIndex;
  }

  compact(messages: ChatMessage[], budget: number): ChatMessage[] {
    if (budget <= 0) {
      return messages.filter((message, index) => message.role === "system" || index > this.flushBoundary);
    }

    const retained: IndexedMessage[] = messages.map((message, index) => ({ message, index }));
    while (estimateBudget(retained) > budget) {
      const evictableIndex = retained.findIndex(
        (entry) => entry.message.role !== "system" && entry.index <= this.flushBoundary
      );

      if (evictableIndex < 0) {
        break;
      }

      retained.splice(evictableIndex, 1);
    }

    return retained.map((entry) => entry.message);
  }
}

function estimateBudget(messages: IndexedMessage[]): number {
  let total = 0;
  for (const entry of messages) {
    total += estimateMessageBudget(entry.message);
  }
  return total;
}

function estimateMessageBudget(message: ChatMessage): number {
  if (typeof message.content === "string") {
    return estimateTextBudget(message.content);
  }

  return message.content.reduce((sum, block) => {
    if (block.type === "text") {
      return sum + estimateTextBudget(block.text);
    }
    if (block.type === "tool_result") {
      return sum + estimateTextBudget(block.content);
    }
    return sum + estimateTextBudget(JSON.stringify(block.input));
  }, 0);
}

function estimateTextBudget(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
