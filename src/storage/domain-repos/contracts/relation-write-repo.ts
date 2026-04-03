import type {
  MemoryRelationType,
  RelationDirectness,
  RelationSourceKind,
} from "../../../memory/types.js";

export type UpsertRelationParams = {
  sourceNodeRef: string;
  targetNodeRef: string;
  relationType: MemoryRelationType;
  sourceKind: RelationSourceKind;
  sourceRef: string;
  strength: number;
  directness: RelationDirectness;
  createdAt: number;
  updatedAt: number;
};

export type MemoryRelationRow = {
  source_node_ref: string;
  target_node_ref: string;
  relation_type: MemoryRelationType;
  source_kind: RelationSourceKind;
  source_ref: string;
  strength: number;
  directness: RelationDirectness;
  created_at: number;
  updated_at: number;
};

export interface RelationWriteRepo {
  upsertRelation(params: UpsertRelationParams): Promise<void>;
  getRelationsBySource(sourceNodeRef: string, relationType?: MemoryRelationType): Promise<MemoryRelationRow[]>;
  getRelationsForNode(nodeRef: string, relationTypes: readonly MemoryRelationType[]): Promise<MemoryRelationRow[]>;
}
