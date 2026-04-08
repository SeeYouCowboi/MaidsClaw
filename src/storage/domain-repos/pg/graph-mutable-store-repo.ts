import type postgres from "postgres";
import { makeNodeRef } from "../../../memory/schema.js";
import type { NodeRef } from "../../../memory/types.js";
import type { CognitionKind } from "../../../runtime/rp-turn-contract.js";
import type { GraphMutableStoreRepo } from "../contracts/graph-mutable-store-repo.js";

const PG_MAX_BIGINT = "9223372036854775807";
const SAME_EPISODE_WINDOW_MS = 24 * 60 * 60 * 1000;

type CognitionPredicate = "explicit_assertion" | "explicit_evaluation" | "explicit_commitment";

export class PgGraphMutableStoreRepo implements GraphMutableStoreRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async createProjectedEvent(
    params: Parameters<GraphMutableStoreRepo["createProjectedEvent"]>[0],
  ): Promise<number> {
    const createdAt = Date.now();
    const visibilityScope = params.visibilityScope ?? "area_visible";
    const rows = await this.sql`
      INSERT INTO event_nodes (
        session_id,
        raw_text,
        summary,
        timestamp,
        created_at,
        participants,
        emotion,
        topic_id,
        visibility_scope,
        location_entity_id,
        event_category,
        primary_actor_entity_id,
        promotion_class,
        source_record_id,
        event_origin,
        source_settlement_id,
        source_pub_index
      ) VALUES (
        ${params.sessionId},
        ${null},
        ${params.summary},
        ${params.timestamp},
        ${createdAt},
        ${params.participants},
        ${params.emotion ?? null},
        ${params.topicId ?? null},
        ${visibilityScope},
        ${params.locationEntityId},
        ${params.eventCategory},
        ${params.primaryActorEntityId ?? null},
        'none',
        ${params.sourceRecordId ?? null},
        ${params.origin},
        ${params.sourceSettlementId ?? null},
        ${params.sourcePubIndex ?? null}
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  async createPromotedEvent(
    params: Parameters<GraphMutableStoreRepo["createPromotedEvent"]>[0],
  ): Promise<number> {
    const locationEntityId = await this.resolveLocationEntityId(
      params.locationEntityId,
      params.sourceEventId,
    );
    const createdAt = Date.now();
    const rows = await this.sql`
      INSERT INTO event_nodes (
        session_id,
        raw_text,
        summary,
        timestamp,
        created_at,
        participants,
        emotion,
        topic_id,
        visibility_scope,
        location_entity_id,
        event_category,
        primary_actor_entity_id,
        promotion_class,
        source_record_id,
        event_origin
      ) VALUES (
        ${params.sessionId},
        ${null},
        ${params.summary},
        ${params.timestamp},
        ${createdAt},
        ${params.participants},
        ${null},
        ${null},
        'world_public',
        ${locationEntityId},
        ${params.eventCategory},
        ${params.primaryActorEntityId ?? null},
        'world_candidate',
        ${null},
        'promotion'
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  async createLogicEdge(
    sourceEventId: number,
    targetEventId: number,
    relationType: Parameters<GraphMutableStoreRepo["createLogicEdge"]>[2],
  ): Promise<number> {
    const rows = await this.sql`
      INSERT INTO logic_edges (source_event_id, target_event_id, relation_type, created_at)
      VALUES (${sourceEventId}, ${targetEventId}, ${relationType}, ${Date.now()})
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  async createTopic(name: string, description?: string): Promise<number> {
    const inserted = await this.sql`
      INSERT INTO topics (name, description, created_at)
      VALUES (${name}, ${description ?? null}, ${Date.now()})
      ON CONFLICT (name) DO NOTHING
      RETURNING id
    `;
    if (inserted.length > 0) {
      return Number(inserted[0].id);
    }

    const rows = await this.sql`
      SELECT id FROM topics WHERE name = ${name} LIMIT 1
    `;
    if (rows.length === 0) {
      throw new Error(`Failed to create or load topic: ${name}`);
    }
    return Number(rows[0].id);
  }

  async upsertEntity(
    params: Parameters<GraphMutableStoreRepo["upsertEntity"]>[0],
  ): Promise<number> {
    const pointerKey = params.pointerKey.normalize("NFC");
    const displayName = params.displayName.normalize("NFC");
    const now = Date.now();
    const summaryProvided = params.summary !== undefined;

    if (params.memoryScope === "shared_public") {
      const rows = await this.sql`
        INSERT INTO entity_nodes (
          pointer_key,
          display_name,
          entity_type,
          memory_scope,
          owner_agent_id,
          canonical_entity_id,
          summary,
          created_at,
          updated_at
        ) VALUES (
          ${pointerKey},
          ${displayName},
          ${params.entityType},
          'shared_public',
          ${null},
          ${params.canonicalEntityId ?? null},
          ${params.summary ?? null},
          ${now},
          ${now}
        )
        ON CONFLICT (pointer_key)
        WHERE memory_scope = 'shared_public'
        DO UPDATE SET
          display_name = EXCLUDED.display_name,
          entity_type = EXCLUDED.entity_type,
          canonical_entity_id = EXCLUDED.canonical_entity_id,
          summary = CASE
            WHEN ${summaryProvided} THEN EXCLUDED.summary
            ELSE entity_nodes.summary
          END,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      `;
      return Number(rows[0].id);
    }

    if (!params.ownerAgentId) {
      throw new Error("ownerAgentId is required for private_overlay entity upsert");
    }

    const rows = await this.sql`
      INSERT INTO entity_nodes (
        pointer_key,
        display_name,
        entity_type,
        memory_scope,
        owner_agent_id,
        canonical_entity_id,
        summary,
        created_at,
        updated_at
      ) VALUES (
        ${pointerKey},
        ${displayName},
        ${params.entityType},
        'private_overlay',
        ${params.ownerAgentId},
        ${params.canonicalEntityId ?? null},
        ${params.summary ?? null},
        ${now},
        ${now}
      )
      ON CONFLICT (owner_agent_id, pointer_key)
      WHERE memory_scope = 'private_overlay'
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        entity_type = EXCLUDED.entity_type,
        canonical_entity_id = EXCLUDED.canonical_entity_id,
        summary = CASE
          WHEN ${summaryProvided} THEN EXCLUDED.summary
          ELSE entity_nodes.summary
        END,
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  async resolveEntityByPointerKey(pointerKey: string, agentId: string): Promise<number | null> {
    const normalizedPointerKey = pointerKey.normalize("NFC");
    const rows = await this.sql`
      SELECT id
      FROM entity_nodes
      WHERE pointer_key = ${normalizedPointerKey}
        AND (
          (memory_scope = 'private_overlay' AND owner_agent_id = ${agentId})
          OR memory_scope = 'shared_public'
        )
      ORDER BY CASE WHEN memory_scope = 'private_overlay' THEN 0 ELSE 1 END
      LIMIT 1
    `;

    if (rows.length === 0) {
      return null;
    }
    return Number(rows[0].id);
  }

  async getEntityById(id: number): Promise<{ pointerKey: string } | null> {
    const rows = await this.sql`
      SELECT pointer_key
      FROM entity_nodes
      WHERE id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return null;
    }
    return { pointerKey: rows[0].pointer_key as string };
  }

  async upsertExplicitAssertion(
    params: Parameters<GraphMutableStoreRepo["upsertExplicitAssertion"]>[0],
  ): Promise<{ id: number; ref: NodeRef }> {
    const holderEntityId = await this.resolveEntityByPointerKey(params.holderPointerKey, params.agentId);
    if (holderEntityId === null) {
      throw new Error(`Unresolved holder entity ref in explicit assertion: ${params.holderPointerKey}`);
    }
    const entityIds: number[] = [];
    const unresolvedEntities: string[] = [];
    for (const key of params.entityPointerKeys) {
      const id = await this.resolveEntityByPointerKey(key, params.agentId);
      if (id === null) {
        unresolvedEntities.push(key);
      } else {
        entityIds.push(id);
      }
    }
    if (unresolvedEntities.length > 0) {
      throw new Error(`Unresolved entity refs in explicit assertion: ${unresolvedEntities.join(", ")}`);
    }

    const now = Date.now();
    const cognitionKey = this.normalizeCognitionKey(
      "assertion",
      params.cognitionKey,
      params.settlementId,
      params.opIndex,
      now,
    );

    const eventId = await this.insertCognitionEvent({
      agentId: params.agentId,
      cognitionKey,
      kind: "assertion",
      op: "upsert",
      record: {
        holderPointerKey: params.holderPointerKey,
        claim: params.claim,
        entityPointerKeys: params.entityPointerKeys,
        stance: params.stance,
        basis: params.basis ?? null,
        preContestedStance: params.preContestedStance ?? null,
        provenance: params.provenance ?? null,
        settlementId: params.settlementId,
        opIndex: params.opIndex,
      },
      settlementId: params.settlementId,
      committedTime: now,
    });

    await this.expireActiveCognitionFacts(params.agentId, cognitionKey, "assertion", now);

    const targetEntityId = entityIds[0] ?? holderEntityId;
    const id = await this.insertCognitionFact(
      holderEntityId,
      targetEntityId,
      "explicit_assertion",
      eventId,
      now,
    );
    return { id, ref: makeNodeRef("assertion", id) };
  }

  async upsertExplicitEvaluation(
    params: Parameters<GraphMutableStoreRepo["upsertExplicitEvaluation"]>[0],
  ): Promise<{ id: number; ref: NodeRef }> {
    const now = Date.now();
    const cognitionKey = this.normalizeCognitionKey(
      "evaluation",
      params.cognitionKey,
      params.settlementId,
      params.opIndex,
      now,
    );
    const sourceEntityId = await this.ensureSyntheticAgentEntity(params.agentId);
    const targetEntityId = params.targetEntityId ?? sourceEntityId;

    const eventId = await this.insertCognitionEvent({
      agentId: params.agentId,
      cognitionKey,
      kind: "evaluation",
      op: "upsert",
      record: {
        targetEntityId: params.targetEntityId ?? null,
        salience: params.salience ?? null,
        dimensions: params.dimensions,
        emotionTags: params.emotionTags ?? [],
        notes: params.notes ?? null,
        settlementId: params.settlementId,
        opIndex: params.opIndex,
      },
      settlementId: params.settlementId,
      committedTime: now,
    });

    await this.expireActiveCognitionFacts(params.agentId, cognitionKey, "evaluation", now);

    const id = await this.insertCognitionFact(
      sourceEntityId,
      targetEntityId,
      "explicit_evaluation",
      eventId,
      now,
    );
    return { id, ref: makeNodeRef("evaluation", id) };
  }

  async upsertExplicitCommitment(
    params: Parameters<GraphMutableStoreRepo["upsertExplicitCommitment"]>[0],
  ): Promise<{ id: number; ref: NodeRef }> {
    const now = Date.now();
    const cognitionKey = this.normalizeCognitionKey(
      "commitment",
      params.cognitionKey,
      params.settlementId,
      params.opIndex,
      now,
    );
    const sourceEntityId = await this.ensureSyntheticAgentEntity(params.agentId);
    const targetEntityId = params.targetEntityId ?? sourceEntityId;

    const eventId = await this.insertCognitionEvent({
      agentId: params.agentId,
      cognitionKey,
      kind: "commitment",
      op: "upsert",
      record: {
        targetEntityId: params.targetEntityId ?? null,
        salience: params.salience ?? null,
        mode: params.mode,
        target: params.target,
        status: params.status,
        priority: params.priority ?? null,
        horizon: params.horizon ?? null,
        settlementId: params.settlementId,
        opIndex: params.opIndex,
      },
      settlementId: params.settlementId,
      committedTime: now,
    });

    await this.expireActiveCognitionFacts(params.agentId, cognitionKey, "commitment", now);

    const id = await this.insertCognitionFact(
      sourceEntityId,
      targetEntityId,
      "explicit_commitment",
      eventId,
      now,
    );
    return { id, ref: makeNodeRef("commitment", id) };
  }

  async retractExplicitCognition(
    agentId: string,
    cognitionKey: string,
    kind: Extract<CognitionKind, "assertion" | "evaluation" | "commitment">,
    settlementId?: string,
  ): Promise<void> {
    const now = Date.now();
    const normalizedKey = cognitionKey.normalize("NFC");
    const effectiveSettlementId = settlementId ?? "__retract__";

    await this.insertCognitionEvent({
      agentId,
      cognitionKey: normalizedKey,
      kind,
      op: "retract",
      record: null,
      settlementId: effectiveSettlementId,
      committedTime: now,
    });

    await this.expireActiveCognitionFacts(agentId, normalizedKey, kind, now, settlementId);
  }

  async createEntityAlias(
    canonicalId: number,
    alias: string,
    aliasType?: string,
    ownerAgentId?: string,
  ): Promise<number> {
    const aliasTypeVal = aliasType ?? null;
    const ownerVal = ownerAgentId ?? null;

    const existing = await this.sql`
      SELECT id
      FROM entity_aliases
      WHERE canonical_id = ${canonicalId}
        AND alias = ${alias}
        AND alias_type IS NOT DISTINCT FROM ${aliasTypeVal}::text
        AND owner_agent_id IS NOT DISTINCT FROM ${ownerVal}::text
      LIMIT 1
    `;
    if (existing.length > 0) {
      return Number(existing[0].id);
    }

    const inserted = await this.sql`
      INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
      VALUES (${canonicalId}, ${alias}, ${aliasTypeVal}::text, ${ownerVal}::text)
      RETURNING id
    `;
    return Number(inserted[0].id);
  }

  async createRedirect(
    oldName: string,
    newName: string,
    redirectType?: string,
    ownerAgentId?: string,
  ): Promise<number> {
    const rows = await this.sql`
      INSERT INTO pointer_redirects (old_name, new_name, redirect_type, owner_agent_id, created_at)
      VALUES (${oldName}, ${newName}, ${redirectType ?? null}, ${ownerAgentId ?? null}, ${Date.now()})
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  async createFact(
    sourceEntityId: number,
    targetEntityId: number,
    predicate: string,
    sourceEventId?: number,
  ): Promise<number> {
    const existing = await this.sql`
      SELECT id
      FROM fact_edges
      WHERE source_entity_id = ${sourceEntityId}
        AND predicate = ${predicate}
        AND target_entity_id = ${targetEntityId}
        AND t_invalid = ${PG_MAX_BIGINT}
      LIMIT 1
    `;

    if (existing.length > 0) {
      await this.invalidateFact(Number(existing[0].id));
    }

    const now = Date.now();
    const rows = await this.sql`
      INSERT INTO fact_edges (
        source_entity_id,
        target_entity_id,
        predicate,
        t_valid,
        t_invalid,
        t_created,
        t_expired,
        source_event_id
      ) VALUES (
        ${sourceEntityId},
        ${targetEntityId},
        ${predicate},
        ${now},
        ${PG_MAX_BIGINT},
        ${now},
        ${PG_MAX_BIGINT},
        ${sourceEventId ?? null}
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  async invalidateFact(factId: number): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE fact_edges
      SET t_invalid = ${now}, t_expired = ${now}
      WHERE id = ${factId}
    `;
  }

  async createPrivateEvent(
    params: Parameters<GraphMutableStoreRepo["createPrivateEvent"]>[0],
  ): Promise<number> {
    const now = Date.now();
    const settlementId = params.sourceRecordId ?? `legacy:${params.agentId}:${now}`;

    if (params.eventCategory === "thought") {
      const cognitionKey = `legacy_thought:${params.agentId}:${now}`;
      return this.insertCognitionEvent({
        agentId: params.agentId,
        cognitionKey,
        kind: "evaluation",
        op: "upsert",
        record: {
          role: params.role ?? null,
          privateNotes: params.privateNotes ?? null,
          salience: params.salience ?? null,
          emotion: params.emotion ?? null,
          sourceEventId: params.eventId ?? null,
          primaryActorEntityId: params.primaryActorEntityId ?? null,
          projectionClass: params.projectionClass,
          locationEntityId: params.locationEntityId ?? null,
          summary: params.projectableSummary ?? null,
          sourceRecordId: params.sourceRecordId ?? null,
          category: params.eventCategory,
        },
        settlementId,
        committedTime: now,
      });
    }

    const sessionId = await this.resolvePrivateSessionId(params.eventId, params.agentId);
    const rows = await this.sql`
      INSERT INTO private_episode_events (
        agent_id,
        session_id,
        settlement_id,
        category,
        summary,
        private_notes,
        location_entity_id,
        location_text,
        valid_time,
        committed_time,
        source_local_ref,
        created_at
      ) VALUES (
        ${params.agentId},
        ${sessionId},
        ${settlementId},
        ${params.eventCategory},
        ${params.projectableSummary ?? ""},
        ${params.privateNotes ?? null},
        ${params.locationEntityId ?? null},
        ${null},
        ${params.eventId ?? null},
        ${now},
        ${params.sourceRecordId ?? null},
        ${now}
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  async createPrivateBelief(
    params: Parameters<GraphMutableStoreRepo["createPrivateBelief"]>[0],
  ): Promise<number> {
    const source = await this.getEntityById(params.sourceEntityId);
    const target = await this.getEntityById(params.targetEntityId);
    if (!source || !target) {
      throw new Error(
        `Unable to resolve source/target entity pointer keys for private belief: ${params.sourceEntityId} -> ${params.targetEntityId}`,
      );
    }

    const result = await this.upsertExplicitAssertion({
      agentId: params.agentId,
      cognitionKey: `assert:${params.agentId}:${source.pointerKey}:${params.predicate}:${target.pointerKey}`,
      settlementId: `storage:upsert_assertion:${params.agentId}`,
      opIndex: 0,
      holderPointerKey: source.pointerKey,
      claim: params.predicate,
      entityPointerKeys: [source.pointerKey, target.pointerKey],
      stance: params.stance,
      basis: params.basis,
      provenance: params.provenance,
    });

    return result.id;
  }

  async updatePrivateEventLink(_privateEventId: number, _publicEventId: number): Promise<void> {
  }

  async createSameEpisodeEdges(
    events: Parameters<GraphMutableStoreRepo["createSameEpisodeEdges"]>[0],
  ): Promise<void> {
    if (events.length < 2) {
      return;
    }

    const sorted = [...events].sort((a, b) => {
      if (a.session_id !== b.session_id) {
        return a.session_id.localeCompare(b.session_id);
      }
      const topicA = a.topic_id ?? -1;
      const topicB = b.topic_id ?? -1;
      if (topicA !== topicB) {
        return topicA - topicB;
      }
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.id - b.id;
    });

    const rowsToInsert: Array<{
      source_event_id: number;
      target_event_id: number;
      relation_type: "same_episode";
      created_at: number;
    }> = [];

    for (let index = 0; index < sorted.length - 1; index += 1) {
      const current = sorted[index];
      const next = sorted[index + 1];
      if (current.session_id !== next.session_id) {
        continue;
      }
      if (current.topic_id !== next.topic_id) {
        continue;
      }
      if (next.timestamp - current.timestamp > SAME_EPISODE_WINDOW_MS) {
        continue;
      }

      const createdAt = Date.now();
      rowsToInsert.push({
        source_event_id: current.id,
        target_event_id: next.id,
        relation_type: "same_episode",
        created_at: createdAt,
      });
      rowsToInsert.push({
        source_event_id: next.id,
        target_event_id: current.id,
        relation_type: "same_episode",
        created_at: createdAt,
      });
    }

    if (rowsToInsert.length === 0) {
      return;
    }

    await this.sql`
      INSERT INTO logic_edges ${this.sql(rowsToInsert, "source_event_id", "target_event_id", "relation_type", "created_at")}
    `;
  }

  async runBatch(fn: () => void): Promise<void> {
    fn();
    return Promise.resolve();
  }

  private async resolveLocationEntityId(
    locationEntityId?: number,
    sourceEventId?: number,
  ): Promise<number> {
    if (locationEntityId !== undefined) {
      return locationEntityId;
    }
    if (sourceEventId === undefined) {
      throw new Error("locationEntityId is required when sourceEventId is not provided");
    }

    const rows = await this.sql`
      SELECT location_entity_id
      FROM event_nodes
      WHERE id = ${sourceEventId}
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new Error(`Source event not found: ${sourceEventId}`);
    }
    return Number(rows[0].location_entity_id);
  }

  private normalizeCognitionKey(
    kind: Extract<CognitionKind, "assertion" | "evaluation" | "commitment">,
    cognitionKey: string | undefined,
    settlementId: string,
    opIndex: number,
    now: number,
  ): string {
    const normalized = cognitionKey?.normalize("NFC");
    if (normalized && normalized.length > 0) {
      return normalized;
    }
    return `__anon_${kind}__${settlementId}:${opIndex}:${now}`;
  }

  private cognitionPredicate(kind: Extract<CognitionKind, "assertion" | "evaluation" | "commitment">): CognitionPredicate {
    if (kind === "assertion") return "explicit_assertion";
    if (kind === "evaluation") return "explicit_evaluation";
    return "explicit_commitment";
  }

  private async insertCognitionEvent(params: {
    agentId: string;
    cognitionKey: string;
    kind: Extract<CognitionKind, "assertion" | "evaluation" | "commitment">;
    op: "upsert" | "retract";
    record: unknown;
    settlementId: string;
    committedTime: number;
  }): Promise<number> {
    const rows = await this.sql`
      INSERT INTO private_cognition_events (
        agent_id,
        cognition_key,
        kind,
        op,
        record_json,
        settlement_id,
        committed_time,
        created_at
      ) VALUES (
        ${params.agentId},
        ${params.cognitionKey},
        ${params.kind},
        ${params.op},
        ${params.record == null ? null : this.sql.json(params.record as never)},
        ${params.settlementId},
        ${params.committedTime},
        ${params.committedTime}
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  private async expireActiveCognitionFacts(
    agentId: string,
    cognitionKey: string,
    kind: Extract<CognitionKind, "assertion" | "evaluation" | "commitment">,
    now: number,
    settlementId?: string,
  ): Promise<void> {
    const predicate = this.cognitionPredicate(kind);

    if (settlementId) {
      await this.sql`
        UPDATE fact_edges
        SET t_invalid = ${now}, t_expired = ${now}
        WHERE id IN (
          SELECT fe.id
          FROM fact_edges fe
          JOIN private_cognition_events pce ON pce.id = fe.source_event_id
          WHERE pce.agent_id = ${agentId}
            AND pce.cognition_key = ${cognitionKey}
            AND pce.kind = ${kind}
            AND pce.settlement_id = ${settlementId}
            AND fe.predicate = ${predicate}
            AND fe.t_invalid = ${PG_MAX_BIGINT}
        )
      `;
      return;
    }

    await this.sql`
      UPDATE fact_edges
      SET t_invalid = ${now}, t_expired = ${now}
      WHERE id IN (
        SELECT fe.id
        FROM fact_edges fe
        JOIN private_cognition_events pce ON pce.id = fe.source_event_id
        WHERE pce.agent_id = ${agentId}
          AND pce.cognition_key = ${cognitionKey}
          AND pce.kind = ${kind}
          AND fe.predicate = ${predicate}
          AND fe.t_invalid = ${PG_MAX_BIGINT}
      )
    `;
  }

  private async insertCognitionFact(
    sourceEntityId: number,
    targetEntityId: number,
    predicate: CognitionPredicate,
    sourceEventId: number,
    now: number,
  ): Promise<number> {
    const rows = await this.sql`
      INSERT INTO fact_edges (
        source_entity_id,
        target_entity_id,
        predicate,
        t_valid,
        t_invalid,
        t_created,
        t_expired,
        source_event_id
      ) VALUES (
        ${sourceEntityId},
        ${targetEntityId},
        ${predicate},
        ${now},
        ${PG_MAX_BIGINT},
        ${now},
        ${PG_MAX_BIGINT},
        ${sourceEventId}
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  private async ensureSyntheticAgentEntity(agentId: string): Promise<number> {
    return this.upsertEntity({
      pointerKey: `__agent__:${agentId}`,
      displayName: agentId,
      entityType: "agent",
      memoryScope: "private_overlay",
      ownerAgentId: agentId,
    });
  }

  private async resolvePrivateSessionId(eventId: number | undefined, agentId: string): Promise<string> {
    if (eventId === undefined) {
      return `agent:${agentId}`;
    }
    const rows = await this.sql`
      SELECT session_id
      FROM event_nodes
      WHERE id = ${eventId}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return `agent:${agentId}`;
    }
    return rows[0].session_id as string;
  }
}
