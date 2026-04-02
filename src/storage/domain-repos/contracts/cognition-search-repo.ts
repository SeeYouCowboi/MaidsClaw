import type { CognitionHit } from "../../../memory/cognition/cognition-search.js";
import type { CognitionCurrentRow } from "../../../memory/cognition/private-cognition-current.js";
import type { NodeRef } from "../../../memory/types.js";
import type {
  AssertionBasis,
  AssertionStance,
  CognitionKind,
} from "../../../runtime/rp-turn-contract.js";

export type CognitionSearchQueryOptions = {
  kind?: CognitionKind;
  stance?: AssertionStance;
  basis?: AssertionBasis;
  activeOnly?: boolean;
  limit?: number;
  minScore?: number;
};

export type CognitionByKindOptions = {
  stance?: AssertionStance;
  basis?: AssertionBasis;
  activeOnly?: boolean;
  limit?: number;
};

export interface CognitionSearchRepo {
  searchBySimilarity(query: string, agentId: string, options?: CognitionSearchQueryOptions): Promise<CognitionHit[]>;
  searchByKind(agentId: string, kind: CognitionKind, options?: CognitionByKindOptions): Promise<CognitionHit[]>;
  filterActiveCommitments(items: CognitionHit[], agentId: string): Promise<CognitionHit[]>;
  sortCommitments(items: CognitionHit[], agentId: string): Promise<CognitionHit[]>;
  getActiveCurrent(agentId: string): Promise<CognitionCurrentRow[]>;
  resolveCognitionKey(sourceRef: NodeRef, agentId: string): Promise<string | null>;
}
