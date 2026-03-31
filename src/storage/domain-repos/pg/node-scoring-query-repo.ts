import type postgres from "postgres";
import { makeNodeRef } from "../../../memory/schema.js";
import type { NodeRef, NodeRefKind } from "../../../memory/types.js";
import type {
  NodeRenderingPayload,
  NodeScoringQueryRepo,
  SearchProjectionMaterial,
  SemanticNeighborWeight,
} from "../contracts/node-scoring-query-repo.js";

type ParsedNodeRef = {
  kind: NodeRefKind;
  id: number;
};

type EmbeddingRow = { embedding: unknown };

const NODE_REF_REGEX = /^(event|entity|fact|assertion|evaluation|commitment):([1-9]\d*)$/;

function parseNodeRef(nodeRef: NodeRef): ParsedNodeRef | null {
  const match = NODE_REF_REGEX.exec(nodeRef);
  if (!match) {
    return null;
  }
  return {
    kind: match[1] as NodeRefKind,
    id: Number(match[2]),
  };
}

function parseVectorString(input: string): Float32Array {
  const text = input.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) {
    return new Float32Array(0);
  }
  const payload = text.slice(1, -1).trim();
  if (!payload) {
    return new Float32Array(0);
  }
  const values = payload
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
  return new Float32Array(values);
}

function parseVector(value: unknown): Float32Array {
  if (value instanceof Float32Array) {
    return new Float32Array(value);
  }
  if (typeof value === "string") {
    return parseVectorString(value);
  }
  if (Array.isArray(value)) {
    return new Float32Array(value.map((item) => Number(item)));
  }
  if (value instanceof Uint8Array) {
    const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return new Float32Array(buffer);
  }
  return new Float32Array(0);
}

export class PgNodeScoringQueryRepo implements NodeScoringQueryRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async getNodeRenderingPayload(nodeRef: NodeRef): Promise<NodeRenderingPayload | null> {
    const parsed = parseNodeRef(nodeRef);
    if (!parsed) {
      return null;
    }

    if (parsed.kind === "entity") {
      const rows = await this.sql<{ display_name: string; summary: string | null; entity_type: string }[]>`
        SELECT display_name, summary, entity_type
        FROM entity_nodes
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      if (rows.length === 0) {
        return null;
      }
      return {
        nodeRef,
        nodeKind: parsed.kind,
        content: `${rows[0].display_name} ${rows[0].entity_type} ${rows[0].summary ?? ""}`.trim(),
      };
    }

    if (parsed.kind === "event") {
      const rows = await this.sql<{ summary: string | null; raw_text: string | null; event_category: string }[]>`
        SELECT summary, raw_text, event_category
        FROM event_nodes
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      if (rows.length === 0) {
        return null;
      }
      return {
        nodeRef,
        nodeKind: parsed.kind,
        content: `${rows[0].summary ?? ""} ${rows[0].raw_text ?? ""} ${rows[0].event_category}`.trim(),
      };
    }

    if (parsed.kind === "fact") {
      const rows = await this.sql<{ source_entity_id: number | string; predicate: string; target_entity_id: number | string }[]>`
        SELECT source_entity_id, predicate, target_entity_id
        FROM fact_edges
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      if (rows.length === 0) {
        return null;
      }
      return {
        nodeRef,
        nodeKind: parsed.kind,
        content: `${Number(rows[0].source_entity_id)} ${rows[0].predicate} ${Number(rows[0].target_entity_id)}`,
      };
    }

    if (parsed.kind === "evaluation" || parsed.kind === "commitment") {
      const rows = await this.sql<{ private_notes: string | null; summary_text: string | null; kind: string }[]>`
        SELECT record_json ->> 'privateNotes' AS private_notes, summary_text, kind
        FROM private_cognition_current
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      if (rows.length === 0) {
        return null;
      }
      return {
        nodeRef,
        nodeKind: parsed.kind,
        content: `${rows[0].private_notes ?? ""} ${rows[0].summary_text ?? ""} ${rows[0].kind}`.trim(),
      };
    }

    const rows = await this.sql<{ summary_text: string | null; provenance: string | null; stance: string | null }[]>`
      SELECT summary_text, record_json ->> 'provenance' AS provenance, stance
      FROM private_cognition_current
      WHERE id = ${parsed.id}
        AND kind = 'assertion'
      LIMIT 1
    `;
    if (rows.length === 0) {
      return null;
    }

    return {
      nodeRef,
      nodeKind: parsed.kind,
      content: `${rows[0].summary_text ?? ""} ${rows[0].provenance ?? ""} ${rows[0].stance ?? ""}`.trim(),
    };
  }

  async getLatestNodeEmbedding(nodeRef: NodeRef): Promise<Float32Array | null> {
    const rows = await this.sql<EmbeddingRow[]>`
      SELECT embedding
      FROM node_embeddings
      WHERE node_ref = ${nodeRef}
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    if (rows.length === 0) {
      return null;
    }
    return parseVector(rows[0].embedding);
  }

  async registerGraphNodeShadows(nodes: NodeRef[], registeredAt = Date.now()): Promise<void> {
    try {
      for (const nodeRef of nodes) {
        const parsed = parseNodeRef(nodeRef);
        if (!parsed) {
          continue;
        }
        await this.sql`
          INSERT INTO graph_nodes (node_kind, node_id, node_ref, created_at, updated_at)
          VALUES (${parsed.kind}, ${parsed.id}, ${nodeRef}, ${registeredAt}, ${registeredAt})
          ON CONFLICT (node_kind, node_id)
          DO UPDATE SET updated_at = EXCLUDED.updated_at
        `;
      }
    } catch {
    }
  }

  async listSemanticNeighborWeights(nodeRef: NodeRef): Promise<SemanticNeighborWeight[]> {
    const rows = await this.sql<{
      source: string;
      target: string;
      weight: number | string;
    }[]>`
      SELECT source, target, weight
      FROM semantic_edges
      WHERE source = ${nodeRef}
         OR target = ${nodeRef}
    `;

    return rows.map((row) => ({
      nodeRef,
      neighborRef: (row.source === nodeRef ? row.target : row.source) as NodeRef,
      weight: Number(row.weight),
    }));
  }

  async hasNodeScore(nodeRef: NodeRef): Promise<boolean> {
    const rows = await this.sql<{ node_ref: string }[]>`
      SELECT node_ref
      FROM node_scores
      WHERE node_ref = ${nodeRef}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async getNodeRecencyTimestamp(nodeRef: NodeRef): Promise<number | null> {
    const parsed = parseNodeRef(nodeRef);
    if (!parsed) {
      return null;
    }

    if (parsed.kind === "entity") {
      const rows = await this.sql<{ updated_at: number | string }[]>`
        SELECT updated_at
        FROM entity_nodes
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      return rows.length > 0 ? Number(rows[0].updated_at) : null;
    }

    if (parsed.kind === "event") {
      const rows = await this.sql<{ created_at: number | string }[]>`
        SELECT created_at
        FROM event_nodes
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      return rows.length > 0 ? Number(rows[0].created_at) : null;
    }

    if (parsed.kind === "fact") {
      const rows = await this.sql<{ t_created: number | string }[]>`
        SELECT t_created
        FROM fact_edges
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      return rows.length > 0 ? Number(rows[0].t_created) : null;
    }

    const rows = await this.sql<{ updated_at: number | string }[]>`
      SELECT updated_at
      FROM private_cognition_current
      WHERE id = ${parsed.id}
      LIMIT 1
    `;
    return rows.length > 0 ? Number(rows[0].updated_at) : null;
  }

  async getEventLogicDegree(nodeRef: NodeRef): Promise<number> {
    const parsed = parseNodeRef(nodeRef);
    if (!parsed || parsed.kind !== "event") {
      return 0;
    }

    const rows = await this.sql<{ degree: number | string }[]>`
      SELECT
        (SELECT count(*) FROM logic_edges WHERE source_event_id = ${parsed.id}) +
        (SELECT count(*) FROM logic_edges WHERE target_event_id = ${parsed.id})
        AS degree
    `;
    return rows.length > 0 ? Number(rows[0].degree) : 0;
  }

  async getNodeTopicCluster(nodeRef: NodeRef): Promise<number | null> {
    const parsed = parseNodeRef(nodeRef);
    if (!parsed) {
      return null;
    }

    if (parsed.kind === "event") {
      const rows = await this.sql<{ topic_id: number | string | null }[]>`
        SELECT topic_id
        FROM event_nodes
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      if (rows.length === 0 || rows[0].topic_id == null) {
        return null;
      }
      return Number(rows[0].topic_id);
    }

    if (parsed.kind === "evaluation" || parsed.kind === "commitment") {
      const rows = await this.sql<{ topic_id: number | string | null }[]>`
        SELECT e.topic_id
        FROM private_cognition_current c
        JOIN event_nodes e ON e.id = c.source_event_id
        WHERE c.id = ${parsed.id}
        LIMIT 1
      `;
      if (rows.length === 0 || rows[0].topic_id == null) {
        return null;
      }
      return Number(rows[0].topic_id);
    }

    return null;
  }

  async getSearchProjectionMaterial(
    nodeRef: NodeRef,
    fallbackAgentId: string,
  ): Promise<SearchProjectionMaterial | null> {
    const parsed = parseNodeRef(nodeRef);
    if (!parsed) {
      return null;
    }

    if (parsed.kind === "event") {
      const rows = await this.sql<{ summary: string | null; visibility_scope: string; location_entity_id: number | string }[]>`
        SELECT summary, visibility_scope, location_entity_id
        FROM event_nodes
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      if (rows.length === 0 || !rows[0].summary) {
        return null;
      }
      if (rows[0].visibility_scope === "area_visible") {
        return {
          nodeRef,
          scope: "area",
          content: rows[0].summary,
          locationEntityId: Number(rows[0].location_entity_id),
          removeExisting: false,
        };
      }
      return {
        nodeRef,
        scope: "world",
        content: rows[0].summary,
        removeExisting: false,
      };
    }

    if (parsed.kind === "entity") {
      const rows = await this.sql<{
        display_name: string;
        summary: string | null;
        memory_scope: "shared_public" | "private_overlay";
        owner_agent_id: string | null;
      }[]>`
        SELECT display_name, summary, memory_scope, owner_agent_id
        FROM entity_nodes
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      if (rows.length === 0) {
        return null;
      }

      const content = `${rows[0].display_name} ${rows[0].summary ?? ""}`.trim();
      if (rows[0].memory_scope === "private_overlay") {
        return {
          nodeRef,
          scope: "private",
          content,
          agentId: rows[0].owner_agent_id ?? fallbackAgentId,
          removeExisting: false,
        };
      }
      return {
        nodeRef,
        scope: "world",
        content,
        removeExisting: false,
      };
    }

    if (parsed.kind === "evaluation" || parsed.kind === "commitment") {
      const rows = await this.sql<{
        private_notes: string | null;
        summary_text: string | null;
        agent_id: string;
        status: string | null;
      }[]>`
        SELECT record_json ->> 'privateNotes' AS private_notes, summary_text, agent_id, status
        FROM private_cognition_current
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      if (rows.length === 0) {
        return null;
      }
      if (rows[0].status === "retracted") {
        return {
          nodeRef,
          scope: "private",
          removeExisting: true,
          reason: "retracted",
        };
      }
      return {
        nodeRef,
        scope: "private",
        content: `${rows[0].private_notes ?? ""} ${rows[0].summary_text ?? ""}`.trim(),
        agentId: rows[0].agent_id,
        removeExisting: false,
      };
    }

    if (parsed.kind === "assertion") {
      const rows = await this.sql<{
        summary_text: string | null;
        provenance: string | null;
        agent_id: string;
        stance: string | null;
      }[]>`
        SELECT summary_text, record_json ->> 'provenance' AS provenance, agent_id, stance
        FROM private_cognition_current
        WHERE id = ${parsed.id}
          AND kind = 'assertion'
        LIMIT 1
      `;
      if (rows.length === 0) {
        return null;
      }
      if (rows[0].stance === "rejected" || rows[0].stance === "abandoned") {
        return {
          nodeRef,
          scope: "private",
          removeExisting: true,
          reason: rows[0].stance,
        };
      }
      return {
        nodeRef,
        scope: "private",
        content: `${rows[0].summary_text ?? ""} ${rows[0].provenance ?? ""}`.trim(),
        agentId: rows[0].agent_id,
        removeExisting: false,
      };
    }

    const factRows = await this.sql<{ source_entity_id: number | string; predicate: string; target_entity_id: number | string }[]>`
      SELECT source_entity_id, predicate, target_entity_id
      FROM fact_edges
      WHERE id = ${parsed.id}
      LIMIT 1
    `;
    if (factRows.length === 0) {
      return null;
    }

    return {
      nodeRef: makeNodeRef("fact", parsed.id),
      scope: "world",
      content: `${Number(factRows[0].source_entity_id)} ${factRows[0].predicate} ${Number(factRows[0].target_entity_id)}`,
      removeExisting: false,
    };
  }
}
