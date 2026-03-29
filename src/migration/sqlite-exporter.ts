/**
 * SQLite → JSONL export tool for database migration.
 *
 * Reads from an existing SQLite database and produces:
 * - A `manifest.json` describing all exported surfaces
 * - Per-surface `.jsonl` files (one JSON object per line)
 *
 * Streaming: rows are paginated (default 1000/page) — never loads
 * the entire table into memory.
 *
 * BLOB fields → base64 strings; JSON TEXT fields → parsed objects;
 * NULL → JSON null.
 */

import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

// ── Types ────────────────────────────────────────────────────────────

export interface ExportSurfaceConfig {
  /** SQLite table name */
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

  // Search docs (may not exist in all SQLite databases)
  { name: "search_docs_private" },
  { name: "search_docs_area" },
  { name: "search_docs_world" },
  { name: "search_docs_cognition" },
];

// ── SqliteExporter ───────────────────────────────────────────────────

export class SqliteExporter {
  private readonly db: Database;
  private readonly dbPath: string;
  private readonly outDir: string;
  private readonly pageSize: number;
  private readonly surfaceFilter: Set<string> | null;
  private readonly log: (msg: string) => void;

  constructor(options: ExportOptions, log?: (msg: string) => void) {
    this.dbPath = resolve(options.dbPath);
    this.db = new Database(this.dbPath, { readonly: true });
    this.outDir = resolve(options.outDir);
    this.pageSize = options.pageSize ?? 1000;
    this.surfaceFilter = options.surfaces ? new Set(options.surfaces) : null;
    this.log = log ?? console.log;
  }

  /**
   * Run the full export pipeline:
   * 1. Iterate surfaces in canonical order
   * 2. Stream each table's rows → JSONL file
   * 3. Write manifest.json
   *
   * @returns The export manifest
   */
  export(): ExportManifest {
    mkdirSync(this.outDir, { recursive: true });

    const surfaces = this.getActiveSurfaces();
    const results: SurfaceExportResult[] = [];

    for (const surface of surfaces) {
      results.push(this.exportSurface(surface));
    }

    const manifest: ExportManifest = {
      schema_version: "1.0.0",
      exported_at: new Date().toISOString(),
      source_db: this.dbPath,
      surfaces: results,
    };

    writeFileSync(
      join(this.outDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );

    return manifest;
  }

  close(): void {
    this.db.close();
  }

  // ── Private helpers ──────────────────────────────────────────────

  private getActiveSurfaces(): ExportSurfaceConfig[] {
    if (!this.surfaceFilter) return [...EXPORT_SURFACES];
    return EXPORT_SURFACES.filter((s) => this.surfaceFilter!.has(s.name));
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) as Record<string, unknown> | null;
    return row !== null;
  }

  private exportSurface(surface: ExportSurfaceConfig): SurfaceExportResult {
    const startTime = performance.now();
    const jsonlFilename = `${surface.name}.jsonl`;
    const jsonlPath = join(this.outDir, jsonlFilename);

    // Missing table → empty JSONL + warning
    if (!this.tableExists(surface.name)) {
      this.log(`[warn] Table "${surface.name}" not found — writing empty JSONL.`);
      writeFileSync(jsonlPath, "");
      return {
        name: surface.name,
        row_count: 0,
        checksum: `sha256:${hashEmpty()}`,
        export_time_ms: Math.round(performance.now() - startTime),
        jsonl_filename: jsonlFilename,
      };
    }

    // Create/truncate output file
    writeFileSync(jsonlPath, "");

    const hasher = createHash("sha256");
    let rowCount = 0;
    let offset = 0;

    // Pre-prepare paginated query (cached by bun:sqlite)
    const stmt = this.db.query(
      `SELECT * FROM "${surface.name}" ORDER BY rowid LIMIT ? OFFSET ?`,
    );

    // Stream rows page-by-page
    while (true) {
      const rows = stmt.all(this.pageSize, offset) as Record<string, unknown>[];

      if (rows.length === 0) break;

      let pageContent = "";
      for (const row of rows) {
        const processed = processRow(row, surface);
        const line = JSON.stringify(processed) + "\n";
        hasher.update(line);
        pageContent += line;
        rowCount++;
      }

      appendFileSync(jsonlPath, pageContent);
      offset += rows.length;

      // Last page — no need for another query
      if (rows.length < this.pageSize) break;
    }

    this.log(`[ok] Exported ${rowCount} rows from "${surface.name}".`);

    return {
      name: surface.name,
      row_count: rowCount,
      checksum: `sha256:${hasher.digest("hex")}`,
      export_time_ms: Math.round(performance.now() - startTime),
      jsonl_filename: jsonlFilename,
    };
  }
}

// ── Row processing ───────────────────────────────────────────────────

/**
 * Process a single row:
 * - BLOB columns → base64 strings
 * - JSON TEXT columns → parsed JSON objects
 * - NULL → null
 * - Everything else → pass through
 */
export function processRow(
  row: Record<string, unknown>,
  surface: ExportSurfaceConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const jsonCols = surface.jsonColumns;
  const blobCols = surface.blobColumns;

  for (const [key, value] of Object.entries(row)) {
    if (blobCols?.includes(key) && value instanceof Uint8Array) {
      // BLOB → base64
      result[key] = Buffer.from(value).toString("base64");
    } else if (jsonCols?.includes(key)) {
      // JSON TEXT → parsed object (NULL stays null)
      if (value === null) {
        result[key] = null;
      } else if (typeof value === "string") {
        try {
          result[key] = JSON.parse(value) as unknown;
        } catch {
          // Not valid JSON — keep as string
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    } else {
      // Default: pass through (NULL → null)
      result[key] = value ?? null;
    }
  }

  return result;
}

// ── Utilities ────────────────────────────────────────────────────────

function hashEmpty(): string {
  return createHash("sha256").update("").digest("hex");
}
