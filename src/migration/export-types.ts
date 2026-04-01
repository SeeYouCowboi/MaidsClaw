/**
 * Shared JSONL export format types used by both the (now-removed) SQLite
 * exporter and the PG importer.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface ExportSurfaceConfig {
  /** Source table name */
  name: string;
  /** Columns containing JSON-encoded TEXT → parse to objects */
  jsonColumns?: readonly string[];
  /** Columns containing BLOB data → encode as base64 */
  blobColumns?: readonly string[];
}

export interface SurfaceExportResult {
  name: string;
  row_count: number;
  /** SHA-256 hash of the JSONL file content, prefixed with "sha256:" */
  checksum: string;
  export_time_ms: number;
  jsonl_filename: string;
}

export interface ExportManifest {
  schema_version: string;
  exported_at: string;
  source_db: string;
  surfaces: SurfaceExportResult[];
}

export interface ExportOptions {
  dbPath: string;
  outDir: string;
  /** Optional surface filter — exports only these surfaces (all if omitted) */
  surfaces?: string[];
  /** Rows per page for streaming pagination (default: 1000) */
  pageSize?: number;
}

// ── Canonical surface definitions ────────────────────────────────────

// Order follows consensus §3.63: truth → operational → derived

export const EXPORT_SURFACES: readonly ExportSurfaceConfig[] = [
  // Truth tables
  { name: "settlement_processing_ledger" },
  { name: "private_episode_events" },
  { name: "private_cognition_events", jsonColumns: ["record_json"] },
  { name: "area_state_events", jsonColumns: ["value_json"] },
  { name: "world_state_events", jsonColumns: ["value_json"] },

  // Graph tables
  { name: "event_nodes" },
  { name: "entity_nodes" },
  { name: "entity_aliases" },
  { name: "pointer_redirects" },
  { name: "logic_edges" },
  { name: "fact_edges" },
  { name: "memory_relations" },

  // Topic & memory
  { name: "topics" },
  { name: "core_memory_blocks" },

  // Shared blocks
  { name: "shared_blocks" },
  { name: "shared_block_sections" },
  { name: "shared_block_admins" },
  { name: "shared_block_attachments" },
  { name: "shared_block_patch_log" },
  { name: "shared_block_snapshots", jsonColumns: ["content_json"] },

  // Operational
  { name: "interaction_records", jsonColumns: ["payload"] },
  { name: "sessions" },
  { name: "recent_cognition_slots", jsonColumns: ["slot_payload"] },

  // Derived
  { name: "node_embeddings", blobColumns: ["embedding"] },
  { name: "semantic_edges" },
  { name: "node_scores" },

  // Search docs (may not exist in all databases)
  { name: "search_docs_private" },
  { name: "search_docs_area" },
  { name: "search_docs_world" },
  { name: "search_docs_cognition" },
];
