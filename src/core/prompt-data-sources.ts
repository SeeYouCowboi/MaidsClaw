import type { ViewerContext } from "./contracts/viewer-context.js";
import type { RetrievalTraceCapture } from "../app/contracts/trace.js";

export type TypedRetrievalSurfaceOptions = {
  onRetrievalTraceCapture?: (capture: RetrievalTraceCapture) => void;
  /** Persona-derived entity names (e.g. character names from the active card registry)
   *  to inject as additional entity hints for retrieval query expansion. */
  personaEntityHints?: string[];
};

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
  getPinnedBlocks?(agentId: string): string | Promise<string>;
  getSharedBlocks?(agentId: string): string | Promise<string>;
  getRecentCognition(viewerContext: ViewerContext): string | Promise<string>;
  getAttachedSharedBlocks?(agentId: string): string | Promise<string>;
  getTypedRetrievalSurface?(
    userMessage: string,
    viewerContext: ViewerContext,
    options?: TypedRetrievalSurfaceOptions,
  ): string | Promise<string>;
};

export type OperationalDataSource = {
  getExcerpt(keys: string[]): Record<string, unknown>;
};

export type { ViewerContext } from "./contracts/viewer-context.js";
