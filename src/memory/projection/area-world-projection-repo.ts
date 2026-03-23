import type { Database } from "bun:sqlite";
import type { PublicationTargetScope } from "../../runtime/rp-turn-contract.js";

export const SURFACING_CLASSIFICATIONS = [
  "public_manifestation",
  "latent_state_update",
  "private_only",
] as const;

export type SurfacingClassification = (typeof SURFACING_CLASSIFICATIONS)[number];
export type ProjectionUpdateTrigger = "publication" | "materialization" | "promotion";

type AreaStateRow = {
  agent_id: string;
  area_id: number;
  key: string;
  value_json: string;
  surfacing_classification: SurfacingClassification;
  updated_at: number;
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
};

type WorldNarrativeRow = {
  id: number;
  summary_text: string;
  updated_at: number;
};

export class AreaWorldProjectionRepo {
  constructor(private readonly db: Database) {}

  upsertAreaStateCurrent(input: {
    agentId: string;
    areaId: number;
    key: string;
    value: unknown;
    surfacingClassification: SurfacingClassification;
    updatedAt?: number;
  }): void {
    const updatedAt = input.updatedAt ?? Date.now();
    this.assertSurfacingClassification(input.surfacingClassification);
    this.db
      .prepare(
        `INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, area_id, key)
         DO UPDATE SET
           value_json = excluded.value_json,
           surfacing_classification = excluded.surfacing_classification,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.agentId,
        input.areaId,
        input.key,
        this.toJson(input.value),
        input.surfacingClassification,
        updatedAt,
      );
  }

  getAreaStateCurrent(agentId: string, areaId: number, key: string): AreaStateRow | null {
    return this.db
      .prepare(
        `SELECT agent_id, area_id, key, value_json, surfacing_classification, updated_at
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

  upsertWorldStateCurrent(input: {
    key: string;
    value: unknown;
    surfacingClassification: SurfacingClassification;
    updatedAt?: number;
  }): void {
    const updatedAt = input.updatedAt ?? Date.now();
    this.assertSurfacingClassification(input.surfacingClassification);
    this.db
      .prepare(
        `INSERT INTO world_state_current (key, value_json, surfacing_classification, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key)
         DO UPDATE SET
           value_json = excluded.value_json,
           surfacing_classification = excluded.surfacing_classification,
           updated_at = excluded.updated_at`,
      )
      .run(input.key, this.toJson(input.value), input.surfacingClassification, updatedAt);
  }

  getWorldStateCurrent(key: string): WorldStateRow | null {
    return this.db
      .prepare(
        `SELECT key, value_json, surfacing_classification, updated_at
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
    });
    this.upsertWorldNarrativeCurrent({ summaryText: input.summaryText, updatedAt: input.updatedAt });
  }

  private assertSurfacingClassification(value: string): void {
    if (SURFACING_CLASSIFICATIONS.includes(value as SurfacingClassification)) {
      return;
    }
    throw new Error(`Invalid surfacing classification: ${value}`);
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
