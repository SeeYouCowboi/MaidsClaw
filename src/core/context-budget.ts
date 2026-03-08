import type { ChatMessage, ContentBlock } from "./models/chat-provider.js";
import { countTokens } from "./native.js";
import { MaidsClawError } from "./errors.js";
import type { TokenBudget } from "./token-budget.js";

/** Per-message formatting overhead in tokens (role tag, delimiters, etc.) */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * ContextBudgetManager — manages input budget and G4 eviction guard.
 *
 * Responsibilities:
 * - Check whether individual messages or message arrays fit in the input budget
 * - Estimate token counts for message arrays
 * - Enforce the G4 eviction invariant via flush boundary tracking
 *
 * This is pure budget math. No summarization, no memory logic.
 */
export class ContextBudgetManager {
  private readonly budget: TokenBudget;
  private flushBoundary: number;

  constructor(budget: TokenBudget) {
    this.budget = budget;
    this.flushBoundary = -1; // nothing is safe to evict initially
  }

  /**
   * Check if a single message text is too large for the input budget.
   * Throws INPUT_TOO_LARGE if text tokens exceed inputBudget.
   */
  checkInputSize(text: string): void {
    const tokens = countTokens(text);
    if (tokens > this.budget.inputBudget) {
      throw new MaidsClawError({
        code: "INPUT_TOO_LARGE",
        message: `Input text is ${tokens} tokens, exceeding input budget of ${this.budget.inputBudget} tokens`,
        retriable: false,
        details: { tokens, inputBudget: this.budget.inputBudget },
      });
    }
  }

  /**
   * Check if an array of messages fits within the input budget.
   */
  fitsInBudget(messages: ChatMessage[]): boolean {
    return this.estimateTokens(messages) <= this.budget.inputBudget;
  }

  /**
   * Estimate total token count for an array of ChatMessages.
   * Sums token counts of all message content strings + MESSAGE_OVERHEAD_TOKENS per message.
   */
  estimateTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += MESSAGE_OVERHEAD_TOKENS;
      if (typeof msg.content === "string") {
        total += countTokens(msg.content);
      } else {
        // ContentBlock[] — sum text from each block
        for (const block of msg.content) {
          total += countTokens(extractBlockText(block));
        }
      }
    }
    return total;
  }

  // ── G4 Eviction Guard ──────────────────────────────────────────────

  /**
   * Set the flush boundary — records with index <= boundary are safe to evict.
   * Only call this after T28a has accepted ownership of the batch.
   */
  setFlushBoundary(recordIndex: number): void {
    this.flushBoundary = recordIndex;
  }

  /**
   * Check if a record at the given index is safe to evict.
   * Returns true only if recordIndex <= flushBoundary and flushBoundary >= 0.
   */
  canEvict(recordIndex: number): boolean {
    return this.flushBoundary >= 0 && recordIndex <= this.flushBoundary;
  }

  /**
   * Get the current flush boundary.
   * Returns -1 if nothing is safe to evict.
   */
  getFlushBoundary(): number {
    return this.flushBoundary;
  }
}

/** Extract text from a ContentBlock for token counting. */
function extractBlockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_use":
      return `${block.name} ${JSON.stringify(block.input)}`;
    case "tool_result":
      return block.content;
  }
}
