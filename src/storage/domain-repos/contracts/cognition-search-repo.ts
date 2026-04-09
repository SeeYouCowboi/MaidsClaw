import type { CognitionHit } from "../../../memory/cognition/cognition-search.js";
import type { CognitionCurrentRow } from "../../../memory/cognition/private-cognition-current.js";
import type { TimeSliceQuery } from "../../../memory/time-slice-query.js";
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
  /**
   * GAP-4 §1: optional entity-id filter from
   * `plan.surfacePlans.cognition.entityFilters`. The
   * `search_docs_cognition` table currently has no entity column, so this
   * filter is wired through the contract but is a SQL no-op until a
   * follow-up schema migration adds entity tracking. Empty array == no
   * filter (same as undefined).
   */
  entityIds?: number[];
  /**
   * GAP-4 §1: optional time window from
   * `plan.surfacePlans.cognition.timeWindow`. When `asOfCommittedTime` is
   * set, filters to rows whose `updated_at` is at or before that
   * timestamp. `asOfValidTime` is unused at this layer.
   */
  timeWindow?: TimeSliceQuery;
};

export type CognitionByKindOptions = {
  stance?: AssertionStance;
  basis?: AssertionBasis;
  activeOnly?: boolean;
  limit?: number;
  /** GAP-4 §1: see CognitionSearchQueryOptions.entityIds. */
  entityIds?: number[];
  /** GAP-4 §1: see CognitionSearchQueryOptions.timeWindow. */
  timeWindow?: TimeSliceQuery;
};

export interface CognitionSearchRepo {
  searchBySimilarity(query: string, agentId: string, options?: CognitionSearchQueryOptions): Promise<CognitionHit[]>;
  searchByKind(agentId: string, kind: CognitionKind, options?: CognitionByKindOptions): Promise<CognitionHit[]>;
  filterActiveCommitments(items: CognitionHit[], agentId: string): Promise<CognitionHit[]>;
  sortCommitments(items: CognitionHit[], agentId: string): Promise<CognitionHit[]>;
  getActiveCurrent(agentId: string): Promise<CognitionCurrentRow[]>;
  resolveCognitionKey(sourceRef: NodeRef, agentId: string): Promise<string | null>;
}
