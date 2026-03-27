import type { Database } from "bun:sqlite";
import type { PublicationTargetScope } from "../../runtime/rp-turn-contract.js";

export const SURFACING_CLASSIFICATIONS = [
  "public_manifestation",
  "latent_state_update",
  "private_only",
] as const;

export const AREA_STATE_SOURCE_TYPES = ["system", "gm", "simulation", "inferred_world"] as const;

export type SurfacingClassification = (typeof SURFACING_CLASSIFICATIONS)[number];
export type AreaStateSourceType = (typeof AREA_STATE_SOURCE_TYPES)[number];
export type ProjectionUpdateTrigger = "publication" | "materialization" | "promotion";

type AreaStateRow = {
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

type AreaNarrativeRow = {
  agent_id: string;
  area_id: number;
  summary_text: string;
  updated_at: number;
};

type WorldStateRow = {
  key: string;
  value_json: string;
  surfacing_classification: SurfacingClassification;
  updated_at: number;
  valid_time: number | null;
  committed_time: number | null;
};

type WorldNarrativeRow = {
  id: number;
  summary_text: string;
  updated_at: number;
};

export type UpsertAreaStateInput = {
  agentId: string;
  areaId: number;
  key: string;
  value: unknown;
  surfacingClassification: SurfacingClassification;
  sourceType?: AreaStateSourceType;
  updatedAt?: number;
  validTime?: number;
  committedTime?: number;
  settlementId?: string;
};

export type UpsertWorldStateInput = {
  key: string;
  value: unknown;
  surfacingClassification: SurfacingClassification;
  sourceType?: AreaStateSourceType;
  updatedAt?: number;
  validTime?: number;
  committedTime?: number;
  settlementId?: string;
};

export class AreaWorldProjectionRepo {
  constructor(private readonly db: Database) {}

  upsertAreaState(input: UpsertAreaStateInput): void {
    this.upsertAreaStateCurrent(input);
  }

  upsertAreaStateCurrent(input: UpsertAreaStateInput): void {
    const updatedAt = input.updatedAt ?? Date.now();
    const sourceType = input.sourceType ?? "system";
    const validTime = input.validTime ?? updatedAt;
    const committedTime = input.committedTime ?? updatedAt;
    const settlementId = this.resolveSettlementId(input.settlementId, committedTime);
    const valueJson = this.toJson(input.value);
    this.assertSurfacingClassification(input.surfacingClassification);
    this.assertAreaStateSourceType(sourceType);
    this.db
      .prepare(
        `INSERT INTO area_state_events (agent_id, area_id, key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.agentId,
        input.areaId,
        input.key,
        valueJson,
        input.surfacingClassification,
        sourceType,
        validTime,
        committedTime,
        settlementId,
        committedTime,
      );

    this.db
      .prepare(
        `INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, area_id, key)
         DO UPDATE SET
            value_json = excluded.value_json,
            surfacing_classification = excluded.surfacing_classification,
            source_type = excluded.source_type,
            updated_at = excluded.updated_at,
            valid_time = excluded.valid_time,
            committed_time = excluded.committed_time`,
      )
      .run(
        input.agentId,
        input.areaId,
        input.key,
        valueJson,
        input.surfacingClassification,
        sourceType,
        updatedAt,
        validTime,
        committedTime,
      );
  }

  rebuildAreaCurrentFromEvents(agentId: string, areaId: number): void {
    this.db.prepare(`DELETE FROM area_state_current WHERE agent_id = ? AND area_id = ?`).run(agentId, areaId);

    this.db
      .prepare(
        `INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
         SELECT e1.agent_id, e1.area_id, e1.key, e1.value_json, e1.surfacing_classification, e1.source_type,
                e1.committed_time AS updated_at, e1.valid_time, e1.committed_time
         FROM area_state_events e1
         WHERE e1.agent_id = ?
           AND e1.area_id = ?
           AND e1.id = (
             SELECT e2.id
             FROM area_state_events e2
             WHERE e2.agent_id = e1.agent_id
               AND e2.area_id = e1.area_id
               AND e2.key = e1.key
             ORDER BY e2.committed_time DESC, e2.id DESC
             LIMIT 1
           )`,
      )
      .run(agentId, areaId);
  }

  getAreaStateCurrent(agentId: string, areaId: number, key: string): AreaStateRow | null {
    return this.db
      .prepare(
        `SELECT agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time
         FROM area_state_current
         WHERE agent_id = ? AND area_id = ? AND key = ?`,
      )
      .get(agentId, areaId, key) as AreaStateRow | null;
  }

  upsertAreaNarrativeCurrent(input: {
    agentId: string;
    areaId: number;
    summaryText: string;
    updatedAt?: number;
  }): void {
    const updatedAt = input.updatedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO area_narrative_current (agent_id, area_id, summary_text, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, area_id)
         DO UPDATE SET
           summary_text = excluded.summary_text,
           updated_at = excluded.updated_at`,
      )
      .run(input.agentId, input.areaId, input.summaryText, updatedAt);
  }

  getAreaNarrativeCurrent(agentId: string, areaId: number): AreaNarrativeRow | null {
    return this.db
      .prepare(
        `SELECT agent_id, area_id, summary_text, updated_at
         FROM area_narrative_current
         WHERE agent_id = ? AND area_id = ?`,
      )
      .get(agentId, areaId) as AreaNarrativeRow | null;
  }

  upsertWorldStateCurrent(input: UpsertWorldStateInput): void {
    const updatedAt = input.updatedAt ?? Date.now();
    const sourceType = input.sourceType ?? "system";
    const validTime = input.validTime ?? updatedAt;
    const committedTime = input.committedTime ?? updatedAt;
    const settlementId = this.resolveSettlementId(input.settlementId, committedTime);
    const valueJson = this.toJson(input.value);
    this.assertSurfacingClassification(input.surfacingClassification);
    this.assertAreaStateSourceType(sourceType);

    this.db
      .prepare(
        `INSERT INTO world_state_events (key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.key,
        valueJson,
        input.surfacingClassification,
        sourceType,
        validTime,
        committedTime,
        settlementId,
        committedTime,
      );

    this.db
      .prepare(
        `INSERT INTO world_state_current (key, value_json, surfacing_classification, updated_at, valid_time, committed_time)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key)
         DO UPDATE SET
            value_json = excluded.value_json,
            surfacing_classification = excluded.surfacing_classification,
            updated_at = excluded.updated_at,
            valid_time = excluded.valid_time,
            committed_time = excluded.committed_time`,
      )
      .run(input.key, valueJson, input.surfacingClassification, updatedAt, validTime, committedTime);
  }

  rebuildWorldCurrentFromEvents(): void {
    this.db.exec(`DELETE FROM world_state_current`);

    this.db
      .prepare(
        `INSERT INTO world_state_current (key, value_json, surfacing_classification, updated_at, valid_time, committed_time)
         SELECT e1.key, e1.value_json, e1.surfacing_classification,
                e1.committed_time AS updated_at, e1.valid_time, e1.committed_time
         FROM world_state_events e1
         WHERE e1.id = (
           SELECT e2.id
           FROM world_state_events e2
           WHERE e2.key = e1.key
           ORDER BY e2.committed_time DESC, e2.id DESC
           LIMIT 1
         )`,
      )
      .run();
  }

  getWorldStateCurrent(key: string): WorldStateRow | null {
    return this.db
      .prepare(
        `SELECT key, value_json, surfacing_classification, updated_at, valid_time, committed_time
          FROM world_state_current
          WHERE key = ?`,
      )
      .get(key) as WorldStateRow | null;
  }

  upsertWorldNarrativeCurrent(input: { summaryText: string; updatedAt?: number }): void {
    const updatedAt = input.updatedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO world_narrative_current (id, summary_text, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id)
         DO UPDATE SET
           summary_text = excluded.summary_text,
           updated_at = excluded.updated_at`,
      )
      .run(input.summaryText, updatedAt);
  }

  getWorldNarrativeCurrent(): WorldNarrativeRow | null {
    return this.db
      .prepare(
        `SELECT id, summary_text, updated_at
         FROM world_narrative_current
         WHERE id = 1`,
      )
      .get() as WorldNarrativeRow | null;
  }

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
  }): void {
    this.assertTrigger(input.trigger, ["publication"]);
    const classification = input.surfacingClassification ?? "public_manifestation";
    if (input.targetScope === "world_public") {
      this.assertWorldClassification(classification);
      this.upsertWorldStateCurrent({
        key: input.projectionKey,
        value: input.payload ?? { summary: input.summaryText },
        surfacingClassification: classification,
        updatedAt: input.updatedAt,
        settlementId: input.settlementId,
      });
      this.upsertWorldNarrativeCurrent({ summaryText: input.summaryText, updatedAt: input.updatedAt });
      return;
    }

    this.upsertAreaStateCurrent({
      agentId: input.agentId,
      areaId: input.areaId,
      key: input.projectionKey,
      value: input.payload ?? { summary: input.summaryText },
      surfacingClassification: classification,
      updatedAt: input.updatedAt,
      settlementId: input.settlementId,
    });
    if (classification === "public_manifestation") {
      this.upsertAreaNarrativeCurrent({
        agentId: input.agentId,
        areaId: input.areaId,
        summaryText: input.summaryText,
        updatedAt: input.updatedAt,
      });
    }
  }

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
  }): void {
    this.assertTrigger(input.trigger, ["materialization"]);
    const classification = input.surfacingClassification ?? "public_manifestation";
    this.upsertAreaStateCurrent({
      agentId: input.agentId,
      areaId: input.areaId,
      key: input.projectionKey,
      value: input.payload ?? { summary: input.summaryText },
      surfacingClassification: classification,
      updatedAt: input.updatedAt,
      settlementId: input.settlementId,
    });
    if (classification === "public_manifestation") {
      this.upsertAreaNarrativeCurrent({
        agentId: input.agentId,
        areaId: input.areaId,
        summaryText: input.summaryText,
        updatedAt: input.updatedAt,
      });
    }
  }

  applyPromotionProjection(input: {
    trigger: ProjectionUpdateTrigger;
    settlementId?: string;
    projectionKey: string;
    summaryText: string;
    payload?: unknown;
    surfacingClassification?: SurfacingClassification;
    updatedAt?: number;
  }): void {
    this.assertTrigger(input.trigger, ["promotion"]);
    const classification = input.surfacingClassification ?? "public_manifestation";
    this.assertWorldClassification(classification);
    this.upsertWorldStateCurrent({
      key: input.projectionKey,
      value: input.payload ?? { summary: input.summaryText },
      surfacingClassification: classification,
      updatedAt: input.updatedAt,
      settlementId: input.settlementId,
    });
    this.upsertWorldNarrativeCurrent({ summaryText: input.summaryText, updatedAt: input.updatedAt });
  }

  private resolveSettlementId(settlementId: string | undefined, committedTime: number): string {
    if (settlementId && settlementId.trim().length > 0) {
      return settlementId;
    }
    return `legacy:auto:${committedTime}`;
  }

  private assertSurfacingClassification(value: string): void {
    if (SURFACING_CLASSIFICATIONS.includes(value as SurfacingClassification)) {
      return;
    }
    throw new Error(`Invalid surfacing classification: ${value}`);
  }

  private assertAreaStateSourceType(value: string): void {
    if (AREA_STATE_SOURCE_TYPES.includes(value as AreaStateSourceType)) {
      return;
    }
    throw new Error(`Invalid area state source type: ${value}`);
  }

  private assertWorldClassification(value: SurfacingClassification): void {
    if (value !== "public_manifestation") {
      throw new Error(`world projections only accept public_manifestation, got ${value}`);
    }
  }

  private assertTrigger(trigger: ProjectionUpdateTrigger, allowed: ProjectionUpdateTrigger[]): void {
    if (!allowed.includes(trigger)) {
      throw new Error(`Projection update trigger '${trigger}' is not allowed in this path`);
    }
  }

  private toJson(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value ?? {});
  }
}
