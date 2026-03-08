import type { ChatMessage } from "../models/chat-provider.js";

export interface ContextCompactor {
  compact(messages: ChatMessage[], budget: number): ChatMessage[];
  setFlushBoundary(recordIndex: number): void;
}
