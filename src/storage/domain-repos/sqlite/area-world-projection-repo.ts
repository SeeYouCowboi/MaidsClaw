import {
  AreaWorldProjectionRepo as SqliteAreaWorldProjectionRepo,
  type ProjectionUpdateTrigger,
  type SurfacingClassification,
  type UpsertAreaStateInput,
  type UpsertWorldStateInput,
} from "../../../memory/projection/area-world-projection-repo.js";
import type { PublicationTargetScope } from "../../../runtime/rp-turn-contract.js";
import type {
  AreaStateAsOfRow,
  AreaStateRow,
  AreaWorldProjectionRepo,
  WorldNarrativeRow,
  WorldStateAsOfRow,
  WorldStateRow,
} from "../contracts/area-world-projection-repo.js";

export class SqliteAreaWorldProjectionRepoAdapter implements AreaWorldProjectionRepo {
  constructor(private readonly impl: SqliteAreaWorldProjectionRepo) {}

  async upsertAreaState(input: UpsertAreaStateInput): Promise<void> {
    return Promise.resolve(this.impl.upsertAreaState(input));
  }

  async upsertAreaStateCurrent(input: UpsertAreaStateInput): Promise<void> {
    return Promise.resolve(this.impl.upsertAreaStateCurrent(input));
  }

  async rebuildAreaCurrentFromEvents(agentId: string, areaId: number): Promise<void> {
    return Promise.resolve(this.impl.rebuildAreaCurrentFromEvents(agentId, areaId));
  }

  async getAreaStateCurrent(agentId: string, areaId: number, key: string): Promise<AreaStateRow | null> {
    return Promise.resolve(this.impl.getAreaStateCurrent(agentId, areaId, key) as AreaStateRow | null);
  }

  async getAreaStateAsOf(
    agentId: string,
    areaId: number,
    key: string,
    asOfCommittedTime: number,
  ): Promise<AreaStateAsOfRow | null> {
    return Promise.resolve(this.impl.getAreaStateAsOf(agentId, areaId, key, asOfCommittedTime) as AreaStateAsOfRow | null);
  }

  async upsertAreaNarrativeCurrent(input: {
    agentId: string;
    areaId: number;
    summaryText: string;
    updatedAt?: number;
  }): Promise<void> {
    return Promise.resolve(this.impl.upsertAreaNarrativeCurrent(input));
  }

  async getAreaNarrativeCurrent(
    agentId: string,
    areaId: number,
  ): Promise<{ agent_id: string; area_id: number; summary_text: string; updated_at: number } | null> {
    return Promise.resolve(this.impl.getAreaNarrativeCurrent(agentId, areaId));
  }

  async upsertWorldStateCurrent(input: UpsertWorldStateInput): Promise<void> {
    return Promise.resolve(this.impl.upsertWorldStateCurrent(input));
  }

  async rebuildWorldCurrentFromEvents(): Promise<void> {
    return Promise.resolve(this.impl.rebuildWorldCurrentFromEvents());
  }

  async getWorldStateCurrent(key: string): Promise<WorldStateRow | null> {
    return Promise.resolve(this.impl.getWorldStateCurrent(key) as WorldStateRow | null);
  }

  async getWorldStateAsOf(key: string, asOfCommittedTime: number): Promise<WorldStateAsOfRow | null> {
    return Promise.resolve(this.impl.getWorldStateAsOf(key, asOfCommittedTime) as WorldStateAsOfRow | null);
  }

  async upsertWorldNarrativeCurrent(input: { summaryText: string; updatedAt?: number }): Promise<void> {
    return Promise.resolve(this.impl.upsertWorldNarrativeCurrent(input));
  }

  async getWorldNarrativeCurrent(): Promise<WorldNarrativeRow | null> {
    return Promise.resolve(this.impl.getWorldNarrativeCurrent() as WorldNarrativeRow | null);
  }

  async applyPublicationProjection(input: {
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
  }): Promise<void> {
    return Promise.resolve(this.impl.applyPublicationProjection(input));
  }

  async applyMaterializationProjection(input: {
    trigger: ProjectionUpdateTrigger;
    agentId: string;
    areaId: number;
    settlementId?: string;
    projectionKey: string;
    summaryText: string;
    payload?: unknown;
    surfacingClassification?: SurfacingClassification;
    updatedAt?: number;
  }): Promise<void> {
    return Promise.resolve(this.impl.applyMaterializationProjection(input));
  }

  async applyPromotionProjection(input: {
    trigger: ProjectionUpdateTrigger;
    settlementId?: string;
    projectionKey: string;
    summaryText: string;
    payload?: unknown;
    surfacingClassification?: SurfacingClassification;
    updatedAt?: number;
  }): Promise<void> {
    return Promise.resolve(this.impl.applyPromotionProjection(input));
  }
}
