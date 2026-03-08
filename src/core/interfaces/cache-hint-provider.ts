import type { ChatMessage } from "../models/chat-provider.js";

export interface CacheHintProvider {
  applyHints(messages: ChatMessage[]): ChatMessage[];
}

export class NoopCacheHintProvider implements CacheHintProvider {
  applyHints(messages: ChatMessage[]): ChatMessage[] {
    return messages;
  }
}
