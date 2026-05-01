import type { ViewerContext } from "./contracts/viewer-context.js";
import type { RetrievalTraceCapture } from "../app/contracts/trace.js";

export type TypedRetrievalSurfaceOptions = {
  onRetrievalTraceCapture?: (capture: RetrievalTraceCapture) => void;
  sceneRetrieval?: boolean;
};

export type KnownEntityPromptOptions = {
  maxItems?: number;
  maxChars?: number;
  /**
   * Pointer keys (canonicalized form) that should be ranked above
   * recency-only candidates when present in the merged set.
   *
   * Source is typically the seeded shared_public catalog (world locations
   * + persona character names). The boost is rank-only — it does not
   * inject missing entities into the candidate set, so an entity that has
   * never been mentioned this session still won't appear here.
   */
  corePointerKeys?: ReadonlySet<string>;
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
  getKnownEntitiesForWriting?(
    viewerContext: ViewerContext,
    options?: KnownEntityPromptOptions,
  ): string | Promise<string>;
};

export type OperationalDataSource = {
  getExcerpt(keys: string[]): Record<string, unknown>;
};

export type { ViewerContext } from "./contracts/viewer-context.js";
