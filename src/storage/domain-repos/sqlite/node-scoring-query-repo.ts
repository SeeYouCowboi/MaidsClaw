import type { Database } from "bun:sqlite";
import { makeNodeRef } from "../../../memory/schema.js";
import type { NodeRef, NodeRefKind } from "../../../memory/types.js";
import type { Db } from "../../database.js";
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

function normalizeDbInput(db: Db | Database): Db {
  if (typeof (db as Db).query === "function" && typeof (db as Db).raw !== "undefined") {
    return db as Db;
  }
  const rawDb = db as Database;
  return {
    raw: rawDb,
    exec(sql: string): void {
      rawDb.exec(sql);
    },
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
      const stmt = rawDb.prepare(sql);
      return (params ? stmt.all(...(params as [])) : stmt.all()) as T[];
    },
    run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
      const stmt = rawDb.prepare(sql);
      const result = params ? stmt.run(...(params as [])) : stmt.run();
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
      const stmt = rawDb.prepare(sql);
      const result = params ? stmt.get(...(params as [])) : stmt.get();
      return result === null ? undefined : (result as T);
    },
    close(): void {
      rawDb.close();
    },
    transaction<T>(fn: () => T): T {
      return rawDb.transaction(fn)();
    },
    prepare(sql: string) {
      const stmt = rawDb.prepare(sql);
      return {
        run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
          const result = params.length > 0 ? stmt.run(...(params as [])) : stmt.run();
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        all(...params: unknown[]): unknown[] {
          return (params.length > 0 ? stmt.all(...(params as [])) : stmt.all()) as unknown[];
        },
        get(...params: unknown[]): unknown {
          const result = params.length > 0 ? stmt.get(...(params as [])) : stmt.get();
          return result === null ? undefined : result;
        },
      };
    },
  };
}

function parseAssertionProvenance(recordJson: string | null): string {
  if (!recordJson) {
    return "";
  }
  try {
    const parsed = JSON.parse(recordJson) as { provenance?: unknown };
    return typeof parsed.provenance === "string" ? parsed.provenance : "";
  } catch {
    return "";
  }
}

export class SqliteNodeScoringQueryRepo implements NodeScoringQueryRepo {
  private readonly db: Db;

  constructor(db: Db | Database) {
    this.db = normalizeDbInput(db);
  }

  async getNodeRenderingPayload(nodeRef: NodeRef): Promise<NodeRenderingPayload | null> {
    const parsed = parseNodeRef(nodeRef);
    if (!parsed) {
      return null;
    }

    if (parsed.kind === "entity") {
      const row = this.db.get<{ display_name: string; summary: string | null; entity_type: string }>(
        `SELECT display_name, summary, entity_type FROM entity_nodes WHERE id = ?`,
        [parsed.id],
      );
      if (!row) {
        return null;
      }
      return {
        nodeRef,
        nodeKind: parsed.kind,
        content: `${row.display_name} ${row.entity_type} ${row.summary ?? ""}`.trim(),
      };
    }

    if (parsed.kind === "event") {
      const row = this.db.get<{ summary: string | null; raw_text: string | null; event_category: string }>(
        `SELECT summary, raw_text, event_category FROM event_nodes WHERE id = ?`,
        [parsed.id],
      );
      if (!row) {
        return null;
      }
      return {
        nodeRef,
        nodeKind: parsed.kind,
        content: `${row.summary ?? ""} ${row.raw_text ?? ""} ${row.event_category}`.trim(),
      };
    }

    if (parsed.kind === "fact") {
      const row = this.db.get<{ source_entity_id: number; predicate: string; target_entity_id: number }>(
        `SELECT source_entity_id, predicate, target_entity_id FROM fact_edges WHERE id = ?`,
        [parsed.id],
      );
      if (!row) {
        return null;
      }
      return {
        nodeRef,
        nodeKind: parsed.kind,
        content: `${row.source_entity_id} ${row.predicate} ${row.target_entity_id}`,
      };
    }

    if (parsed.kind === "evaluation" || parsed.kind === "commitment") {
      const row = this.db.get<{ private_notes: string | null; summary_text: string | null; kind: string }>(
        `SELECT json_extract(record_json, '$.privateNotes') as private_notes, summary_text, kind
         FROM private_cognition_current
         WHERE id = ?`,
        [parsed.id],
      );
      if (!row) {
        return null;
      }
      return {
        nodeRef,
        nodeKind: parsed.kind,
        content: `${row.private_notes ?? ""} ${row.summary_text ?? ""} ${row.kind}`.trim(),
      };
    }

    const assertion = this.db.get<{ summary_text: string | null; record_json: string | null; stance: string | null }>(
      `SELECT summary_text, record_json, stance
       FROM private_cognition_current
       WHERE id = ? AND kind = 'assertion'`,
      [parsed.id],
    );
    if (!assertion) {
      return null;
    }

    const provenance = parseAssertionProvenance(assertion.record_json);
    return {
      nodeRef,
      nodeKind: parsed.kind,
      content: `${assertion.summary_text ?? ""} ${provenance} ${assertion.stance ?? ""}`.trim(),
    };
  }

  async getLatestNodeEmbedding(nodeRef: NodeRef): Promise<Float32Array | null> {
    const row = this.db.get<{ embedding: Buffer | Uint8Array }>(
      `SELECT embedding FROM node_embeddings WHERE node_ref = ? ORDER BY updated_at DESC LIMIT 1`,
      [nodeRef],
    );
    if (!row) {
      return null;
    }

    const bytes = row.embedding instanceof Uint8Array ? row.embedding : Buffer.from(row.embedding);
    const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Float32Array(view);
  }

  async registerGraphNodeShadows(nodes: NodeRef[], registeredAt = Date.now()): Promise<void> {
    try {
      const stmt = this.db.prepare(
        `INSERT INTO graph_nodes (node_kind, node_id, node_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (node_kind, node_id) DO UPDATE SET updated_at = excluded.updated_at`,
      );
      for (const nodeRef of nodes) {
        const parsed = parseNodeRef(nodeRef);
        if (!parsed) {
          continue;
        }
        stmt.run(parsed.kind, parsed.id, nodeRef, registeredAt, registeredAt);
      }
    } catch {
    }
  }

  async listSemanticNeighborWeights(nodeRef: NodeRef): Promise<SemanticNeighborWeight[]> {
    const rows = this.db.query<{ source_node_ref: string; target_node_ref: string; weight: number }>(
      `SELECT source_node_ref, target_node_ref, weight
       FROM semantic_edges
       WHERE source_node_ref = ? OR target_node_ref = ?`,
      [nodeRef, nodeRef],
    );
    return rows.map((row) => ({
      nodeRef,
      neighborRef: (row.source_node_ref === nodeRef ? row.target_node_ref : row.source_node_ref) as NodeRef,
      weight: Number(row.weight),
    }));
  }

  async hasNodeScore(nodeRef: NodeRef): Promise<boolean> {
    const row = this.db.get<{ node_ref: string }>(`SELECT node_ref FROM node_scores WHERE node_ref = ? LIMIT 1`, [nodeRef]);
    return Boolean(row);
  }

  async getNodeRecencyTimestamp(nodeRef: NodeRef): Promise<number | null> {
    const parsed = parseNodeRef(nodeRef);
    if (!parsed) {
      return null;
    }

    if (parsed.kind === "entity") {
      const row = this.db.get<{ updated_at: number }>(`SELECT updated_at FROM entity_nodes WHERE id = ?`, [parsed.id]);
      return row?.updated_at ?? null;
    }

    if (parsed.kind === "event") {
      const row = this.db.get<{ created_at: number }>(`SELECT created_at FROM event_nodes WHERE id = ?`, [parsed.id]);
      return row?.created_at ?? null;
    }

    if (parsed.kind === "fact") {
      const row = this.db.get<{ t_created: number }>(`SELECT t_created FROM fact_edges WHERE id = ?`, [parsed.id]);
      return row?.t_created ?? null;
    }

    const row = this.db.get<{ updated_at: number }>(`SELECT updated_at FROM private_cognition_current WHERE id = ?`, [parsed.id]);
    return row?.updated_at ?? null;
  }

  async getEventLogicDegree(nodeRef: NodeRef): Promise<number> {
    const parsed = parseNodeRef(nodeRef);
    if (!parsed || parsed.kind !== "event") {
      return 0;
    }

    const row = this.db.get<{ degree: number }>(
      `SELECT (SELECT count(*) FROM logic_edges WHERE source_event_id = ?) +
              (SELECT count(*) FROM logic_edges WHERE target_event_id = ?) as degree`,
      [parsed.id, parsed.id],
    );
    return row?.degree ?? 0;
  }

  async getNodeTopicCluster(nodeRef: NodeRef): Promise<number | null> {
    const parsed = parseNodeRef(nodeRef);
    if (!parsed) {
      return null;
    }

    if (parsed.kind === "event") {
      const row = this.db.get<{ topic_id: number | null }>(`SELECT topic_id FROM event_nodes WHERE id = ?`, [parsed.id]);
      return row?.topic_id ?? null;
    }

    if (parsed.kind === "evaluation" || parsed.kind === "commitment") {
      const row = this.db.get<{ topic_id: number | null }>(
        `SELECT e.topic_id
         FROM private_cognition_current c
         JOIN event_nodes e ON e.id = c.source_event_id
         WHERE c.id = ?`,
        [parsed.id],
      );
      return row?.topic_id ?? null;
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
      const row = this.db.get<{ summary: string | null; visibility_scope: string; location_entity_id: number }>(
        `SELECT summary, visibility_scope, location_entity_id FROM event_nodes WHERE id = ?`,
        [parsed.id],
      );
      if (!row || !row.summary) {
        return null;
      }
      if (row.visibility_scope === "area_visible") {
        return {
          nodeRef,
          scope: "area",
          content: row.summary,
          locationEntityId: row.location_entity_id,
          removeExisting: false,
        };
      }
      return {
        nodeRef,
        scope: "world",
        content: row.summary,
        removeExisting: false,
      };
    }

    if (parsed.kind === "entity") {
      const row = this.db.get<{
        display_name: string;
        summary: string | null;
        memory_scope: "shared_public" | "private_overlay";
        owner_agent_id: string | null;
      }>(
        `SELECT display_name, summary, memory_scope, owner_agent_id FROM entity_nodes WHERE id = ?`,
        [parsed.id],
      );
      if (!row) {
        return null;
      }

      const content = `${row.display_name} ${row.summary ?? ""}`.trim();
      if (row.memory_scope === "private_overlay") {
        return {
          nodeRef,
          scope: "private",
          content,
          agentId: row.owner_agent_id ?? fallbackAgentId,
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
      const row = this.db.get<{ private_notes: string | null; summary_text: string | null; agent_id: string; status: string | null }>(
        `SELECT json_extract(record_json, '$.privateNotes') as private_notes, summary_text, agent_id, status
         FROM private_cognition_current
         WHERE id = ?`,
        [parsed.id],
      );
      if (!row) {
        return null;
      }
      if (row.status === "retracted") {
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
        content: `${row.private_notes ?? ""} ${row.summary_text ?? ""}`.trim(),
        agentId: row.agent_id,
        removeExisting: false,
      };
    }

    if (parsed.kind === "assertion") {
      const row = this.db.get<{ summary_text: string | null; record_json: string | null; agent_id: string; stance: string | null }>(
        `SELECT summary_text, record_json, agent_id, stance
         FROM private_cognition_current
         WHERE id = ? AND kind = 'assertion'`,
        [parsed.id],
      );
      if (!row) {
        return null;
      }

      if (row.stance === "rejected" || row.stance === "abandoned") {
        return {
          nodeRef,
          scope: "private",
          removeExisting: true,
          reason: row.stance,
        };
      }

      const provenance = parseAssertionProvenance(row.record_json);
      return {
        nodeRef,
        scope: "private",
        content: `${row.summary_text ?? ""} ${provenance}`.trim(),
        agentId: row.agent_id,
        removeExisting: false,
      };
    }

    const factRow = this.db.get<{ source_entity_id: number; predicate: string; target_entity_id: number }>(
      `SELECT source_entity_id, predicate, target_entity_id FROM fact_edges WHERE id = ?`,
      [parsed.id],
    );
    if (!factRow) {
      return null;
    }

    return {
      nodeRef: makeNodeRef("fact", parsed.id),
      scope: "world",
      content: `${factRow.source_entity_id} ${factRow.predicate} ${factRow.target_entity_id}`,
      removeExisting: false,
    };
  }
}
