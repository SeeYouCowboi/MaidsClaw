import type { NodeRef } from "../../../memory/types.js";

export type SearchProjectionScope = "private" | "area" | "world" | "cognition" | "episode";

export type UpsertEpisodeDocParams = {
  sourceRef: string;
  agentId: string;
  category: string;
  content: string;
  committedAt: number;
  createdAt?: number;
  entityPointerKeys?: string[];
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
};

export interface SearchProjectionRepo {
  syncSearchDoc(
    scope: "private" | "area" | "world",
    sourceRef: NodeRef,
    content: string,
    agentId?: string,
    locationEntityId?: number,
  ): Promise<number>;
  removeSearchDoc(scope: "private" | "area" | "world", sourceRef: NodeRef): Promise<void>;
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
