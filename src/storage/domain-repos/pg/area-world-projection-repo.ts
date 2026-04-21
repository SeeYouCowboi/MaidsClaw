import type postgres from "postgres";
import {
	AREA_STATE_SOURCE_TYPES,
	type AreaStateSourceType,
	type ProjectionUpdateTrigger,
	SURFACING_CLASSIFICATIONS,
	type SurfacingClassification,
	type UpsertAreaStateInput,
	type UpsertWorldStateInput,
} from "../../../memory/projection/area-world-projection-repo.js";
import type { PublicationTargetScope } from "../../../runtime/rp-turn-contract.js";
import type {
	AreaFactCurrentRow,
	AreaFactExposureScope,
	AreaStateAsOfRow,
	AreaStateRow,
	AreaWorldProjectionRepo,
	SceneFactSourceKind,
	WorldFactCurrentRow,
	WorldFactExposureScope,
	WorldNarrativeRow,
	WorldStateAsOfRow,
	WorldStateRow,
} from "../contracts/area-world-projection-repo.js";

function stringifyJsonb(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value ?? {});
}

const SCENE_FACT_SOURCE_KINDS = [
	"lore_seed",
	"action_commitment",
	"system_event",
	"evidence_reveal",
	"institutional_speech_act",
] as const;

const PHASE_1_SCENE_FACT_SOURCE_KINDS = [
	"lore_seed",
	"action_commitment",
	"system_event",
] as const;

const DEFERRED_SCENE_FACT_SOURCE_KINDS = [
	"evidence_reveal",
	"institutional_speech_act",
] as const;

const AREA_FACT_EXPOSURE_SCOPES = ["area_visible", "system_only"] as const;
const WORLD_FACT_EXPOSURE_SCOPES = ["world_public", "system_only"] as const;

export class PgAreaWorldProjectionRepo implements AreaWorldProjectionRepo {
	constructor(private readonly sql: postgres.Sql) {}

	async upsertAreaState(input: UpsertAreaStateInput): Promise<void> {
		await this.upsertAreaStateCurrent(input);
	}

	async upsertAreaStateCurrent(input: UpsertAreaStateInput): Promise<void> {
		const updatedAt = input.updatedAt ?? Date.now();
		const sourceType = input.sourceType ?? "system";
		const validTime = input.validTime ?? updatedAt;
		const committedTime = input.committedTime ?? updatedAt;
		const settlementId = this.resolveSettlementId(
			input.settlementId,
			committedTime,
		);
		const valueJsonb = this.jsonb(input.value);
		this.assertSurfacingClassification(input.surfacingClassification);
		this.assertAreaStateSourceType(sourceType);

		await this.sql`
      INSERT INTO area_state_events (
        agent_id, area_id, key, value_json, surfacing_classification,
        source_type, valid_time, committed_time, settlement_id, created_at
      ) VALUES (
        ${input.agentId}, ${input.areaId}, ${input.key}, ${valueJsonb},
        ${input.surfacingClassification}, ${sourceType}, ${validTime},
        ${committedTime}, ${settlementId}, ${committedTime}
      )
    `;

		await this.sql`
      INSERT INTO area_state_current (
        agent_id, area_id, key, value_json, surfacing_classification,
        source_type, updated_at, valid_time, committed_time
      ) VALUES (
        ${input.agentId}, ${input.areaId}, ${input.key}, ${valueJsonb},
        ${input.surfacingClassification}, ${sourceType}, ${updatedAt},
        ${validTime}, ${committedTime}
      )
      ON CONFLICT(agent_id, area_id, key) DO UPDATE SET
        value_json = excluded.value_json,
        surfacing_classification = excluded.surfacing_classification,
        source_type = excluded.source_type,
        updated_at = excluded.updated_at,
        valid_time = excluded.valid_time,
        committed_time = excluded.committed_time
    `;
	}

	async rebuildAreaCurrentFromEvents(
		agentId: string,
		areaId: number,
	): Promise<void> {
		await this.sql`
      DELETE FROM area_state_current
      WHERE agent_id = ${agentId} AND area_id = ${areaId}
    `;

		await this.sql`
      INSERT INTO area_state_current (
        agent_id, area_id, key, value_json, surfacing_classification,
        source_type, updated_at, valid_time, committed_time
      )
      SELECT e1.agent_id, e1.area_id, e1.key, e1.value_json,
             e1.surfacing_classification, e1.source_type,
             e1.committed_time AS updated_at, e1.valid_time, e1.committed_time
      FROM area_state_events e1
      WHERE e1.agent_id = ${agentId}
        AND e1.area_id = ${areaId}
        AND e1.id = (
          SELECT e2.id
          FROM area_state_events e2
          WHERE e2.agent_id = e1.agent_id
            AND e2.area_id = e1.area_id
            AND e2.key = e1.key
          ORDER BY e2.committed_time DESC, e2.id DESC
          LIMIT 1
        )
    `;
	}

	async getAreaStateCurrent(
		agentId: string,
		areaId: number,
		key: string,
	): Promise<AreaStateRow | null> {
		const rows = await this.sql`
      SELECT agent_id, area_id, key, value_json, surfacing_classification,
             source_type, updated_at, valid_time, committed_time
      FROM area_state_current
      WHERE agent_id = ${agentId} AND area_id = ${areaId} AND key = ${key}
    `;
		if (rows.length === 0) return null;
		return this.mapAreaStateRow(rows[0]);
	}

	async getAreaStateAsOf(
		agentId: string,
		areaId: number,
		key: string,
		asOfCommittedTime: number,
	): Promise<AreaStateAsOfRow | null> {
		const rows = await this.sql`
      SELECT key, value_json, surfacing_classification, source_type,
             valid_time, committed_time
      FROM area_state_events
      WHERE agent_id = ${agentId}
        AND area_id = ${areaId}
        AND key = ${key}
        AND committed_time <= ${asOfCommittedTime}
      ORDER BY committed_time DESC, id DESC
      LIMIT 1
    `;
		if (rows.length === 0) return null;
		return this.mapAreaStateAsOfRow(rows[0]);
	}

	async upsertAreaNarrativeCurrent(input: {
		agentId: string;
		areaId: number;
		summaryText: string;
		updatedAt?: number;
	}): Promise<void> {
		const updatedAt = input.updatedAt ?? Date.now();
		await this.sql`
      INSERT INTO area_narrative_current (agent_id, area_id, summary_text, updated_at)
      VALUES (${input.agentId}, ${input.areaId}, ${input.summaryText}, ${updatedAt})
      ON CONFLICT(agent_id, area_id) DO UPDATE SET
        summary_text = excluded.summary_text,
        updated_at = excluded.updated_at
    `;
	}

	async getAreaNarrativeCurrent(
		agentId: string,
		areaId: number,
	): Promise<{
		agent_id: string;
		area_id: number;
		summary_text: string;
		updated_at: number;
	} | null> {
		const rows = await this.sql`
      SELECT agent_id, area_id, summary_text, updated_at
      FROM area_narrative_current
      WHERE agent_id = ${agentId} AND area_id = ${areaId}
    `;
		if (rows.length === 0) return null;
		return {
			agent_id: rows[0].agent_id as string,
			area_id: Number(rows[0].area_id),
			summary_text: rows[0].summary_text as string,
			updated_at: Number(rows[0].updated_at),
		};
	}

	async upsertWorldStateCurrent(input: UpsertWorldStateInput): Promise<void> {
		const updatedAt = input.updatedAt ?? Date.now();
		const sourceType = input.sourceType ?? "system";
		const validTime = input.validTime ?? updatedAt;
		const committedTime = input.committedTime ?? updatedAt;
		const settlementId = this.resolveSettlementId(
			input.settlementId,
			committedTime,
		);
		const valueJsonb = this.jsonb(input.value);
		this.assertSurfacingClassification(input.surfacingClassification);
		this.assertAreaStateSourceType(sourceType);

		await this.sql`
      INSERT INTO world_state_events (
        key, value_json, surfacing_classification, source_type,
        valid_time, committed_time, settlement_id, created_at
      ) VALUES (
        ${input.key}, ${valueJsonb}, ${input.surfacingClassification},
        ${sourceType}, ${validTime}, ${committedTime},
        ${settlementId}, ${committedTime}
      )
    `;

		await this.sql`
      INSERT INTO world_state_current (
        key, value_json, surfacing_classification, updated_at,
        valid_time, committed_time
      ) VALUES (
        ${input.key}, ${valueJsonb}, ${input.surfacingClassification},
        ${updatedAt}, ${validTime}, ${committedTime}
      )
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        surfacing_classification = excluded.surfacing_classification,
        updated_at = excluded.updated_at,
        valid_time = excluded.valid_time,
        committed_time = excluded.committed_time
    `;
	}

	async rebuildWorldCurrentFromEvents(): Promise<void> {
		await this.sql`DELETE FROM world_state_current`;

		await this.sql`
      INSERT INTO world_state_current (
        key, value_json, surfacing_classification, updated_at,
        valid_time, committed_time
      )
      SELECT e1.key, e1.value_json, e1.surfacing_classification,
             e1.committed_time AS updated_at, e1.valid_time, e1.committed_time
      FROM world_state_events e1
      WHERE e1.id = (
        SELECT e2.id
        FROM world_state_events e2
        WHERE e2.key = e1.key
        ORDER BY e2.committed_time DESC, e2.id DESC
        LIMIT 1
      )
    `;
	}

	async getWorldStateCurrent(key: string): Promise<WorldStateRow | null> {
		const rows = await this.sql`
      SELECT key, value_json, surfacing_classification, updated_at,
             valid_time, committed_time
      FROM world_state_current
      WHERE key = ${key}
    `;
		if (rows.length === 0) return null;
		return this.mapWorldStateRow(rows[0]);
	}

	async getWorldStateAsOf(
		key: string,
		asOfCommittedTime: number,
	): Promise<WorldStateAsOfRow | null> {
		const rows = await this.sql`
      SELECT key, value_json, surfacing_classification, source_type,
             valid_time, committed_time
      FROM world_state_events
      WHERE key = ${key}
        AND committed_time <= ${asOfCommittedTime}
      ORDER BY committed_time DESC, id DESC
      LIMIT 1
    `;
		if (rows.length === 0) return null;
		return this.mapWorldStateAsOfRow(rows[0]);
	}

	async upsertWorldNarrativeCurrent(input: {
		summaryText: string;
		updatedAt?: number;
	}): Promise<void> {
		const updatedAt = input.updatedAt ?? Date.now();
		await this.sql`
      INSERT INTO world_narrative_current (id, summary_text, updated_at)
      VALUES (1, ${input.summaryText}, ${updatedAt})
      ON CONFLICT(id) DO UPDATE SET
        summary_text = excluded.summary_text,
        updated_at = excluded.updated_at
    `;
	}

	async getWorldNarrativeCurrent(): Promise<WorldNarrativeRow | null> {
		const rows = await this.sql`
      SELECT id, summary_text, updated_at
      FROM world_narrative_current
      WHERE id = 1
    `;
		if (rows.length === 0) return null;
		return {
			id: Number(rows[0].id),
			summary_text: rows[0].summary_text as string,
			updated_at: Number(rows[0].updated_at),
		};
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

		const valueJsonb = this.jsonb(params.valueJson);
		const eventRows = await this.sql`
      INSERT INTO scene_area_fact_events (
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
      ) VALUES (
        ${params.sessionId},
        ${params.areaId},
        ${params.factKey},
        ${valueJsonb},
        ${params.sourceKind},
        ${params.exposureScope},
        ${params.sourceSettlementId},
        ${params.sourceAgentId},
        ${params.validTime},
        ${params.committedTime}
      )
      RETURNING id
    `;

		if (eventRows.length === 0) {
			throw new Error("Failed to append scene_area_fact_events row");
		}

		const eventId = this.toBigInt((eventRows[0] as Record<string, unknown>).id);

		await this.sql`
      INSERT INTO scene_area_fact_current (
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
      ) VALUES (
        ${params.sessionId},
        ${params.areaId},
        ${params.factKey},
        ${Number(eventId)},
        ${valueJsonb},
        ${params.sourceKind},
        ${params.exposureScope},
        ${params.sourceSettlementId},
        ${params.sourceAgentId},
        NOW(),
        ${params.validTime},
        ${params.committedTime}
      )
      ON CONFLICT(session_id, area_id, fact_key) DO UPDATE SET
        source_event_id = excluded.source_event_id,
        value_json = excluded.value_json,
        source_kind = excluded.source_kind,
        exposure_scope = excluded.exposure_scope,
        source_settlement_id = excluded.source_settlement_id,
        source_agent_id = excluded.source_agent_id,
        updated_at = NOW(),
        valid_time = excluded.valid_time,
        committed_time = excluded.committed_time
      WHERE
        excluded.committed_time > scene_area_fact_current.committed_time
        OR (
          excluded.committed_time = scene_area_fact_current.committed_time
          AND excluded.source_event_id > scene_area_fact_current.source_event_id
        )
    `;

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

		const valueJsonb = this.jsonb(params.valueJson);
		const eventRows = await this.sql`
      INSERT INTO scene_world_fact_events (
        session_id,
        fact_key,
        value_json,
        source_kind,
        exposure_scope,
        source_settlement_id,
        source_agent_id,
        valid_time,
        committed_time
      ) VALUES (
        ${params.sessionId},
        ${params.factKey},
        ${valueJsonb},
        ${params.sourceKind},
        ${params.exposureScope},
        ${params.sourceSettlementId},
        ${params.sourceAgentId},
        ${params.validTime},
        ${params.committedTime}
      )
      RETURNING id
    `;

		if (eventRows.length === 0) {
			throw new Error("Failed to append scene_world_fact_events row");
		}

		const eventId = this.toBigInt((eventRows[0] as Record<string, unknown>).id);

		await this.sql`
      INSERT INTO scene_world_fact_current (
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
      ) VALUES (
        ${params.sessionId},
        ${params.factKey},
        ${Number(eventId)},
        ${valueJsonb},
        ${params.sourceKind},
        ${params.exposureScope},
        ${params.sourceSettlementId},
        ${params.sourceAgentId},
        NOW(),
        ${params.validTime},
        ${params.committedTime}
      )
      ON CONFLICT(session_id, fact_key) DO UPDATE SET
        source_event_id = excluded.source_event_id,
        value_json = excluded.value_json,
        source_kind = excluded.source_kind,
        exposure_scope = excluded.exposure_scope,
        source_settlement_id = excluded.source_settlement_id,
        source_agent_id = excluded.source_agent_id,
        updated_at = NOW(),
        valid_time = excluded.valid_time,
        committed_time = excluded.committed_time
      WHERE
        excluded.committed_time > scene_world_fact_current.committed_time
        OR (
          excluded.committed_time = scene_world_fact_current.committed_time
          AND excluded.source_event_id > scene_world_fact_current.source_event_id
        )
    `;

		return { eventId };
	}

	async getVisibleAreaFacts(params: {
		sessionId: string;
		areaId: number;
		excludeSystemOnly?: boolean;
	}): Promise<AreaFactCurrentRow[]> {
		const rows = params.excludeSystemOnly
			? await this.sql`
          SELECT
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
          WHERE session_id = ${params.sessionId}
            AND area_id = ${params.areaId}
            AND exposure_scope <> 'system_only'
          ORDER BY fact_key ASC
        `
			: await this.sql`
          SELECT
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
          WHERE session_id = ${params.sessionId}
            AND area_id = ${params.areaId}
          ORDER BY fact_key ASC
        `;

		return rows.map((row) =>
			this.mapAreaFactCurrentRow(row as Record<string, unknown>),
		);
	}

	async getVisibleWorldFacts(params: {
		sessionId: string;
		excludeSystemOnly?: boolean;
	}): Promise<WorldFactCurrentRow[]> {
		const rows = params.excludeSystemOnly
			? await this.sql`
          SELECT
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
          WHERE session_id = ${params.sessionId}
            AND exposure_scope <> 'system_only'
          ORDER BY fact_key ASC
        `
			: await this.sql`
          SELECT
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
          WHERE session_id = ${params.sessionId}
          ORDER BY fact_key ASC
        `;

		return rows.map((row) =>
			this.mapWorldFactCurrentRow(row as Record<string, unknown>),
		);
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
		this.assertTrigger(input.trigger, ["publication"]);
		const classification =
			input.surfacingClassification ?? "public_manifestation";

		if (input.targetScope === "world_public") {
			this.assertWorldClassification(classification);
			await this.upsertWorldStateCurrent({
				key: input.projectionKey,
				value: input.payload ?? { summary: input.summaryText },
				surfacingClassification: classification,
				updatedAt: input.updatedAt,
				settlementId: input.settlementId,
			});
			await this.upsertWorldNarrativeCurrent({
				summaryText: input.summaryText,
				updatedAt: input.updatedAt,
			});
			return;
		}

		await this.upsertAreaStateCurrent({
			agentId: input.agentId,
			areaId: input.areaId,
			key: input.projectionKey,
			value: input.payload ?? { summary: input.summaryText },
			surfacingClassification: classification,
			updatedAt: input.updatedAt,
			settlementId: input.settlementId,
		});
		if (classification === "public_manifestation") {
			await this.upsertAreaNarrativeCurrent({
				agentId: input.agentId,
				areaId: input.areaId,
				summaryText: input.summaryText,
				updatedAt: input.updatedAt,
			});
		}
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
		this.assertTrigger(input.trigger, ["materialization"]);
		const classification =
			input.surfacingClassification ?? "public_manifestation";
		await this.upsertAreaStateCurrent({
			agentId: input.agentId,
			areaId: input.areaId,
			key: input.projectionKey,
			value: input.payload ?? { summary: input.summaryText },
			surfacingClassification: classification,
			updatedAt: input.updatedAt,
			settlementId: input.settlementId,
		});
		if (classification === "public_manifestation") {
			await this.upsertAreaNarrativeCurrent({
				agentId: input.agentId,
				areaId: input.areaId,
				summaryText: input.summaryText,
				updatedAt: input.updatedAt,
			});
		}
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
		this.assertTrigger(input.trigger, ["promotion"]);
		const classification =
			input.surfacingClassification ?? "public_manifestation";
		this.assertWorldClassification(classification);
		await this.upsertWorldStateCurrent({
			key: input.projectionKey,
			value: input.payload ?? { summary: input.summaryText },
			surfacingClassification: classification,
			updatedAt: input.updatedAt,
			settlementId: input.settlementId,
		});
		await this.upsertWorldNarrativeCurrent({
			summaryText: input.summaryText,
			updatedAt: input.updatedAt,
		});
	}

	private jsonb(value: unknown) {
		// Scene-fact semantics require preserving JSON null (e.g. holder:<item>
		// = null meaning "no one holds it"). postgres.js's `sql.json(null)`
		// produces SQL NULL, which violates value_json NOT NULL and silently
		// drops the insert. Route through an explicit JSON-string → ::jsonb
		// cast using parameter binding (safe, no injection) so the JSON null
		// literal survives to the column.
		if (typeof value === "string") {
			try {
				return this.sql.json(JSON.parse(value) as Record<string, never>);
			} catch {
				return this.sql.json(value as never);
			}
		}
		if (value === null || value === undefined) {
			// Static literal — no user input, no injection risk. Needed because
			// postgres.js has no fragment-level API for emitting the bare JSON
			// null literal; `sql.json(null)` → SQL NULL, and parameterized
			// "null" strings cast to JSON "null" (string) rather than null.
			return this.sql.unsafe("'null'::jsonb");
		}
		return this.sql.json(value as Record<string, never>);
	}

	private resolveSettlementId(
		settlementId: string | undefined,
		committedTime: number,
	): string {
		if (settlementId && settlementId.trim().length > 0) return settlementId;
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
		if (!SCENE_FACT_SOURCE_KINDS.includes(value as SceneFactSourceKind)) {
			throw new Error(`Invalid scene fact source kind: ${value}`);
		}
		if (
			!PHASE_1_SCENE_FACT_SOURCE_KINDS.includes(
				value as (typeof PHASE_1_SCENE_FACT_SOURCE_KINDS)[number],
			)
		) {
			throw new Error(`Invalid scene fact source kind: ${value}`);
		}
	}

	private assertAreaFactExposureScope(value: string): void {
		if (AREA_FACT_EXPOSURE_SCOPES.includes(value as AreaFactExposureScope))
			return;
		throw new Error(`Invalid area fact exposure scope: ${value}`);
	}

	private assertWorldFactExposureScope(value: string): void {
		if (WORLD_FACT_EXPOSURE_SCOPES.includes(value as WorldFactExposureScope))
			return;
		throw new Error(`Invalid world fact exposure scope: ${value}`);
	}

	private assertSurfacingClassification(value: string): void {
		if (SURFACING_CLASSIFICATIONS.includes(value as SurfacingClassification))
			return;
		throw new Error(`Invalid surfacing classification: ${value}`);
	}

	private assertAreaStateSourceType(value: string): void {
		if (AREA_STATE_SOURCE_TYPES.includes(value as AreaStateSourceType)) return;
		throw new Error(`Invalid area state source type: ${value}`);
	}

	private assertWorldClassification(value: SurfacingClassification): void {
		if (value !== "public_manifestation") {
			throw new Error(
				`world projections only accept public_manifestation, got ${value}`,
			);
		}
	}

	private assertTrigger(
		trigger: ProjectionUpdateTrigger,
		allowed: ProjectionUpdateTrigger[],
	): void {
		if (!allowed.includes(trigger)) {
			throw new Error(
				`Projection update trigger '${trigger}' is not allowed in this path`,
			);
		}
	}

	private toBigInt(value: unknown): bigint {
		if (typeof value === "bigint") return value;
		if (typeof value === "number") return BigInt(value);
		if (typeof value === "string" && value.length > 0) return BigInt(value);
		throw new Error(`Unable to coerce value to bigint: ${String(value)}`);
	}

	private toDate(value: unknown): Date {
		if (value instanceof Date) return value;
		if (typeof value === "string" || typeof value === "number") {
			const parsed = new Date(value);
			if (!Number.isNaN(parsed.getTime())) return parsed;
		}
		throw new Error(`Unable to coerce value to Date: ${String(value)}`);
	}

	private parseJsonValue(value: unknown): unknown {
		if (typeof value === "string") {
			try {
				return JSON.parse(value) as unknown;
			} catch {
				return value;
			}
		}
		return value;
	}

	private mapAreaFactCurrentRow(
		row: Record<string, unknown>,
	): AreaFactCurrentRow {
		return {
			sessionId: row.session_id as string,
			areaId: Number(row.area_id),
			factKey: row.fact_key as string,
			valueJson: this.parseJsonValue(row.value_json),
			sourceKind: row.source_kind as SceneFactSourceKind,
			exposureScope: row.exposure_scope as AreaFactExposureScope,
			sourceEventId: this.toBigInt(row.source_event_id),
			sourceSettlementId:
				row.source_settlement_id == null
					? null
					: String(row.source_settlement_id),
			sourceAgentId:
				row.source_agent_id == null ? null : String(row.source_agent_id),
			updatedAt: this.toDate(row.updated_at),
			validTime: this.toDate(row.valid_time),
			committedTime: this.toDate(row.committed_time),
		};
	}

	private mapWorldFactCurrentRow(
		row: Record<string, unknown>,
	): WorldFactCurrentRow {
		return {
			sessionId: row.session_id as string,
			factKey: row.fact_key as string,
			valueJson: this.parseJsonValue(row.value_json),
			sourceKind: row.source_kind as SceneFactSourceKind,
			exposureScope: row.exposure_scope as WorldFactExposureScope,
			sourceEventId: this.toBigInt(row.source_event_id),
			sourceSettlementId:
				row.source_settlement_id == null
					? null
					: String(row.source_settlement_id),
			sourceAgentId:
				row.source_agent_id == null ? null : String(row.source_agent_id),
			updatedAt: this.toDate(row.updated_at),
			validTime: this.toDate(row.valid_time),
			committedTime: this.toDate(row.committed_time),
		};
	}

	private mapAreaStateRow(row: Record<string, unknown>): AreaStateRow {
		return {
			agent_id: row.agent_id as string,
			area_id: Number(row.area_id),
			key: row.key as string,
			value_json: stringifyJsonb(row.value_json),
			surfacing_classification:
				row.surfacing_classification as SurfacingClassification,
			source_type: row.source_type as AreaStateSourceType,
			updated_at: Number(row.updated_at),
			valid_time: row.valid_time != null ? Number(row.valid_time) : null,
			committed_time:
				row.committed_time != null ? Number(row.committed_time) : null,
		};
	}

	private mapAreaStateAsOfRow(row: Record<string, unknown>): AreaStateAsOfRow {
		return {
			key: row.key as string,
			value_json: stringifyJsonb(row.value_json),
			surfacing_classification:
				row.surfacing_classification as SurfacingClassification,
			source_type: row.source_type as AreaStateSourceType,
			valid_time: row.valid_time != null ? Number(row.valid_time) : null,
			committed_time:
				row.committed_time != null ? Number(row.committed_time) : null,
		};
	}

	private mapWorldStateRow(row: Record<string, unknown>): WorldStateRow {
		return {
			key: row.key as string,
			value_json: stringifyJsonb(row.value_json),
			surfacing_classification:
				row.surfacing_classification as SurfacingClassification,
			updated_at: Number(row.updated_at),
			valid_time: row.valid_time != null ? Number(row.valid_time) : null,
			committed_time:
				row.committed_time != null ? Number(row.committed_time) : null,
		};
	}

	private mapWorldStateAsOfRow(
		row: Record<string, unknown>,
	): WorldStateAsOfRow {
		return {
			key: row.key as string,
			value_json: stringifyJsonb(row.value_json),
			surfacing_classification:
				row.surfacing_classification as SurfacingClassification,
			source_type: row.source_type as AreaStateSourceType,
			valid_time: row.valid_time != null ? Number(row.valid_time) : null,
			committed_time:
				row.committed_time != null ? Number(row.committed_time) : null,
		};
	}
}
