import type { NodeRef } from "../../../memory/types.js";

export type SearchProjectionScope = "area" | "world" | "cognition" | "episode";

export type UpsertEpisodeDocParams = {
  sourceRef: string;
  agentId: string;
  category: string;
  content: string;
  committedAt: number;
  createdAt?: number;
  entityPointerKeys?: string[];
  aliasText?: string;
  /** Defaults to 'agent' to match the column default in search_docs_episode. */
  actor?: "user" | "agent";
};

export type UpsertCognitionDocParams = {
  sourceRef: NodeRef;
  agentId: string;
  kind: string;
  basis?: string | null;
  stance?: string | null;
  content: string;
  updatedAt?: number;
  createdAt?: number;
  aliasText?: string;
};

export interface SearchProjectionRepo {
  syncSearchDoc(
    scope: "area" | "world",
    sourceRef: NodeRef,
    content: string,
    agentId?: string,
    locationEntityId?: number,
    aliasText?: string,
  ): Promise<number>;
  removeSearchDoc(scope: "area" | "world", sourceRef: NodeRef): Promise<void>;
  rebuildForScope(scope: SearchProjectionScope, agentId?: string): Promise<void>;
  upsertCognitionDoc(params: UpsertCognitionDocParams): Promise<number>;
  upsertEpisodeDoc(params: UpsertEpisodeDocParams): Promise<number>;
  updateCognitionSearchDocStanceBySourceRef(
    sourceRef: NodeRef,
    agentId: string,
    stance: string,
    updatedAt: number,
  ): Promise<void>;
}
