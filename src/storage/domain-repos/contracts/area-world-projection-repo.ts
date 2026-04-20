import type {
  AreaStateSourceType,
  ProjectionUpdateTrigger,
  SurfacingClassification,
  UpsertAreaStateInput,
  UpsertWorldStateInput,
} from "../../../memory/projection/area-world-projection-repo.js";
import type { PublicationTargetScope } from "../../../runtime/rp-turn-contract.js";

export type AreaStateRow = {
  agent_id: string;
  area_id: number;
  key: string;
  value_json: string;
  surfacing_classification: SurfacingClassification;
  source_type: AreaStateSourceType;
  updated_at: number;
  valid_time: number | null;
  committed_time: number | null;
};

export type AreaStateAsOfRow = {
  key: string;
  value_json: string;
  surfacing_classification: SurfacingClassification;
  source_type: AreaStateSourceType;
  valid_time: number | null;
  committed_time: number | null;
};

export type WorldStateRow = {
  key: string;
  value_json: string;
  surfacing_classification: SurfacingClassification;
  updated_at: number;
  valid_time: number | null;
  committed_time: number | null;
};

export type WorldStateAsOfRow = {
  key: string;
  value_json: string;
  surfacing_classification: SurfacingClassification;
  source_type: AreaStateSourceType;
  valid_time: number | null;
  committed_time: number | null;
};

export type WorldNarrativeRow = {
  id: number;
  summary_text: string;
  updated_at: number;
};

export type SceneFactSourceKind =
  | "lore_seed"
  | "action_commitment"
  | "system_event"
  | "evidence_reveal"
  | "institutional_speech_act";

export type AreaFactExposureScope = "area_visible" | "system_only";
export type WorldFactExposureScope = "world_public" | "system_only";

export interface AreaFactCurrentRow {
  sessionId: string;
  areaId: number;
  factKey: string;
  valueJson: unknown;
  sourceKind: SceneFactSourceKind;
  exposureScope: AreaFactExposureScope;
  sourceEventId: bigint;
  sourceSettlementId: string | null;
  sourceAgentId: string | null;
  updatedAt: Date;
  validTime: Date;
  committedTime: Date;
}

export interface WorldFactCurrentRow {
  sessionId: string;
  factKey: string;
  valueJson: unknown;
  sourceKind: SceneFactSourceKind;
  exposureScope: WorldFactExposureScope;
  sourceEventId: bigint;
  sourceSettlementId: string | null;
  sourceAgentId: string | null;
  updatedAt: Date;
  validTime: Date;
  committedTime: Date;
}

export interface AreaWorldProjectionRepo {
  upsertAreaState(input: UpsertAreaStateInput): Promise<void>;
  upsertAreaStateCurrent(input: UpsertAreaStateInput): Promise<void>;
  rebuildAreaCurrentFromEvents(agentId: string, areaId: number): Promise<void>;
  getAreaStateCurrent(agentId: string, areaId: number, key: string): Promise<AreaStateRow | null>;
  getAreaStateAsOf(agentId: string, areaId: number, key: string, asOfCommittedTime: number): Promise<AreaStateAsOfRow | null>;
  upsertAreaNarrativeCurrent(input: {
    agentId: string;
    areaId: number;
    summaryText: string;
    updatedAt?: number;
  }): Promise<void>;
  getAreaNarrativeCurrent(agentId: string, areaId: number): Promise<{
    agent_id: string;
    area_id: number;
    summary_text: string;
    updated_at: number;
  } | null>;
  upsertWorldStateCurrent(input: UpsertWorldStateInput): Promise<void>;
  rebuildWorldCurrentFromEvents(): Promise<void>;
  getWorldStateCurrent(key: string): Promise<WorldStateRow | null>;
  getWorldStateAsOf(key: string, asOfCommittedTime: number): Promise<WorldStateAsOfRow | null>;
  upsertWorldNarrativeCurrent(input: { summaryText: string; updatedAt?: number }): Promise<void>;
  getWorldNarrativeCurrent(): Promise<WorldNarrativeRow | null>;
  applyAreaFactCommit(params: {
    sessionId: string;
    areaId: number;
    factKey: string;
    valueJson: unknown;
    sourceKind: SceneFactSourceKind;
    exposureScope: AreaFactExposureScope;
    sourceSettlementId: string | null;
    sourceAgentId: string | null;
    validTime: Date;
    committedTime: Date;
  }): Promise<{ eventId: bigint }>;
  applyWorldFactCommit(params: {
    sessionId: string;
    factKey: string;
    valueJson: unknown;
    sourceKind: SceneFactSourceKind;
    exposureScope: WorldFactExposureScope;
    sourceSettlementId: string | null;
    sourceAgentId: string | null;
    validTime: Date;
    committedTime: Date;
  }): Promise<{ eventId: bigint }>;
  getVisibleAreaFacts(params: {
    sessionId: string;
    areaId: number;
    excludeSystemOnly?: boolean;
  }): Promise<AreaFactCurrentRow[]>;
  getVisibleWorldFacts(params: {
    sessionId: string;
    excludeSystemOnly?: boolean;
  }): Promise<WorldFactCurrentRow[]>;
  applyPublicationProjection(input: {
    trigger: ProjectionUpdateTrigger;
    targetScope: PublicationTargetScope;
    agentId: string;
    areaId: number;
    settlementId?: string;
    projectionKey: string;
    summaryText: string;
    payload?: unknown;
    surfacingClassification?: SurfacingClassification;
    updatedAt?: number;
  }): Promise<void>;
  applyMaterializationProjection(input: {
    trigger: ProjectionUpdateTrigger;
    agentId: string;
    areaId: number;
    settlementId?: string;
    projectionKey: string;
    summaryText: string;
    payload?: unknown;
    surfacingClassification?: SurfacingClassification;
    updatedAt?: number;
  }): Promise<void>;
  applyPromotionProjection(input: {
    trigger: ProjectionUpdateTrigger;
    settlementId?: string;
    projectionKey: string;
    summaryText: string;
    payload?: unknown;
    surfacingClassification?: SurfacingClassification;
    updatedAt?: number;
  }): Promise<void>;
}

export type { SurfacingClassification, AreaStateSourceType };
