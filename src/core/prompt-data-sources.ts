import type { ViewerContext } from "./contracts/viewer-context.js";

export type PersonaDataSource = {
  getSystemPrompt(personaId: string): string | undefined;
};

export type LoreDataSource = {
  getMatchingEntries(
    text: string,
    options?: { limit?: number },
  ): Array<{ content: string; title?: string; priority?: number }>;
  getWorldRules(): Array<{ content: string; title?: string }>;
};

export type MemoryDataSource = {
  getCoreMemoryBlocks(agentId: string): string;
  getPinnedBlocks?(agentId: string): string;
  getSharedBlocks?(agentId: string): string;
  getRecentCognition(viewerContext: ViewerContext): string;
  getMemoryHints(userMessage: string, viewerContext: ViewerContext): Promise<string>;
  getAttachedSharedBlocks?(agentId: string): string | Promise<string>;
  getTypedRetrievalSurface?(userMessage: string, viewerContext: ViewerContext): string | Promise<string>;
};

export type OperationalDataSource = {
  getExcerpt(keys: string[]): Record<string, unknown>;
};

export type { ViewerContext } from "./contracts/viewer-context.js";
