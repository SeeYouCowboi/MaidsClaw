import type { PublicationTargetScope } from "../../runtime/rp-turn-contract.js";

type DbLike = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

export const SURFACING_CLASSIFICATIONS = [
  "public_manifestation",
  "latent_state_update",
  "private_only",
] as const;

export const AREA_STATE_SOURCE_TYPES = ["system", "gm", "simulation", "inferred_world"] as const;

const SCENE_FACT_SOURCE_KINDS = [
  "lore_seed",
  "action_commitment",
  "system_event",
  "evidence_reveal",
  "institutional_speech_act",
] as const;

const DEFERRED_SCENE_FACT_SOURCE_KINDS = [
  "evidence_reveal",
  "institutional_speech_act",
] as const;

const AREA_FACT_EXPOSURE_SCOPES = ["area_visible", "system_only"] as const;
const WORLD_FACT_EXPOSURE_SCOPES = ["world_public", "system_only"] as const;

export type SurfacingClassification = (typeof SURFACING_CLASSIFICATIONS)[number];
export type AreaStateSourceType = (typeof AREA_STATE_SOURCE_TYPES)[number];
export type ProjectionUpdateTrigger = "publication" | "materialization" | "promotion";
export type SceneFactSourceKind = (typeof SCENE_FACT_SOURCE_KINDS)[number];
export type AreaFactExposureScope = (typeof AREA_FACT_EXPOSURE_SCOPES)[number];
export type WorldFactExposureScope = (typeof WORLD_FACT_EXPOSURE_SCOPES)[number];

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

type AreaStateAsOfRow = {
  key: string;
  value_json: string;
  surfacing_classification: SurfacingClassification;
  source_type: AreaStateSourceType;
  valid_time: number | null;
  committed_time: number | null;
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

type WorldStateAsOfRow = {
  key: string;
  value_json: string;
  surfacing_classification: SurfacingClassification;
  source_type: AreaStateSourceType;
  valid_time: number | null;
  committed_time: number | null;
};

type AreaFactCurrentRow = {
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
};

type WorldFactCurrentRow = {
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
  constructor(private readonly db: DbLike) {
    this.bootstrapSceneFactTables();
  }

  private bootstrapSceneFactTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scene_area_fact_events (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id            TEXT NOT NULL,
        area_id               INTEGER NOT NULL,
        fact_key              TEXT NOT NULL,
        value_json            TEXT NOT NULL,
        source_kind           TEXT NOT NULL
                              CHECK (source_kind IN (
                                'lore_seed', 'action_commitment', 'system_event',
                                'evidence_reveal', 'institutional_speech_act'
                              )),
        exposure_scope        TEXT NOT NULL
                              CHECK (exposure_scope IN ('area_visible', 'system_only')),
        source_settlement_id  TEXT,
        source_agent_id       TEXT,
        valid_time            TEXT NOT NULL,
        committed_time        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scene_area_fact_events_session_area_key_committed
        ON scene_area_fact_events(session_id, area_id, fact_key, committed_time DESC, id DESC);

      CREATE TABLE IF NOT EXISTS scene_area_fact_current (
        session_id            TEXT NOT NULL,
        area_id               INTEGER NOT NULL,
        fact_key              TEXT NOT NULL,
        source_event_id       INTEGER NOT NULL,
        value_json            TEXT NOT NULL,
        source_kind           TEXT NOT NULL
                              CHECK (source_kind IN (
                                'lore_seed', 'action_commitment', 'system_event',
                                'evidence_reveal', 'institutional_speech_act'
                              )),
        exposure_scope        TEXT NOT NULL
                              CHECK (exposure_scope IN ('area_visible', 'system_only')),
        source_settlement_id  TEXT,
        source_agent_id       TEXT,
        updated_at            TEXT NOT NULL,
        valid_time            TEXT NOT NULL,
        committed_time        TEXT NOT NULL,
        PRIMARY KEY (session_id, area_id, fact_key)
      );

      CREATE INDEX IF NOT EXISTS idx_scene_area_fact_current_visibility
        ON scene_area_fact_current(session_id, area_id, exposure_scope);

      CREATE TABLE IF NOT EXISTS scene_world_fact_events (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id            TEXT NOT NULL,
        fact_key              TEXT NOT NULL,
        value_json            TEXT NOT NULL,
        source_kind           TEXT NOT NULL
                              CHECK (source_kind IN (
                                'lore_seed', 'action_commitment', 'system_event',
                                'evidence_reveal', 'institutional_speech_act'
                              )),
        exposure_scope        TEXT NOT NULL
                              CHECK (exposure_scope IN ('world_public', 'system_only')),
        source_settlement_id  TEXT,
        source_agent_id       TEXT,
        valid_time            TEXT NOT NULL,
        committed_time        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scene_world_fact_events_session_key_committed
        ON scene_world_fact_events(session_id, fact_key, committed_time DESC, id DESC);

      CREATE TABLE IF NOT EXISTS scene_world_fact_current (
        session_id            TEXT NOT NULL,
        fact_key              TEXT NOT NULL,
        source_event_id       INTEGER NOT NULL,
        value_json            TEXT NOT NULL,
        source_kind           TEXT NOT NULL
                              CHECK (source_kind IN (
                                'lore_seed', 'action_commitment', 'system_event',
                                'evidence_reveal', 'institutional_speech_act'
                              )),
        exposure_scope        TEXT NOT NULL
                              CHECK (exposure_scope IN ('world_public', 'system_only')),
        source_settlement_id  TEXT,
        source_agent_id       TEXT,
        updated_at            TEXT NOT NULL,
        valid_time            TEXT NOT NULL,
        committed_time        TEXT NOT NULL,
        PRIMARY KEY (session_id, fact_key)
      );

      CREATE INDEX IF NOT EXISTS idx_scene_world_fact_current_visibility
        ON scene_world_fact_current(session_id, exposure_scope);
    `);
  }

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

  getAreaStateAsOf(agentId: string, areaId: number, key: string, asOfCommittedTime: number): AreaStateAsOfRow | null {
    return this.db
      .prepare(
        `SELECT key, value_json, surfacing_classification, source_type, valid_time, committed_time
         FROM area_state_events
         WHERE agent_id = ?
           AND area_id = ?
           AND key = ?
           AND committed_time <= ?
         ORDER BY committed_time DESC, id DESC
         LIMIT 1`,
      )
      .get(agentId, areaId, key, asOfCommittedTime) as AreaStateAsOfRow | null;
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

  getWorldStateAsOf(key: string, asOfCommittedTime: number): WorldStateAsOfRow | null {
    return this.db
      .prepare(
        `SELECT key, value_json, surfacing_classification, source_type, valid_time, committed_time
         FROM world_state_events
         WHERE key = ?
           AND committed_time <= ?
         ORDER BY committed_time DESC, id DESC
         LIMIT 1`,
      )
      .get(key, asOfCommittedTime) as WorldStateAsOfRow | null;
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

  async applyAreaFactCommit(params: {
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
  }): Promise<{ eventId: bigint }> {
    this.assertPhase1SceneFactSourceKind(params.sourceKind);
    this.assertAreaFactExposureScope(params.exposureScope);

    const valueJson = this.toJson(params.valueJson);
    const validTime = this.toIsoString(params.validTime);
    const committedTime = this.toIsoString(params.committedTime);
    const inserted = this.db
      .prepare(
        `INSERT INTO scene_area_fact_events (
           session_id,
           area_id,
           fact_key,
           value_json,
           source_kind,
           exposure_scope,
           source_settlement_id,
           source_agent_id,
           valid_time,
           committed_time
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.sessionId,
        params.areaId,
        params.factKey,
        valueJson,
        params.sourceKind,
        params.exposureScope,
        params.sourceSettlementId,
        params.sourceAgentId,
        validTime,
        committedTime,
      );

    const eventId = this.toBigInt(inserted.lastInsertRowid);

    this.db
      .prepare(
        `INSERT INTO scene_area_fact_current (
           session_id,
           area_id,
           fact_key,
           source_event_id,
           value_json,
           source_kind,
           exposure_scope,
           source_settlement_id,
           source_agent_id,
           updated_at,
           valid_time,
           committed_time
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, area_id, fact_key)
         DO UPDATE SET
           source_event_id = excluded.source_event_id,
           value_json = excluded.value_json,
           source_kind = excluded.source_kind,
           exposure_scope = excluded.exposure_scope,
           source_settlement_id = excluded.source_settlement_id,
           source_agent_id = excluded.source_agent_id,
           updated_at = excluded.updated_at,
           valid_time = excluded.valid_time,
           committed_time = excluded.committed_time
         WHERE
           excluded.committed_time > scene_area_fact_current.committed_time
           OR (
             excluded.committed_time = scene_area_fact_current.committed_time
             AND excluded.source_event_id > scene_area_fact_current.source_event_id
           )`,
      )
      .run(
        params.sessionId,
        params.areaId,
        params.factKey,
        Number(eventId),
        valueJson,
        params.sourceKind,
        params.exposureScope,
        params.sourceSettlementId,
        params.sourceAgentId,
        committedTime,
        validTime,
        committedTime,
      );

    return { eventId };
  }

  async applyWorldFactCommit(params: {
    sessionId: string;
    factKey: string;
    valueJson: unknown;
    sourceKind: SceneFactSourceKind;
    exposureScope: WorldFactExposureScope;
    sourceSettlementId: string | null;
    sourceAgentId: string | null;
    validTime: Date;
    committedTime: Date;
  }): Promise<{ eventId: bigint }> {
    this.assertPhase1SceneFactSourceKind(params.sourceKind);
    this.assertWorldFactExposureScope(params.exposureScope);

    const valueJson = this.toJson(params.valueJson);
    const validTime = this.toIsoString(params.validTime);
    const committedTime = this.toIsoString(params.committedTime);
    const inserted = this.db
      .prepare(
        `INSERT INTO scene_world_fact_events (
           session_id,
           fact_key,
           value_json,
           source_kind,
           exposure_scope,
           source_settlement_id,
           source_agent_id,
           valid_time,
           committed_time
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.sessionId,
        params.factKey,
        valueJson,
        params.sourceKind,
        params.exposureScope,
        params.sourceSettlementId,
        params.sourceAgentId,
        validTime,
        committedTime,
      );

    const eventId = this.toBigInt(inserted.lastInsertRowid);

    this.db
      .prepare(
        `INSERT INTO scene_world_fact_current (
           session_id,
           fact_key,
           source_event_id,
           value_json,
           source_kind,
           exposure_scope,
           source_settlement_id,
           source_agent_id,
           updated_at,
           valid_time,
           committed_time
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, fact_key)
         DO UPDATE SET
           source_event_id = excluded.source_event_id,
           value_json = excluded.value_json,
           source_kind = excluded.source_kind,
           exposure_scope = excluded.exposure_scope,
           source_settlement_id = excluded.source_settlement_id,
           source_agent_id = excluded.source_agent_id,
           updated_at = excluded.updated_at,
           valid_time = excluded.valid_time,
           committed_time = excluded.committed_time
         WHERE
           excluded.committed_time > scene_world_fact_current.committed_time
           OR (
             excluded.committed_time = scene_world_fact_current.committed_time
             AND excluded.source_event_id > scene_world_fact_current.source_event_id
           )`,
      )
      .run(
        params.sessionId,
        params.factKey,
        Number(eventId),
        valueJson,
        params.sourceKind,
        params.exposureScope,
        params.sourceSettlementId,
        params.sourceAgentId,
        committedTime,
        validTime,
        committedTime,
      );

    return { eventId };
  }

  async getVisibleAreaFacts(params: {
    sessionId: string;
    areaId: number;
    excludeSystemOnly?: boolean;
  }): Promise<AreaFactCurrentRow[]> {
    const rows = params.excludeSystemOnly
      ? this.db
          .prepare(
            `SELECT
               session_id,
               area_id,
               fact_key,
               source_event_id,
               value_json,
               source_kind,
               exposure_scope,
               source_settlement_id,
               source_agent_id,
               updated_at,
               valid_time,
               committed_time
             FROM scene_area_fact_current
             WHERE session_id = ?
               AND area_id = ?
               AND exposure_scope <> 'system_only'
             ORDER BY fact_key ASC`,
          )
          .all(params.sessionId, params.areaId)
      : this.db
          .prepare(
            `SELECT
               session_id,
               area_id,
               fact_key,
               source_event_id,
               value_json,
               source_kind,
               exposure_scope,
               source_settlement_id,
               source_agent_id,
               updated_at,
               valid_time,
               committed_time
             FROM scene_area_fact_current
             WHERE session_id = ?
               AND area_id = ?
             ORDER BY fact_key ASC`,
          )
          .all(params.sessionId, params.areaId);

    return rows.map((row) => this.mapAreaFactCurrentRow(row as Record<string, unknown>));
  }

  async getVisibleWorldFacts(params: {
    sessionId: string;
    excludeSystemOnly?: boolean;
  }): Promise<WorldFactCurrentRow[]> {
    const rows = params.excludeSystemOnly
      ? this.db
          .prepare(
            `SELECT
               session_id,
               fact_key,
               source_event_id,
               value_json,
               source_kind,
               exposure_scope,
               source_settlement_id,
               source_agent_id,
               updated_at,
               valid_time,
               committed_time
             FROM scene_world_fact_current
             WHERE session_id = ?
               AND exposure_scope <> 'system_only'
             ORDER BY fact_key ASC`,
          )
          .all(params.sessionId)
      : this.db
          .prepare(
            `SELECT
               session_id,
               fact_key,
               source_event_id,
               value_json,
               source_kind,
               exposure_scope,
               source_settlement_id,
               source_agent_id,
               updated_at,
               valid_time,
               committed_time
             FROM scene_world_fact_current
             WHERE session_id = ?
             ORDER BY fact_key ASC`,
          )
          .all(params.sessionId);

    return rows.map((row) => this.mapWorldFactCurrentRow(row as Record<string, unknown>));
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

  private assertPhase1SceneFactSourceKind(value: string): void {
    // Deferred kinds are representable in the type system but blocked from production writes in Phase 1.
    // TODO(deferred): evidence_reveal and institutional_speech_act are reserved for future phases.
    if (
      DEFERRED_SCENE_FACT_SOURCE_KINDS.includes(
        value as (typeof DEFERRED_SCENE_FACT_SOURCE_KINDS)[number],
      )
    ) {
      throw new Error(
        `DEFERRED_SOURCE_KIND: ${value} is not supported in Phase 1 runtime. It is reserved for future phases.`,
      );
    }
    if (SCENE_FACT_SOURCE_KINDS.includes(value as SceneFactSourceKind)) {
      return;
    }
    throw new Error(`Invalid scene fact source kind: ${value}`);
  }

  private assertAreaFactExposureScope(value: string): void {
    if (AREA_FACT_EXPOSURE_SCOPES.includes(value as AreaFactExposureScope)) {
      return;
    }
    throw new Error(`Invalid area fact exposure scope: ${value}`);
  }

  private assertWorldFactExposureScope(value: string): void {
    if (WORLD_FACT_EXPOSURE_SCOPES.includes(value as WorldFactExposureScope)) {
      return;
    }
    throw new Error(`Invalid world fact exposure scope: ${value}`);
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

  private toBigInt(value: unknown): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string" && value.length > 0) return BigInt(value);
    throw new Error(`Unable to coerce value to bigint: ${String(value)}`);
  }

  private toIsoString(value: Date): string {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error(`Invalid Date value: ${String(value)}`);
    }
    return value.toISOString();
  }

  private toDate(value: unknown): Date {
    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    throw new Error(`Unable to coerce value to Date: ${String(value)}`);
  }

  private mapAreaFactCurrentRow(row: Record<string, unknown>): AreaFactCurrentRow {
    return {
      sessionId: row.session_id as string,
      areaId: Number(row.area_id),
      factKey: row.fact_key as string,
      valueJson: this.parseJsonText(row.value_json),
      sourceKind: row.source_kind as SceneFactSourceKind,
      exposureScope: row.exposure_scope as AreaFactExposureScope,
      sourceEventId: this.toBigInt(row.source_event_id),
      sourceSettlementId:
        row.source_settlement_id == null ? null : String(row.source_settlement_id),
      sourceAgentId: row.source_agent_id == null ? null : String(row.source_agent_id),
      updatedAt: this.toDate(row.updated_at),
      validTime: this.toDate(row.valid_time),
      committedTime: this.toDate(row.committed_time),
    };
  }

  private mapWorldFactCurrentRow(row: Record<string, unknown>): WorldFactCurrentRow {
    return {
      sessionId: row.session_id as string,
      factKey: row.fact_key as string,
      valueJson: this.parseJsonText(row.value_json),
      sourceKind: row.source_kind as SceneFactSourceKind,
      exposureScope: row.exposure_scope as WorldFactExposureScope,
      sourceEventId: this.toBigInt(row.source_event_id),
      sourceSettlementId:
        row.source_settlement_id == null ? null : String(row.source_settlement_id),
      sourceAgentId: row.source_agent_id == null ? null : String(row.source_agent_id),
      updatedAt: this.toDate(row.updated_at),
      validTime: this.toDate(row.valid_time),
      committedTime: this.toDate(row.committed_time),
    };
  }

  private parseJsonText(value: unknown): unknown {
    if (typeof value !== "string") {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private toJson(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value ?? {});
  }
}
