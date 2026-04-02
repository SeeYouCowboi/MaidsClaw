import type { NodeRef, ViewerContext } from "../../../memory/types.js";

export type NarrativeSearchQuery = {
  text: string;
  limit?: number;
  minScore?: number;
  includeArea?: boolean;
  includeWorld?: boolean;
};

export type NarrativeSearchHit = {
  sourceRef: NodeRef;
  docType: string;
  content: string;
  scope: "area" | "world";
  score: number;
};

export interface NarrativeSearchRepo {
  /**
   * Executes narrative-only full-text search for the caller's visibility context.
   * Implementations must search only narrative surfaces (area/world), never private cognition.
   */
  searchNarrative(query: NarrativeSearchQuery, viewerContext: ViewerContext): Promise<NarrativeSearchHit[]>;
}
