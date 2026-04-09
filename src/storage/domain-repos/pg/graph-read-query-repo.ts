import type postgres from "postgres";
import { parseGraphNodeRef } from "../../../memory/contracts/graph-node-ref.js";
import {
  RELATION_CONTRACTS as CANONICAL_RELATION_CONTRACTS,
  KNOWN_NODE_KINDS,
  type RelationContract as CanonicalRelationContract,
} from "../../../memory/contracts/relation-contract.js";
import { isEdgeInTimeSlice, type TimeSliceQuery } from "../../../memory/time-slice-query.js";
import {
  MEMORY_RELATION_TYPES,
  type EdgeLayer,
  type MemoryRelationType,
  type NodeRef,
  type NodeRefKind,
  type ViewerContext,
} from "../../../memory/types.js";
import { VisibilityPolicy } from "../../../memory/visibility-policy.js";
import type {
  AssertionTraversalRecord,
  EventParticipantContext,
  FactTraversalRecord,
  GraphNodeSnapshot,
  GraphNodeVisibilityRecord,
  GraphReadEdgeFamily,
  GraphReadEdgeRecord,
  GraphReadQueryRepo,
  NodeSalienceRecord,
} from "../contracts/graph-read-query-repo.js";

type EndpointFamily = NodeRefKind | "unknown";

type PgRelationContract = {
  sourceFamily: EndpointFamily;
  targetFamily: EndpointFamily;
  truthBearing: boolean;
  heuristicOnly: boolean;
};

function toPgContract(c: CanonicalRelationContract): PgRelationContract {
  return {
    sourceFamily: c.source_family,
    targetFamily: c.target_family,
    truthBearing: c.truth_bearing,
    heuristicOnly: c.heuristic_only,
  };
}

const RELATION_CONTRACTS: Record<string, PgRelationContract> = Object.fromEntries(
  Object.entries(CANONICAL_RELATION_CONTRACTS).map(([k, v]) => [k, toPgContract(v)]),
);

const PG_MAX_BIGINT = "9223372036854775807";

const MEMORY_RELATION_TYPE_SET = new Set<string>(MEMORY_RELATION_TYPES);

type ParsedAssertionRecord = {
  sourcePointerKey: string | null;
  targetPointerKey: string | null;
  predicate: string | null;
  sourceEventRef: NodeRef | null;
  sourceEntityId: number | null;
  targetEntityId: number | null;
};

export class PgGraphReadQueryRepo implements GraphReadQueryRepo {
  private readonly visibility = new VisibilityPolicy();

  constructor(private readonly sql: postgres.Sql) {}

  async getEntitiesForContext(agentId: string, limit = 200): Promise<Array<{
    id: number;
    pointer_key: string;
    display_name: string;
    entity_type: string;
    memory_scope: "shared_public" | "private_overlay";
    owner_agent_id: string | null;
  }>> {
    const rows = await this.sql<{
      id: number | string;
      pointer_key: string;
      display_name: string;
      entity_type: string;
      memory_scope: "shared_public" | "private_overlay";
      owner_agent_id: string | null;
    }[]>`
      SELECT id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id
      FROM entity_nodes
      WHERE memory_scope = 'shared_public' OR owner_agent_id = ${agentId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      id: Number(row.id),
      pointer_key: row.pointer_key,
      display_name: row.display_name,
      entity_type: row.entity_type,
      memory_scope: row.memory_scope,
      owner_agent_id: row.owner_agent_id,
    }));
  }

  async getEventsByIds(ids: number[]): Promise<Array<{
    id: number;
    session_id: string;
    topic_id: number | null;
    timestamp: number;
  }>> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.sql<{
      id: number | string;
      session_id: string;
      topic_id: number | string | null;
      timestamp: number | string;
    }[]>`
      SELECT id, session_id, topic_id, timestamp
      FROM event_nodes
      WHERE id IN ${this.sql(ids)}
    `;

    return rows.map((row) => ({
      id: Number(row.id),
      session_id: row.session_id,
      topic_id: row.topic_id == null ? null : Number(row.topic_id),
      timestamp: Number(row.timestamp),
    }));
  }

  async getNodeSalience(nodeRefs: readonly NodeRef[]): Promise<NodeSalienceRecord[]> {
    const unique = Array.from(new Set(nodeRefs));
    if (unique.length === 0) {
      return [];
    }

    const rows = await this.sql<{
      node_ref: string;
      salience: number | string;
    }[]>`
      SELECT node_ref, salience
      FROM node_scores
      WHERE node_ref IN ${this.sql(unique)}
    `;

    return rows.map((row) => ({
      nodeRef: row.node_ref as NodeRef,
      salience: this.clamp01(Number(row.salience)),
    }));
  }

  async readLogicEdges(
    frontierEventRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
    timeSlice?: TimeSliceQuery,
  ): Promise<GraphReadEdgeRecord[]> {
    const frontier = new Set(frontierEventRefs);
    const ids = this.extractIdsFromRefs(frontier, "event");
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.sql<{
      source_event_id: number | string;
      target_event_id: number | string;
      relation_type: string;
      created_at: number | string;
    }[]>`
      SELECT source_event_id, target_event_id, relation_type, created_at
      FROM logic_edges
      WHERE source_event_id IN ${this.sql(ids)}
         OR target_event_id IN ${this.sql(ids)}
    `;

    const candidates: GraphReadEdgeRecord[] = [];
    for (const row of rows) {
      const sourceId = Number(row.source_event_id);
      const targetId = Number(row.target_event_id);
      const createdAt = Number(row.created_at);
      const sourceRef = `event:${sourceId}` as NodeRef;
      const targetRef = `event:${targetId}` as NodeRef;

      if (frontier.has(sourceRef)) {
        candidates.push(this.toGraphEdge("logic_edges", "symbolic", row.relation_type, sourceRef, targetRef, {
          weight: 1,
          timestamp: createdAt,
          validTime: createdAt,
          committedTime: createdAt,
        }));
      }
      if (frontier.has(targetRef)) {
        candidates.push(
          this.toGraphEdge("logic_edges", "symbolic", this.reverseTemporalRelation(row.relation_type), targetRef, sourceRef, {
            weight: 1,
            timestamp: createdAt,
            validTime: createdAt,
            committedTime: createdAt,
          }),
        );
      }
    }

    return this.filterVisibleAndTimeSlicedEdges(candidates, viewerContext, timeSlice);
  }

  async readMemoryRelationEdges(
    frontierNodeRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
    timeSlice?: TimeSliceQuery,
  ): Promise<GraphReadEdgeRecord[]> {
    const refs = Array.from(new Set(frontierNodeRefs));
    if (refs.length === 0) {
      return [];
    }
    const frontier = new Set(refs);

    const rows = await this.sql<{
      source_node_ref: string;
      target_node_ref: string;
      relation_type: string;
      strength: number | string;
      source_kind: string;
      source_ref: string;
      created_at: number | string;
      updated_at: number | string;
    }[]>`
      SELECT source_node_ref, target_node_ref, relation_type, strength, source_kind, source_ref, created_at, updated_at
      FROM memory_relations
      WHERE source_node_ref IN ${this.sql(refs)}
         OR target_node_ref IN ${this.sql(refs)}
    `;

    const candidates: GraphReadEdgeRecord[] = [];
    for (const row of rows) {
      const sourceRef = row.source_node_ref as NodeRef;
      const targetRef = row.target_node_ref as NodeRef;
      const strength = Number(row.strength);
      const createdAt = Number(row.created_at);
      const updatedAt = Number(row.updated_at);
      const committedTime = updatedAt > 0 ? updatedAt : createdAt;

      if (frontier.has(sourceRef)) {
        candidates.push(this.toGraphEdge("memory_relations", "symbolic", row.relation_type, sourceRef, targetRef, {
          weight: strength,
          strength,
          sourceKind: row.source_kind,
          provenanceRef: row.source_ref,
          timestamp: createdAt,
          validTime: createdAt,
          committedTime,
        }));
      }

      if (frontier.has(targetRef)) {
        candidates.push(this.toGraphEdge("memory_relations", "symbolic", row.relation_type, targetRef, sourceRef, {
          weight: strength,
          strength,
          sourceKind: row.source_kind,
          provenanceRef: row.source_ref,
          timestamp: createdAt,
          validTime: createdAt,
          committedTime,
        }));
      }
    }

    return this.filterVisibleAndTimeSlicedEdges(candidates, viewerContext, timeSlice);
  }

  async readSemanticEdges(
    frontierNodeRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
    timeSlice?: TimeSliceQuery,
  ): Promise<GraphReadEdgeRecord[]> {
    const refs = Array.from(new Set(frontierNodeRefs));
    if (refs.length === 0) {
      return [];
    }
    const frontier = new Set(refs);

    const rows = await this.sql<{
      source: string;
      target: string;
      relation_type: string;
      weight: number | string;
      created_at: number | string;
    }[]>`
      SELECT source, target, relation_type, weight, created_at
      FROM semantic_edges
      WHERE source IN ${this.sql(refs)}
         OR target IN ${this.sql(refs)}
    `;

    const candidates: GraphReadEdgeRecord[] = [];
    for (const row of rows) {
      const sourceRef = row.source as NodeRef;
      const targetRef = row.target as NodeRef;
      const weight = Number(row.weight);
      const createdAt = Number(row.created_at);

      if (frontier.has(sourceRef)) {
        candidates.push(this.toGraphEdge("semantic_edges", "heuristic", row.relation_type, sourceRef, targetRef, {
          weight,
          timestamp: createdAt,
          validTime: createdAt,
          committedTime: createdAt,
        }));
      }
      if (frontier.has(targetRef)) {
        candidates.push(this.toGraphEdge("semantic_edges", "heuristic", row.relation_type, targetRef, sourceRef, {
          weight,
          timestamp: createdAt,
          validTime: createdAt,
          committedTime: createdAt,
        }));
      }
    }

    return this.filterVisibleAndTimeSlicedEdges(candidates, viewerContext, timeSlice);
  }

  async readStateFactEdges(
    frontierEventRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
    timeSlice?: TimeSliceQuery,
  ): Promise<GraphReadEdgeRecord[]> {
    const ids = this.extractIdsFromRefs(new Set(frontierEventRefs), "event");
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.sql<{
      id: number | string;
      source_event_id: number | string;
      t_valid: number | string;
      t_created: number | string;
    }[]>`
      SELECT id, source_event_id, t_valid, t_created
      FROM fact_edges
      WHERE t_invalid = ${PG_MAX_BIGINT}
        AND source_event_id IN ${this.sql(ids)}
    `;

    const candidates = rows.map((row) => {
      const edge = this.toGraphEdge(
        "memory_relations",
        "state",
        "fact_support",
        `event:${Number(row.source_event_id)}` as NodeRef,
        `fact:${Number(row.id)}` as NodeRef,
        {
          weight: 0.95,
          timestamp: Number(row.t_valid),
          validTime: Number(row.t_valid),
          committedTime: Number(row.t_created),
        },
      );
      edge.endpointContract.sourceFamily = "event";
      edge.endpointContract.targetFamily = "fact";
      return edge;
    });

    return this.filterVisibleAndTimeSlicedEdges(candidates, viewerContext, timeSlice);
  }

  async readEventParticipantContexts(
    frontierEventRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
  ): Promise<EventParticipantContext[]> {
    const ids = this.extractIdsFromRefs(new Set(frontierEventRefs), "event");
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.sql<{
      id: number | string;
      participants: string | null;
      primary_actor_entity_id: number | string | null;
      timestamp: number | string;
      summary: string | null;
    }[]>`
      SELECT id, participants, primary_actor_entity_id, timestamp, summary
      FROM event_nodes
      WHERE id IN ${this.sql(ids)}
        AND (
          visibility_scope = 'world_public'
          OR (
            visibility_scope = 'area_visible'
            AND ${viewerContext.current_area_id == null ? false : true}
            AND location_entity_id = ${viewerContext.current_area_id ?? -1}
          )
        )
    `;

    return rows.map((row) => {
      const participantEntityRefs = new Set<NodeRef>();
      for (const participantRef of this.parseParticipantEntityRefs(row.participants)) {
        participantEntityRefs.add(participantRef);
      }
      const primaryActor = row.primary_actor_entity_id != null
        ? (`entity:${Number(row.primary_actor_entity_id)}` as NodeRef)
        : null;
      if (primaryActor) {
        participantEntityRefs.add(primaryActor);
      }

      return {
        eventRef: `event:${Number(row.id)}` as NodeRef,
        summary: row.summary,
        timestamp: Number(row.timestamp),
        participantEntityRefs: Array.from(participantEntityRefs),
        primaryActorEntityRef: primaryActor,
      } satisfies EventParticipantContext;
    });
  }

  async readActiveFactsForEntityFrontier(entityRefs: readonly NodeRef[]): Promise<FactTraversalRecord[]> {
    const refs = Array.from(new Set(entityRefs));
    if (refs.length === 0) {
      return [];
    }

    const entityIds = this.extractIdsFromRefs(new Set(refs), "entity");
    const factIds = this.extractIdsFromRefs(new Set(refs), "fact");

    const rowsById = new Map<number, {
      id: number;
      source_entity_id: number;
      target_entity_id: number;
      predicate: string;
      t_valid: number;
      source_event_id: number | null;
    }>();

    if (entityIds.length > 0) {
      const rows = await this.sql<{
        id: number | string;
        source_entity_id: number | string;
        target_entity_id: number | string;
        predicate: string;
        t_valid: number | string;
        source_event_id: number | string | null;
      }[]>`
        SELECT id, source_entity_id, target_entity_id, predicate, t_valid, source_event_id
        FROM fact_edges
        WHERE t_invalid = ${PG_MAX_BIGINT}
          AND (
            source_entity_id IN ${this.sql(entityIds)}
            OR target_entity_id IN ${this.sql(entityIds)}
          )
      `;
      for (const row of rows) {
        rowsById.set(Number(row.id), {
          id: Number(row.id),
          source_entity_id: Number(row.source_entity_id),
          target_entity_id: Number(row.target_entity_id),
          predicate: row.predicate,
          t_valid: Number(row.t_valid),
          source_event_id: row.source_event_id == null ? null : Number(row.source_event_id),
        });
      }
    }

    if (factIds.length > 0) {
      const rows = await this.sql<{
        id: number | string;
        source_entity_id: number | string;
        target_entity_id: number | string;
        predicate: string;
        t_valid: number | string;
        source_event_id: number | string | null;
      }[]>`
        SELECT id, source_entity_id, target_entity_id, predicate, t_valid, source_event_id
        FROM fact_edges
        WHERE t_invalid = ${PG_MAX_BIGINT}
          AND id IN ${this.sql(factIds)}
      `;
      for (const row of rows) {
        rowsById.set(Number(row.id), {
          id: Number(row.id),
          source_entity_id: Number(row.source_entity_id),
          target_entity_id: Number(row.target_entity_id),
          predicate: row.predicate,
          t_valid: Number(row.t_valid),
          source_event_id: row.source_event_id == null ? null : Number(row.source_event_id),
        });
      }
    }

    return Array.from(rowsById.values()).map((row) => ({
      factRef: `fact:${row.id}` as NodeRef,
      sourceEntityRef: `entity:${row.source_entity_id}` as NodeRef,
      targetEntityRef: `entity:${row.target_entity_id}` as NodeRef,
      predicate: row.predicate,
      validTime: row.t_valid,
      sourceEventRef: row.source_event_id != null ? (`event:${row.source_event_id}` as NodeRef) : null,
    }));
  }

  async readVisibleEventsForEntityFrontier(
    entityRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
  ): Promise<EventParticipantContext[]> {
    const ids = this.extractIdsFromRefs(new Set(entityRefs), "entity");
    if (ids.length === 0) {
      return [];
    }

    const participantRegex = `\\"entity:(${ids.join("|")})\\"`;
    const rows = await this.sql<{
      id: number | string;
      participants: string | null;
      primary_actor_entity_id: number | string | null;
      timestamp: number | string;
      summary: string | null;
    }[]>`
      SELECT id, participants, primary_actor_entity_id, timestamp, summary
      FROM event_nodes
      WHERE (
        primary_actor_entity_id IN ${this.sql(ids)}
        OR (participants IS NOT NULL AND participants ~ ${participantRegex})
      )
      AND (
        visibility_scope = 'world_public'
        OR (
          visibility_scope = 'area_visible'
          AND ${viewerContext.current_area_id == null ? false : true}
          AND location_entity_id = ${viewerContext.current_area_id ?? -1}
        )
      )
    `;

    return rows.map((row) => {
      const participantEntityRefs = new Set<NodeRef>();
      for (const participantRef of this.parseParticipantEntityRefs(row.participants)) {
        participantEntityRefs.add(participantRef);
      }
      const primaryActor = row.primary_actor_entity_id != null
        ? (`entity:${Number(row.primary_actor_entity_id)}` as NodeRef)
        : null;
      if (primaryActor) {
        participantEntityRefs.add(primaryActor);
      }

      return {
        eventRef: `event:${Number(row.id)}` as NodeRef,
        summary: row.summary,
        timestamp: Number(row.timestamp),
        participantEntityRefs: Array.from(participantEntityRefs),
        primaryActorEntityRef: primaryActor,
      } satisfies EventParticipantContext;
    });
  }

  async readAgentAssertionsLinkedToEntities(
    agentId: string,
    entityRefs: readonly NodeRef[],
  ): Promise<AssertionTraversalRecord[]> {
    const entityIds = new Set(this.extractIdsFromRefs(new Set(entityRefs), "entity"));
    if (entityIds.size === 0) {
      return [];
    }

    const rows = await this.sql<{
      id: number | string;
      summary_text: string | null;
      record_json: unknown;
      updated_at: number | string;
    }[]>`
      SELECT id, summary_text, record_json, updated_at
      FROM private_cognition_current
      WHERE agent_id = ${agentId}
        AND kind = 'assertion'
    `;

    const results: AssertionTraversalRecord[] = [];
    for (const row of rows) {
      const parsed = this.parseAssertionRecord(row.record_json);
      const sourceEntityId = parsed.sourceEntityId;
      const targetEntityId = parsed.targetEntityId;
      const sourceMatches = sourceEntityId != null && entityIds.has(sourceEntityId);
      const targetMatches = targetEntityId != null && entityIds.has(targetEntityId);
      if (!sourceMatches && !targetMatches) {
        continue;
      }

      results.push({
        assertionRef: `assertion:${Number(row.id)}` as NodeRef,
        summary: row.summary_text,
        predicate: parsed.predicate,
        sourceEntityRef: sourceEntityId != null ? (`entity:${sourceEntityId}` as NodeRef) : null,
        targetEntityRef: targetEntityId != null ? (`entity:${targetEntityId}` as NodeRef) : null,
        sourceEventRef: parsed.sourceEventRef,
        updatedAt: Number(row.updated_at),
      });
    }

    return results;
  }

  async readAgentAssertionDetails(
    agentId: string,
    assertionRefs: readonly NodeRef[],
    asOfCommittedTime?: number,
  ): Promise<AssertionTraversalRecord[]> {
    const ids = this.extractIdsFromRefs(new Set(assertionRefs), "assertion");
    if (ids.length === 0) {
      return [];
    }

    const rows = asOfCommittedTime != null
      ? await this.sql<{
          id: number | string;
          summary_text: string | null;
          record_json: unknown;
          updated_at: number | string;
        }[]>`
          SELECT id, summary_text, record_json, updated_at
          FROM private_cognition_current
          WHERE agent_id = ${agentId}
            AND kind = 'assertion'
            AND id IN ${this.sql(ids)}
            AND updated_at <= ${asOfCommittedTime}
        `
      : await this.sql<{
          id: number | string;
          summary_text: string | null;
          record_json: unknown;
          updated_at: number | string;
        }[]>`
          SELECT id, summary_text, record_json, updated_at
          FROM private_cognition_current
          WHERE agent_id = ${agentId}
            AND kind = 'assertion'
            AND id IN ${this.sql(ids)}
        `;

    return rows.map((row) => {
      const parsed = this.parseAssertionRecord(row.record_json);
      return {
        assertionRef: `assertion:${Number(row.id)}` as NodeRef,
        summary: row.summary_text,
        predicate: parsed.predicate,
        sourceEntityRef: parsed.sourceEntityId != null ? (`entity:${parsed.sourceEntityId}` as NodeRef) : null,
        targetEntityRef: parsed.targetEntityId != null ? (`entity:${parsed.targetEntityId}` as NodeRef) : null,
        sourceEventRef: parsed.sourceEventRef,
        updatedAt: Number(row.updated_at),
      } satisfies AssertionTraversalRecord;
    });
  }

  async resolveEntityRefByPointerKey(pointerKey: string, viewerAgentId: string): Promise<NodeRef | null> {
    const normalized = pointerKey.trim().normalize("NFC");
    if (normalized.length === 0) {
      return null;
    }

    const rows = await this.sql<{ id: number | string }[]>`
      SELECT id
      FROM entity_nodes
      WHERE pointer_key = ${normalized}
        AND (
          (memory_scope = 'private_overlay' AND owner_agent_id = ${viewerAgentId})
          OR memory_scope = 'shared_public'
        )
      ORDER BY CASE WHEN memory_scope = 'private_overlay' THEN 0 ELSE 1 END
      LIMIT 1
    `;
    if (rows.length === 0) {
      return null;
    }
    return `entity:${Number(rows[0].id)}` as NodeRef;
  }

  async getNodeSnapshots(nodeRefs: readonly NodeRef[]): Promise<GraphNodeSnapshot[]> {
    const unique = Array.from(new Set(nodeRefs));
    if (unique.length === 0) {
      return [];
    }

    const byKind = this.groupIdsByKind(unique);
    const snapshots = new Map<NodeRef, GraphNodeSnapshot>();

    await this.populateSnapshots(snapshots, "event", byKind.get("event"), "event_nodes", "summary", "timestamp");
    // Fallback: private_episode_events for event IDs not resolved from event_nodes
    const snapshotEventIds = byKind.get("event") ?? [];
    const missingSnapshotEventIds = snapshotEventIds.filter((id) => !snapshots.has(`event:${id}` as NodeRef));
    if (missingSnapshotEventIds.length > 0) {
      await this.populateSnapshots(snapshots, "event", missingSnapshotEventIds, "private_episode_events", "summary", "valid_time");
    }
    await this.populateSnapshots(snapshots, "entity", byKind.get("entity"), "entity_nodes", "summary", "updated_at");
    await this.populateSnapshots(snapshots, "fact", byKind.get("fact"), "fact_edges", "predicate", "t_valid");
    await this.populatePrivateSnapshots(snapshots, "assertion", byKind.get("assertion"));
    await this.populatePrivateSnapshots(snapshots, "evaluation", byKind.get("evaluation"));
    await this.populatePrivateSnapshots(snapshots, "commitment", byKind.get("commitment"));

    return Array.from(snapshots.values());
  }

  async getNodeVisibility(nodeRefs: readonly NodeRef[]): Promise<GraphNodeVisibilityRecord[]> {
    const unique = Array.from(new Set(nodeRefs));
    if (unique.length === 0) {
      return [];
    }

    const byKind = this.groupIdsByKind(unique);
    const records: GraphNodeVisibilityRecord[] = [];

    const entityIds = byKind.get("entity") ?? [];
    if (entityIds.length > 0) {
      const rows = await this.sql<{
        id: number | string;
        memory_scope: "shared_public" | "private_overlay";
        owner_agent_id: string | null;
      }[]>`
        SELECT id, memory_scope, owner_agent_id
        FROM entity_nodes
        WHERE id IN ${this.sql(entityIds)}
      `;
      for (const row of rows) {
        records.push({
          nodeRef: `entity:${Number(row.id)}` as NodeRef,
          kind: "entity",
          memoryScope: row.memory_scope,
          ownerAgentId: row.owner_agent_id,
        });
      }
    }

    const eventIds = byKind.get("event") ?? [];
    if (eventIds.length > 0) {
      const rows = await this.sql<{
        id: number | string;
        visibility_scope: "world_public" | "area_visible";
        location_entity_id: number | string;
      }[]>`
        SELECT id, visibility_scope, location_entity_id
        FROM event_nodes
        WHERE id IN ${this.sql(eventIds)}
      `;
      const foundEventIds = new Set<number>();
      for (const row of rows) {
        foundEventIds.add(Number(row.id));
        records.push({
          nodeRef: `event:${Number(row.id)}` as NodeRef,
          kind: "event",
          visibilityScope: row.visibility_scope,
          locationEntityId: Number(row.location_entity_id),
          ownerAgentId: null,
        });
      }

      // Fallback: check private_episode_events for event IDs not found in event_nodes.
      // This handles the scenario where episodes are stored only as private events
      // (e.g. settlement path writes private_episode_events but not event_nodes).
      const missingEventIds = eventIds.filter((id) => !foundEventIds.has(id));
      if (missingEventIds.length > 0) {
        const privateRows = await this.sql<{
          id: number | string;
          agent_id: string;
          location_entity_id: number | string | null;
        }[]>`
          SELECT id, agent_id, location_entity_id
          FROM private_episode_events
          WHERE id IN ${this.sql(missingEventIds)}
        `;
        for (const row of privateRows) {
          records.push({
            nodeRef: `episode:${Number(row.id)}` as NodeRef,
            kind: "episode",
            visibilityScope: "owner_private",
            locationEntityId: Number(row.location_entity_id ?? 0),
            ownerAgentId: row.agent_id,
          });
        }
      }
    }

    const episodeIds = byKind.get("episode") ?? [];
    if (episodeIds.length > 0) {
      const rows = await this.sql<{
        id: number | string;
        agent_id: string;
        location_entity_id: number | string | null;
      }[]>`
        SELECT id, agent_id, location_entity_id
        FROM private_episode_events
        WHERE id IN ${this.sql(episodeIds)}
      `;
      for (const row of rows) {
        records.push({
          nodeRef: `episode:${Number(row.id)}` as NodeRef,
          kind: "episode",
          visibilityScope: "owner_private",
          locationEntityId: Number(row.location_entity_id ?? 0),
          ownerAgentId: row.agent_id,
        });
      }
    }

    const appendPrivateVisibilityRows = async (
      kind: "assertion" | "evaluation" | "commitment",
      ids: number[],
    ): Promise<void> => {
      if (ids.length === 0) {
        return;
      }
      const rows = await this.sql<{
        id: number | string;
        agent_id: string;
      }[]>`
        SELECT id, agent_id
        FROM private_cognition_current
        WHERE kind = ${kind}
          AND id IN ${this.sql(ids)}
      `;
      for (const row of rows) {
        records.push({
          nodeRef: `${kind}:${Number(row.id)}` as NodeRef,
          kind,
          agentId: row.agent_id,
        });
      }
    };

    await appendPrivateVisibilityRows("assertion", byKind.get("assertion") ?? []);
    await appendPrivateVisibilityRows("evaluation", byKind.get("evaluation") ?? []);
    await appendPrivateVisibilityRows("commitment", byKind.get("commitment") ?? []);

    const factIds = byKind.get("fact") ?? [];
    if (factIds.length > 0) {
      const rows = await this.sql<{
        id: number | string;
      }[]>`
        SELECT id
        FROM fact_edges
        WHERE id IN ${this.sql(factIds)}
          AND t_invalid = ${PG_MAX_BIGINT}
      `;
      for (const row of rows) {
        records.push({
          nodeRef: `fact:${Number(row.id)}` as NodeRef,
          kind: "fact",
          active: true,
        });
      }
    }

    return records;
  }

  async getPrivateNodeOwners(nodeRefs: readonly NodeRef[]): Promise<Array<{ nodeRef: NodeRef; agentId: string }>> {
    const cognitionRefs: Array<{ nodeRef: NodeRef; parsed: { kind: NodeRefKind; id: number } }> = [];
    const episodeRefs: Array<{ nodeRef: NodeRef; parsed: { kind: NodeRefKind; id: number } }> = [];

    for (const nodeRef of nodeRefs) {
      const parsed = this.parseNodeRef(nodeRef);
      if (!parsed) continue;
      if (parsed.kind === "assertion" || parsed.kind === "evaluation" || parsed.kind === "commitment") {
        cognitionRefs.push({ nodeRef, parsed });
      } else if (parsed.kind === "episode") {
        episodeRefs.push({ nodeRef, parsed });
      }
    }

    if (cognitionRefs.length === 0 && episodeRefs.length === 0) {
      return [];
    }

    const ownerById = new Map<string, string>();

    if (cognitionRefs.length > 0) {
      const ids = Array.from(new Set(cognitionRefs.map((entry) => entry.parsed.id)));
      const rows = await this.sql<{ id: number | string; agent_id: string }[]>`
        SELECT id, agent_id
        FROM private_cognition_current
        WHERE id IN ${this.sql(ids)}
      `;
      for (const row of rows) {
        ownerById.set(`cognition:${Number(row.id)}`, row.agent_id);
      }
    }

    if (episodeRefs.length > 0) {
      const ids = Array.from(new Set(episodeRefs.map((entry) => entry.parsed.id)));
      const rows = await this.sql<{ id: number | string; agent_id: string }[]>`
        SELECT id, agent_id
        FROM private_episode_events
        WHERE id IN ${this.sql(ids)}
      `;
      for (const row of rows) {
        ownerById.set(`episode:${Number(row.id)}`, row.agent_id);
      }
    }

    const owners: Array<{ nodeRef: NodeRef; agentId: string }> = [];
    for (const entry of cognitionRefs) {
      const owner = ownerById.get(`cognition:${entry.parsed.id}`);
      if (owner) {
        owners.push({ nodeRef: entry.nodeRef, agentId: owner });
      }
    }
    for (const entry of episodeRefs) {
      const owner = ownerById.get(`episode:${entry.parsed.id}`);
      if (owner) {
        owners.push({ nodeRef: entry.nodeRef, agentId: owner });
      }
    }
    return owners;
  }

  async listRelationTypesForFrontier(frontierRefs: readonly NodeRef[]): Promise<MemoryRelationType[]> {
    const refs = Array.from(new Set(frontierRefs));
    if (refs.length === 0) {
      return [];
    }

    const rows = await this.sql<{
      relation_type: string;
    }[]>`
      SELECT DISTINCT relation_type
      FROM memory_relations
      WHERE source_node_ref IN ${this.sql(refs)}
         OR target_node_ref IN ${this.sql(refs)}
    `;

    const relationTypes: MemoryRelationType[] = [];
    for (const row of rows) {
      if (MEMORY_RELATION_TYPE_SET.has(row.relation_type)) {
        relationTypes.push(row.relation_type as MemoryRelationType);
      }
    }
    return relationTypes;
  }

  private parseNodeRef(ref: NodeRef): { kind: NodeRefKind; id: number } | null {
    try {
      const parsed = parseGraphNodeRef(String(ref));
      if (!KNOWN_NODE_KINDS.has(parsed.kind)) {
        return null;
      }
      const id = Number(parsed.id);
      if (!Number.isInteger(id) || id <= 0) {
        return null;
      }
      return { kind: parsed.kind as NodeRefKind, id };
    } catch {
      return null;
    }
  }

  private extractIdsFromRefs(refs: Set<NodeRef>, kind: NodeRefKind): number[] {
    const ids: number[] = [];
    for (const ref of refs) {
      const parsed = this.parseNodeRef(ref);
      if (parsed && parsed.kind === kind) {
        ids.push(parsed.id);
      }
    }
    return ids;
  }

  private toGraphEdge(
    family: GraphReadEdgeFamily,
    layer: EdgeLayer,
    relationType: string,
    sourceRef: NodeRef,
    targetRef: NodeRef,
    options: {
      weight: number;
      strength?: number;
      sourceKind?: string;
      provenanceRef?: string;
      timestamp: number | null;
      validTime: number | null;
      committedTime: number | null;
    },
  ): GraphReadEdgeRecord {
    const sourceKind = this.parseNodeRef(sourceRef)?.kind ?? "unknown";
    const targetKind = this.parseNodeRef(targetRef)?.kind ?? "unknown";
    const relationContract = RELATION_CONTRACTS[relationType];
    const declared = relationContract !== undefined;

    return {
      family,
      layer,
      relationType,
      sourceRef,
      targetRef,
      weight: options.weight,
      strength: options.strength ?? null,
      sourceKind: options.sourceKind ?? null,
      provenanceRef: options.provenanceRef ?? null,
      timestamp: options.timestamp,
      validTime: options.validTime,
      committedTime: options.committedTime,
      truthBearing: relationContract?.truthBearing ?? layer !== "heuristic",
      heuristicOnly: relationContract?.heuristicOnly ?? layer === "heuristic",
      endpointContract: {
        sourceFamily: relationContract?.sourceFamily === "unknown" ? sourceKind : relationContract?.sourceFamily ?? sourceKind,
        targetFamily: relationContract?.targetFamily === "unknown" ? targetKind : relationContract?.targetFamily ?? targetKind,
        declared,
      },
    };
  }

  private reverseTemporalRelation(relationType: string): string {
    if (relationType === "temporal_prev") {
      return "temporal_next";
    }
    if (relationType === "temporal_next") {
      return "temporal_prev";
    }
    return relationType;
  }

  private async filterVisibleAndTimeSlicedEdges(
    edges: GraphReadEdgeRecord[],
    viewerContext: ViewerContext,
    timeSlice?: TimeSliceQuery,
  ): Promise<GraphReadEdgeRecord[]> {
    if (edges.length === 0) {
      return [];
    }

    const nodeRefs = new Set<NodeRef>();
    for (const edge of edges) {
      nodeRefs.add(edge.sourceRef);
      nodeRefs.add(edge.targetRef);
    }

    const visibilityRows = await this.getNodeVisibility(Array.from(nodeRefs));
    const visibilityByRef = new Map<NodeRef, GraphNodeVisibilityRecord>(
      visibilityRows.map((row) => [row.nodeRef, row]),
    );

    return edges.filter((edge) => {
      if (isEdgeInTimeSlice({
        timestamp: edge.timestamp,
        valid_time: edge.validTime,
        committed_time: edge.committedTime,
      }, timeSlice) === false) {
        return false;
      }
      const sourceVisibility = visibilityByRef.get(edge.sourceRef);
      const targetVisibility = visibilityByRef.get(edge.targetRef);
      if (!sourceVisibility || !targetVisibility) {
        return false;
      }

      const sourceNodeData = this.toVisibilityNodeData(sourceVisibility);
      const targetNodeData = this.toVisibilityNodeData(targetVisibility);
      if (!sourceNodeData || !targetNodeData) {
        return false;
      }

      return this.visibility.isEdgeVisible(
        viewerContext,
        edge.sourceRef,
        sourceNodeData,
        edge.targetRef,
        targetNodeData,
      );
    });
  }

  private toVisibilityNodeData(record: GraphNodeVisibilityRecord): Record<string, unknown> | null {
    if (record.kind === "entity") {
      return {
        memory_scope: record.memoryScope,
        owner_agent_id: record.ownerAgentId,
      };
    }
    if (record.kind === "event") {
      return {
        visibility_scope: record.visibilityScope,
        location_entity_id: record.locationEntityId,
        owner_agent_id: record.ownerAgentId,
      };
    }
    if (record.kind === "assertion" || record.kind === "evaluation" || record.kind === "commitment") {
      return { agent_id: record.agentId };
    }
    if (record.kind === "fact") {
      return record.active ? { id: 1 } : null;
    }
    return null;
  }

  private parseParticipantEntityRefs(participantsJson: string | null): NodeRef[] {
    if (!participantsJson) {
      return [];
    }
    try {
      const parsed = JSON.parse(participantsJson) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      const refs: NodeRef[] = [];
      for (const value of parsed) {
        if (typeof value === "number" && Number.isInteger(value) && value > 0) {
          refs.push(`entity:${value}` as NodeRef);
          continue;
        }
        if (typeof value !== "string") {
          continue;
        }
        const normalized = value.trim();
        if (normalized.length === 0) {
          continue;
        }
        try {
          const nodeRef = parseGraphNodeRef(normalized);
          if (nodeRef.kind === "entity") {
            refs.push(normalized as NodeRef);
            continue;
          }
        } catch {
        }
        const numeric = Number(normalized);
        if (Number.isInteger(numeric) && numeric > 0) {
          refs.push(`entity:${numeric}` as NodeRef);
        }
      }
      return refs;
    } catch {
      return [];
    }
  }

  private parseAssertionRecord(recordJson: unknown): ParsedAssertionRecord {
    const parsed = (() => {
      if (recordJson == null) {
        return null;
      }
      if (typeof recordJson === "string") {
        try {
          return JSON.parse(recordJson) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
      if (typeof recordJson === "object") {
        return recordJson as Record<string, unknown>;
      }
      return null;
    })();

    if (!parsed || typeof parsed !== "object") {
      return {
        sourcePointerKey: null,
        targetPointerKey: null,
        predicate: null,
        sourceEventRef: null,
        sourceEntityId: null,
        targetEntityId: null,
      };
    }

    const sourcePointerKey =
      typeof parsed.sourcePointerKey === "string" && parsed.sourcePointerKey.trim().length > 0
        ? parsed.sourcePointerKey.trim()
        : null;
    const targetPointerKey =
      typeof parsed.targetPointerKey === "string" && parsed.targetPointerKey.trim().length > 0
        ? parsed.targetPointerKey.trim()
        : null;
    const predicate =
      typeof parsed.predicate === "string" && parsed.predicate.trim().length > 0
        ? parsed.predicate.trim()
        : null;

    const sourceEventRaw =
      typeof parsed.sourceEventRef === "string"
        ? parsed.sourceEventRef
        : typeof parsed.source_event_ref === "string"
          ? parsed.source_event_ref
          : null;
    const sourceEventCandidate = sourceEventRaw?.trim();
    const sourceEventRef =
      sourceEventCandidate && this.parseNodeRef(sourceEventCandidate as NodeRef)
        ? (sourceEventCandidate as NodeRef)
        : null;

    const sourceEntityRaw = parsed.sourceEntityId ?? parsed.source_entity_id;
    const sourceEntityId =
      typeof sourceEntityRaw === "number" && Number.isInteger(sourceEntityRaw) && sourceEntityRaw > 0
        ? sourceEntityRaw
        : null;

    const targetEntityRaw = parsed.targetEntityId ?? parsed.target_entity_id;
    const targetEntityId =
      typeof targetEntityRaw === "number" && Number.isInteger(targetEntityRaw) && targetEntityRaw > 0
        ? targetEntityRaw
        : null;

    return {
      sourcePointerKey,
      targetPointerKey,
      predicate,
      sourceEventRef,
      sourceEntityId,
      targetEntityId,
    };
  }

  private groupIdsByKind(nodeRefs: readonly NodeRef[]): Map<NodeRefKind, number[]> {
    const byKind = new Map<NodeRefKind, number[]>();
    for (const nodeRef of nodeRefs) {
      const parsed = this.parseNodeRef(nodeRef);
      if (!parsed) {
        continue;
      }
      const ids = byKind.get(parsed.kind) ?? [];
      ids.push(parsed.id);
      byKind.set(parsed.kind, ids);
    }
    return byKind;
  }

  private async populateSnapshots(
    sink: Map<NodeRef, GraphNodeSnapshot>,
    kind: NodeRefKind,
    ids: number[] | undefined,
    table: string,
    summaryColumn: string,
    timestampColumn: string,
  ): Promise<void> {
    if (!ids || ids.length === 0) {
      return;
    }

    const rows = await this.sql.unsafe<{
      id: number | string;
      summary: string | null;
      ts: number | string | null;
    }[]>(
      `SELECT id, ${summaryColumn} AS summary, ${timestampColumn} AS ts
       FROM ${table}
       WHERE id = ANY($1)`,
      [ids],
    );

    for (const row of rows) {
      const id = Number(row.id);
      sink.set(`${kind}:${id}` as NodeRef, {
        nodeRef: `${kind}:${id}` as NodeRef,
        kind,
        summary: row.summary,
        timestamp: row.ts == null ? null : Number(row.ts),
      });
    }
  }

  private async populatePrivateSnapshots(
    sink: Map<NodeRef, GraphNodeSnapshot>,
    kind: "assertion" | "evaluation" | "commitment",
    ids: number[] | undefined,
  ): Promise<void> {
    if (!ids || ids.length === 0) {
      return;
    }

    const rows = await this.sql<{
      id: number | string;
      summary: string | null;
      ts: number | string | null;
    }[]>`
      SELECT id, summary_text AS summary, updated_at AS ts
      FROM private_cognition_current
      WHERE kind = ${kind}
        AND id IN ${this.sql(ids)}
    `;

    for (const row of rows) {
      const id = Number(row.id);
      sink.set(`${kind}:${id}` as NodeRef, {
        nodeRef: `${kind}:${id}` as NodeRef,
        kind,
        summary: row.summary,
        timestamp: row.ts == null ? null : Number(row.ts),
      });
    }
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }
}
