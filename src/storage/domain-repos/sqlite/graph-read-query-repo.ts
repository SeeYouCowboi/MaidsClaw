import type { Database } from "bun:sqlite";
import { parseGraphNodeRef } from "../../../memory/contracts/graph-node-ref.js";
import { MAX_INTEGER } from "../../../memory/schema.js";
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
import type { Db } from "../../database.js";
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

type SqliteReadDb = Db | Database;
type EndpointFamily = NodeRefKind | "unknown";

type RelationContract = {
  sourceFamily: EndpointFamily;
  targetFamily: EndpointFamily;
  truthBearing: boolean;
  heuristicOnly: boolean;
};

const KNOWN_NODE_KINDS = new Set<NodeRefKind>([
  "event",
  "entity",
  "fact",
  "assertion",
  "evaluation",
  "commitment",
]);

const LOGIC_EDGE_CONTRACTS: Record<string, RelationContract> = {
  causal: { sourceFamily: "event", targetFamily: "event", truthBearing: true, heuristicOnly: false },
  temporal_prev: { sourceFamily: "event", targetFamily: "event", truthBearing: true, heuristicOnly: false },
  temporal_next: { sourceFamily: "event", targetFamily: "event", truthBearing: true, heuristicOnly: false },
  same_episode: { sourceFamily: "event", targetFamily: "event", truthBearing: true, heuristicOnly: false },
  semantic_similar: { sourceFamily: "unknown", targetFamily: "unknown", truthBearing: false, heuristicOnly: true },
  conflict_or_update: { sourceFamily: "unknown", targetFamily: "unknown", truthBearing: false, heuristicOnly: true },
  entity_bridge: { sourceFamily: "unknown", targetFamily: "unknown", truthBearing: false, heuristicOnly: true },
};

const MEMORY_RELATION_CONTRACTS: Record<MemoryRelationType, RelationContract> = {
  supports: { sourceFamily: "event", targetFamily: "assertion", truthBearing: true, heuristicOnly: false },
  triggered: { sourceFamily: "event", targetFamily: "evaluation", truthBearing: true, heuristicOnly: false },
  conflicts_with: { sourceFamily: "assertion", targetFamily: "assertion", truthBearing: true, heuristicOnly: false },
  derived_from: { sourceFamily: "fact", targetFamily: "assertion", truthBearing: true, heuristicOnly: false },
  supersedes: { sourceFamily: "assertion", targetFamily: "assertion", truthBearing: true, heuristicOnly: false },
  surfaced_as: { sourceFamily: "assertion", targetFamily: "event", truthBearing: true, heuristicOnly: false },
  published_as: { sourceFamily: "event", targetFamily: "entity", truthBearing: true, heuristicOnly: false },
  resolved_by: { sourceFamily: "assertion", targetFamily: "fact", truthBearing: false, heuristicOnly: true },
  downgraded_by: { sourceFamily: "assertion", targetFamily: "evaluation", truthBearing: false, heuristicOnly: true },
};

const RELATION_CONTRACTS: Record<string, RelationContract> = {
  ...LOGIC_EDGE_CONTRACTS,
  ...MEMORY_RELATION_CONTRACTS,
};

const MEMORY_RELATION_TYPE_SET = new Set<string>(MEMORY_RELATION_TYPES);

type ParsedAssertionRecord = {
  sourcePointerKey: string | null;
  targetPointerKey: string | null;
  predicate: string | null;
  sourceEventRef: NodeRef | null;
  sourceEntityId: number | null;
  targetEntityId: number | null;
};

export class SqliteGraphReadQueryRepo implements GraphReadQueryRepo {
  private readonly visibility = new VisibilityPolicy();

  constructor(private readonly db: SqliteReadDb) {}

  async getNodeSalience(nodeRefs: readonly NodeRef[]): Promise<NodeSalienceRecord[]> {
    const unique = Array.from(new Set(nodeRefs));
    if (unique.length === 0) {
      return [];
    }
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.queryAll<{ node_ref: string; salience: number }>(
      `SELECT node_ref, salience FROM node_scores WHERE node_ref IN (${placeholders})`,
      unique,
    );
    return rows.map((row) => ({
      nodeRef: row.node_ref as NodeRef,
      salience: this.clamp01(row.salience),
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

    const placeholders = ids.map(() => "?").join(",");
    const rows = this.queryAll<{
      source_event_id: number;
      target_event_id: number;
      relation_type: string;
      created_at: number;
    }>(
      `SELECT source_event_id, target_event_id, relation_type, created_at
       FROM logic_edges
       WHERE source_event_id IN (${placeholders}) OR target_event_id IN (${placeholders})`,
      [...ids, ...ids],
    );

    const candidates: GraphReadEdgeRecord[] = [];
    for (const row of rows) {
      const sourceRef = `event:${row.source_event_id}` as NodeRef;
      const targetRef = `event:${row.target_event_id}` as NodeRef;
      if (frontier.has(sourceRef)) {
        candidates.push(this.toGraphEdge("logic_edges", "symbolic", row.relation_type, sourceRef, targetRef, {
          weight: 1,
          timestamp: row.created_at,
          validTime: row.created_at,
          committedTime: row.created_at,
        }));
      }
      if (frontier.has(targetRef)) {
        candidates.push(
          this.toGraphEdge(
            "logic_edges",
            "symbolic",
            this.reverseTemporalRelation(row.relation_type),
            targetRef,
            sourceRef,
            {
              weight: 1,
              timestamp: row.created_at,
              validTime: row.created_at,
              committedTime: row.created_at,
            },
          ),
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
    const placeholders = refs.map(() => "?").join(",");

    let rows: Array<{
      source_node_ref: NodeRef;
      target_node_ref: NodeRef;
      relation_type: string;
      strength: number;
      source_kind: string;
      source_ref: string;
      created_at: number;
      updated_at: number;
    }> = [];
    try {
      rows = this.queryAll(
        `SELECT source_node_ref, target_node_ref, relation_type, strength, source_kind, source_ref, created_at, updated_at
         FROM memory_relations
         WHERE source_node_ref IN (${placeholders}) OR target_node_ref IN (${placeholders})`,
        [...refs, ...refs],
      );
    } catch (error) {
      console.error("[SqliteGraphReadQueryRepo.readMemoryRelationEdges] failed", error);
      return [];
    }

    const candidates: GraphReadEdgeRecord[] = [];
    for (const row of rows) {
      if (frontier.has(row.source_node_ref)) {
        candidates.push(this.toGraphEdge("memory_relations", "symbolic", row.relation_type, row.source_node_ref, row.target_node_ref, {
          weight: row.strength,
          strength: row.strength,
          sourceKind: row.source_kind,
          provenanceRef: row.source_ref,
          timestamp: row.created_at,
          validTime: row.created_at,
          committedTime: row.updated_at > 0 ? row.updated_at : row.created_at,
        }));
      }
      if (frontier.has(row.target_node_ref)) {
        candidates.push(this.toGraphEdge("memory_relations", "symbolic", row.relation_type, row.target_node_ref, row.source_node_ref, {
          weight: row.strength,
          strength: row.strength,
          sourceKind: row.source_kind,
          provenanceRef: row.source_ref,
          timestamp: row.created_at,
          validTime: row.created_at,
          committedTime: row.updated_at > 0 ? row.updated_at : row.created_at,
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
    const placeholders = refs.map(() => "?").join(",");

    const rows = this.queryAll<{
      source_node_ref: NodeRef;
      target_node_ref: NodeRef;
      relation_type: string;
      weight: number;
      created_at: number;
    }>(
      `SELECT source_node_ref, target_node_ref, relation_type, weight, created_at
       FROM semantic_edges
       WHERE source_node_ref IN (${placeholders}) OR target_node_ref IN (${placeholders})`,
      [...refs, ...refs],
    );

    const candidates: GraphReadEdgeRecord[] = [];
    for (const row of rows) {
      if (frontier.has(row.source_node_ref)) {
        candidates.push(this.toGraphEdge("semantic_edges", "heuristic", row.relation_type, row.source_node_ref, row.target_node_ref, {
          weight: row.weight,
          timestamp: row.created_at,
          validTime: row.created_at,
          committedTime: row.created_at,
        }));
      }
      if (frontier.has(row.target_node_ref)) {
        candidates.push(this.toGraphEdge("semantic_edges", "heuristic", row.relation_type, row.target_node_ref, row.source_node_ref, {
          weight: row.weight,
          timestamp: row.created_at,
          validTime: row.created_at,
          committedTime: row.created_at,
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
    const frontier = new Set(frontierEventRefs);
    const ids = this.extractIdsFromRefs(frontier, "event");
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(",");
    const rows = this.queryAll<{
      id: number;
      source_event_id: number;
      t_valid: number;
      t_created: number;
    }>(
      `SELECT id, source_event_id, t_valid, t_created
       FROM fact_edges
       WHERE t_invalid = ? AND source_event_id IN (${placeholders})`,
      [MAX_INTEGER, ...ids],
    );

    const candidates = rows.map((row) => {
      const edge = this.toGraphEdge(
        "memory_relations",
        "state",
        "fact_support",
        `event:${row.source_event_id}` as NodeRef,
        `fact:${row.id}` as NodeRef,
        {
          weight: 0.95,
          timestamp: row.t_valid,
          validTime: row.t_valid,
          committedTime: row.t_created,
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
    const placeholders = ids.map(() => "?").join(",");
    const eventVisibilityPredicate = this.visibility.eventVisibilityPredicate(viewerContext);

    const rows = this.queryAll<{
      id: number;
      participants: string | null;
      primary_actor_entity_id: number | null;
      timestamp: number;
      summary: string | null;
    }>(
      `SELECT id, participants, primary_actor_entity_id, timestamp, summary
       FROM event_nodes
       WHERE id IN (${placeholders})
         AND ${eventVisibilityPredicate}`,
      ids,
    );

    return rows.map((row) => {
      const participantEntityRefs = new Set<NodeRef>();
      for (const participantRef of this.parseParticipantEntityRefs(row.participants)) {
        participantEntityRefs.add(participantRef);
      }
      const primaryActor = row.primary_actor_entity_id != null
        ? (`entity:${row.primary_actor_entity_id}` as NodeRef)
        : null;
      if (primaryActor) {
        participantEntityRefs.add(primaryActor);
      }

      return {
        eventRef: `event:${row.id}` as NodeRef,
        summary: row.summary,
        timestamp: row.timestamp,
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
      const placeholders = entityIds.map(() => "?").join(",");
      const rows = this.queryAll<{
        id: number;
        source_entity_id: number;
        target_entity_id: number;
        predicate: string;
        t_valid: number;
        source_event_id: number | null;
      }>(
        `SELECT id, source_entity_id, target_entity_id, predicate, t_valid, source_event_id
         FROM fact_edges
         WHERE t_invalid = ?
           AND (source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))`,
        [MAX_INTEGER, ...entityIds, ...entityIds],
      );
      for (const row of rows) {
        rowsById.set(row.id, row);
      }
    }

    if (factIds.length > 0) {
      const placeholders = factIds.map(() => "?").join(",");
      const rows = this.queryAll<{
        id: number;
        source_entity_id: number;
        target_entity_id: number;
        predicate: string;
        t_valid: number;
        source_event_id: number | null;
      }>(
        `SELECT id, source_entity_id, target_entity_id, predicate, t_valid, source_event_id
         FROM fact_edges
         WHERE t_invalid = ?
           AND id IN (${placeholders})`,
        [MAX_INTEGER, ...factIds],
      );
      for (const row of rows) {
        rowsById.set(row.id, row);
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

    const placeholders = ids.map(() => "?").join(",");
    const participantConditions = ids.map(() => "participants LIKE ?").join(" OR ");
    const eventVisibilityPredicate = this.visibility.eventVisibilityPredicate(viewerContext);
    const participantSql =
      `SELECT id, participants, primary_actor_entity_id, timestamp, summary
       FROM event_nodes
       WHERE (
         primary_actor_entity_id IN (${placeholders})` +
      (participantConditions.length > 0 ? ` OR ${participantConditions}` : "") +
      `)
       AND ${eventVisibilityPredicate}`;
    const participantBindings = [...ids, ...ids.map((id) => `%entity:${id}%`)];

    const rows = this.queryAll<{
      id: number;
      participants: string | null;
      primary_actor_entity_id: number | null;
      timestamp: number;
      summary: string | null;
    }>(participantSql, participantBindings);

    return rows.map((row) => {
      const participantEntityRefs = new Set<NodeRef>();
      for (const participantRef of this.parseParticipantEntityRefs(row.participants)) {
        participantEntityRefs.add(participantRef);
      }
      const primaryActor = row.primary_actor_entity_id != null
        ? (`entity:${row.primary_actor_entity_id}` as NodeRef)
        : null;
      if (primaryActor) {
        participantEntityRefs.add(primaryActor);
      }

      return {
        eventRef: `event:${row.id}` as NodeRef,
        summary: row.summary,
        timestamp: row.timestamp,
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

    const rows = this.queryAll<{
      id: number;
      summary_text: string | null;
      record_json: string | null;
      updated_at: number;
    }>(
      `SELECT id, summary_text, record_json, updated_at
       FROM private_cognition_current
       WHERE agent_id = ? AND kind = 'assertion'`,
      [agentId],
    );

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
        assertionRef: `assertion:${row.id}` as NodeRef,
        summary: row.summary_text,
        predicate: parsed.predicate,
        sourceEntityRef: sourceEntityId != null ? (`entity:${sourceEntityId}` as NodeRef) : null,
        targetEntityRef: targetEntityId != null ? (`entity:${targetEntityId}` as NodeRef) : null,
        sourceEventRef: parsed.sourceEventRef,
        updatedAt: row.updated_at,
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
    const placeholders = ids.map(() => "?").join(",");
    const committedCutoffClause = asOfCommittedTime != null ? " AND updated_at <= ?" : "";

    const rows = this.queryAll<{
      id: number;
      summary_text: string | null;
      record_json: string | null;
      updated_at: number;
    }>(
      `SELECT id, summary_text, record_json, updated_at
       FROM private_cognition_current
       WHERE agent_id = ?
         AND kind = 'assertion'
         AND id IN (${placeholders})${committedCutoffClause}`,
      [agentId, ...ids, ...(asOfCommittedTime != null ? [asOfCommittedTime] : [])],
    );

    return rows.map((row) => {
      const parsed = this.parseAssertionRecord(row.record_json);
      return {
        assertionRef: `assertion:${row.id}` as NodeRef,
        summary: row.summary_text,
        predicate: parsed.predicate,
        sourceEntityRef: parsed.sourceEntityId != null ? (`entity:${parsed.sourceEntityId}` as NodeRef) : null,
        targetEntityRef: parsed.targetEntityId != null ? (`entity:${parsed.targetEntityId}` as NodeRef) : null,
        sourceEventRef: parsed.sourceEventRef,
        updatedAt: row.updated_at,
      } satisfies AssertionTraversalRecord;
    });
  }

  async resolveEntityRefByPointerKey(pointerKey: string, viewerAgentId: string): Promise<NodeRef | null> {
    const normalized = pointerKey.trim().normalize("NFC");
    if (normalized.length === 0) {
      return null;
    }

    const row = this.queryGet<{ id: number }>(
      `SELECT id
       FROM entity_nodes
       WHERE pointer_key = ?
         AND (
           (memory_scope = 'private_overlay' AND owner_agent_id = ?)
           OR memory_scope = 'shared_public'
         )
       ORDER BY CASE WHEN memory_scope = 'private_overlay' THEN 0 ELSE 1 END
       LIMIT 1`,
      [normalized, viewerAgentId],
    );

    return row ? (`entity:${row.id}` as NodeRef) : null;
  }

  async getNodeSnapshots(nodeRefs: readonly NodeRef[]): Promise<GraphNodeSnapshot[]> {
    const unique = Array.from(new Set(nodeRefs));
    if (unique.length === 0) {
      return [];
    }

    const byKind = this.groupIdsByKind(unique);
    const snapshots = new Map<NodeRef, GraphNodeSnapshot>();

    this.populateSnapshots(snapshots, "event", byKind.get("event"), "event_nodes", "summary", "timestamp");
    this.populateSnapshots(snapshots, "entity", byKind.get("entity"), "entity_nodes", "summary", "updated_at");
    this.populateSnapshots(snapshots, "fact", byKind.get("fact"), "fact_edges", "predicate", "t_valid");
    this.populatePrivateSnapshots(snapshots, "assertion", byKind.get("assertion"));
    this.populatePrivateSnapshots(snapshots, "evaluation", byKind.get("evaluation"));
    this.populatePrivateSnapshots(snapshots, "commitment", byKind.get("commitment"));

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
      const placeholders = entityIds.map(() => "?").join(",");
      const rows = this.queryAll<{
        id: number;
        memory_scope: "shared_public" | "private_overlay";
        owner_agent_id: string | null;
      }>(
        `SELECT id, memory_scope, owner_agent_id
         FROM entity_nodes
         WHERE id IN (${placeholders})`,
        entityIds,
      );
      for (const row of rows) {
        records.push({
          nodeRef: `entity:${row.id}` as NodeRef,
          kind: "entity",
          memoryScope: row.memory_scope,
          ownerAgentId: row.owner_agent_id,
        });
      }
    }

    const eventIds = byKind.get("event") ?? [];
    if (eventIds.length > 0) {
      const placeholders = eventIds.map(() => "?").join(",");
      const rows = this.queryAll<{
        id: number;
        visibility_scope: "world_public" | "area_visible";
        location_entity_id: number;
      }>(
        `SELECT id, visibility_scope, location_entity_id
         FROM event_nodes
         WHERE id IN (${placeholders})`,
        eventIds,
      );
      for (const row of rows) {
        records.push({
          nodeRef: `event:${row.id}` as NodeRef,
          kind: "event",
          visibilityScope: row.visibility_scope,
          locationEntityId: row.location_entity_id,
          ownerAgentId: null,
        });
      }
    }

    const appendPrivateVisibilityRows = (
      kind: "assertion" | "evaluation" | "commitment",
      ids: number[],
    ): void => {
      if (ids.length === 0) {
        return;
      }
      const placeholders = ids.map(() => "?").join(",");
      const rows = this.queryAll<{ id: number; agent_id: string }>(
        `SELECT id, agent_id
         FROM private_cognition_current
         WHERE kind = ? AND id IN (${placeholders})`,
        [kind, ...ids],
      );
      for (const row of rows) {
        records.push({
          nodeRef: `${kind}:${row.id}` as NodeRef,
          kind,
          agentId: row.agent_id,
        });
      }
    };

    appendPrivateVisibilityRows("assertion", byKind.get("assertion") ?? []);
    appendPrivateVisibilityRows("evaluation", byKind.get("evaluation") ?? []);
    appendPrivateVisibilityRows("commitment", byKind.get("commitment") ?? []);

    const factIds = byKind.get("fact") ?? [];
    if (factIds.length > 0) {
      const placeholders = factIds.map(() => "?").join(",");
      const rows = this.queryAll<{ id: number }>(
        `SELECT id
         FROM fact_edges
         WHERE id IN (${placeholders}) AND t_invalid = ?`,
        [...factIds, MAX_INTEGER],
      );
      for (const row of rows) {
        records.push({
          nodeRef: `fact:${row.id}` as NodeRef,
          kind: "fact",
          active: true,
        });
      }
    }

    return records;
  }

  async getPrivateNodeOwners(nodeRefs: readonly NodeRef[]): Promise<Array<{ nodeRef: NodeRef; agentId: string }>> {
    const privateRefs = nodeRefs
      .map((nodeRef) => ({ nodeRef, parsed: this.parseNodeRef(nodeRef) }))
      .filter((entry): entry is { nodeRef: NodeRef; parsed: { kind: NodeRefKind; id: number } } => (
        entry.parsed != null
          && (entry.parsed.kind === "assertion" || entry.parsed.kind === "evaluation" || entry.parsed.kind === "commitment")
      ));

    if (privateRefs.length === 0) {
      return [];
    }

    const ids = Array.from(new Set(privateRefs.map((entry) => entry.parsed.id)));
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.queryAll<{ id: number; agent_id: string }>(
      `SELECT id, agent_id
       FROM private_cognition_current
       WHERE id IN (${placeholders})`,
      ids,
    );
    const ownerById = new Map<number, string>(rows.map((row) => [row.id, row.agent_id]));

    const owners: Array<{ nodeRef: NodeRef; agentId: string }> = [];
    for (const entry of privateRefs) {
      const owner = ownerById.get(entry.parsed.id);
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
    const placeholders = refs.map(() => "?").join(",");
    const rows = this.queryAll<{ relation_type: string }>(
      `SELECT DISTINCT relation_type
       FROM memory_relations
       WHERE source_node_ref IN (${placeholders}) OR target_node_ref IN (${placeholders})`,
      [...refs, ...refs],
    );

    const relationTypes: MemoryRelationType[] = [];
    for (const row of rows) {
      if (MEMORY_RELATION_TYPE_SET.has(row.relation_type)) {
        relationTypes.push(row.relation_type as MemoryRelationType);
      }
    }
    return relationTypes;
  }

  private queryAll<T>(sql: string, params: readonly unknown[] = []): T[] {
    if (this.isDbAdapter(this.db)) {
      return (this.db as Db).query<T>(sql, [...params]);
    }
    const stmt = (this.db as Database).prepare(sql);
    return (params.length > 0 ? stmt.all(...params as never[]) : stmt.all()) as T[];
  }

  private queryGet<T>(sql: string, params: readonly unknown[] = []): T | undefined {
    if (this.isDbAdapter(this.db)) {
      return (this.db as Db).get<T>(sql, [...params]);
    }
    const stmt = (this.db as Database).prepare(sql);
    const result = (params.length > 0 ? stmt.get(...params as never[]) : stmt.get()) as T | null;
    return result ?? undefined;
  }

  private isDbAdapter(db: SqliteReadDb): db is Db {
    return typeof (db as Partial<Db>).raw === "object";
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
      if (!isEdgeInTimeSlice({
        timestamp: edge.timestamp,
        valid_time: edge.validTime,
        committed_time: edge.committedTime,
      }, timeSlice)) {
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

  private parseAssertionRecord(recordJson: string | null): ParsedAssertionRecord {
    if (!recordJson) {
      return {
        sourcePointerKey: null,
        targetPointerKey: null,
        predicate: null,
        sourceEventRef: null,
        sourceEntityId: null,
        targetEntityId: null,
      };
    }

    try {
      const parsed = JSON.parse(recordJson) as Record<string, unknown>;
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
    } catch {
      return {
        sourcePointerKey: null,
        targetPointerKey: null,
        predicate: null,
        sourceEventRef: null,
        sourceEntityId: null,
        targetEntityId: null,
      };
    }
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

  private populateSnapshots(
    sink: Map<NodeRef, GraphNodeSnapshot>,
    kind: NodeRefKind,
    ids: number[] | undefined,
    table: string,
    summaryColumn: string,
    timestampColumn: string,
  ): void {
    if (!ids || ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.queryAll<{ id: number; summary: string | null; ts: number | null }>(
      `SELECT id, ${summaryColumn} AS summary, ${timestampColumn} AS ts
       FROM ${table}
       WHERE id IN (${placeholders})`,
      ids,
    );
    for (const row of rows) {
      sink.set(`${kind}:${row.id}` as NodeRef, {
        nodeRef: `${kind}:${row.id}` as NodeRef,
        kind,
        summary: row.summary,
        timestamp: row.ts,
      });
    }
  }

  private populatePrivateSnapshots(
    sink: Map<NodeRef, GraphNodeSnapshot>,
    kind: "assertion" | "evaluation" | "commitment",
    ids: number[] | undefined,
  ): void {
    if (!ids || ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.queryAll<{ id: number; summary: string | null; ts: number | null }>(
      `SELECT id, summary_text AS summary, updated_at AS ts
       FROM private_cognition_current
       WHERE kind = ? AND id IN (${placeholders})`,
      [kind, ...ids],
    );
    for (const row of rows) {
      sink.set(`${kind}:${row.id}` as NodeRef, {
        nodeRef: `${kind}:${row.id}` as NodeRef,
        kind,
        summary: row.summary,
        timestamp: row.ts,
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
