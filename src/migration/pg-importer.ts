import { createReadStream, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type postgres from "postgres";
import { createPgPool } from "../storage/pg-pool.js";
import {
  EXPORT_SURFACES,
  type ExportManifest,
  type SurfaceExportResult,
} from "./export-types.js";

const DEFAULT_BATCH_SIZE = 1000;
const CHECKPOINT_FILENAME = ".import-checkpoint.json";

const KNOWN_SURFACES = new Set(EXPORT_SURFACES.map((surface) => surface.name));

const JSON_COLUMNS_BY_SURFACE = new Map(
  EXPORT_SURFACES.map((surface) => [surface.name, new Set(surface.jsonColumns ?? [])]),
);

const SEQUENCE_RESET_CANDIDATE_TABLES = [
  "settlement_processing_ledger",
  "private_episode_events",
  "private_cognition_events",
  "area_state_events",
  "world_state_events",
  "event_nodes",
  "entity_nodes",
  "entity_aliases",
  "pointer_redirects",
  "logic_edges",
  "fact_edges",
  "memory_relations",
  "topics",
  "core_memory_blocks",
  "shared_blocks",
  "shared_block_sections",
  "shared_block_admins",
  "shared_block_attachments",
  "shared_block_patch_log",
  "shared_block_snapshots",
  "interaction_records",
  "recent_cognition_slots",
  "pending_settlement_recovery",
  "node_embeddings",
  "semantic_edges",
  "node_scores",
  "search_docs_private",
  "search_docs_area",
  "search_docs_world",
  "search_docs_cognition",
] as const;

export interface PgImportOptions {
  manifestPath: string;
  pgUrl?: string;
  sql?: postgres.Sql;
  surface?: string;
  batchSize?: number;
  checkpointPath?: string;
}

export interface ImportSurfaceResult {
  name: string;
  row_count: number;
  imported_rows: number;
  resumed_from_row: number;
  import_time_ms: number;
}

export interface ImportCheckpoint {
  lastSurface: string | null;
  currentSurface: string | null;
  rowOffset: number;
  surfaces_completed: string[];
  updatedAt: string;
}

export interface PgImportResult {
  manifestPath: string;
  imported_at: string;
  surfaces: ImportSurfaceResult[];
  checkpointPath: string;
  sequence_tables_reset: string[];
}

function isSafeIdentifier(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(name);
}

function quoteIdentifier(name: string): string {
  if (!isSafeIdentifier(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function decodeBase64Vector(base64: string): string {
  const raw = Buffer.from(base64, "base64");
  if (raw.byteLength % 4 !== 0) {
    throw new Error(
      `Invalid embedding blob length (${raw.byteLength}); expected multiple of 4 bytes`,
    );
  }

  const copied = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const values = new Float32Array(copied);
  return `[${Array.from(values).join(",")}]`;
}

function defaultCheckpoint(): ImportCheckpoint {
  return {
    lastSurface: null,
    currentSurface: null,
    rowOffset: 0,
    surfaces_completed: [],
    updatedAt: new Date().toISOString(),
  };
}

export class PgImporter {
  private readonly sql: postgres.Sql;
  private readonly ownsPool: boolean;
  private readonly manifestPath: string;
  private readonly manifestDir: string;
  private readonly surfaceFilter: string | null;
  private readonly batchSize: number;
  private readonly checkpointPath: string;
  private readonly log: (msg: string) => void;

  constructor(options: PgImportOptions, log?: (msg: string) => void) {
    const { manifestPath, pgUrl, sql, surface, batchSize, checkpointPath } = options;

    if (!manifestPath) {
      throw new Error("manifestPath is required");
    }

    if ((pgUrl ? 1 : 0) + (sql ? 1 : 0) !== 1) {
      throw new Error("Provide exactly one of pgUrl or sql");
    }

    this.manifestPath = resolve(manifestPath);
    this.manifestDir = dirname(this.manifestPath);
    this.surfaceFilter = surface ?? null;
    this.batchSize = Math.max(1, batchSize ?? DEFAULT_BATCH_SIZE);
    this.checkpointPath = checkpointPath
      ? resolve(checkpointPath)
      : join(this.manifestDir, CHECKPOINT_FILENAME);
    this.log = log ?? console.log;

    if (sql) {
      this.sql = sql;
      this.ownsPool = false;
    } else {
      if (!pgUrl) {
        throw new Error("pgUrl is required when sql is not provided");
      }
      this.sql = createPgPool(pgUrl);
      this.ownsPool = true;
    }
  }

  async import(): Promise<PgImportResult> {
    const manifest = this.readManifest();
    const surfaces = this.selectSurfaces(manifest);

    let checkpoint = this.readCheckpoint();
    const completed = new Set(checkpoint.surfaces_completed);
    const results: ImportSurfaceResult[] = [];

    for (const surface of surfaces) {
      const start = performance.now();

      if (completed.has(surface.name)) {
        this.log(`[skip] ${surface.name} already completed in checkpoint.`);
        continue;
      }

      const resumeOffset =
        checkpoint.currentSurface === surface.name && checkpoint.rowOffset > 0
          ? checkpoint.rowOffset
          : 0;

      if (resumeOffset === 0) {
        await this.truncateSurface(surface.name);
      } else {
        this.log(`[resume] ${surface.name} from row offset ${resumeOffset}.`);
      }

      checkpoint = {
        ...checkpoint,
        currentSurface: surface.name,
        rowOffset: resumeOffset,
        updatedAt: new Date().toISOString(),
      };
      this.writeCheckpoint(checkpoint);

      const importedRows = await this.importSurfaceRows(surface, resumeOffset, checkpoint);

      completed.add(surface.name);
      checkpoint = {
        lastSurface: surface.name,
        currentSurface: null,
        rowOffset: 0,
        surfaces_completed: [...completed],
        updatedAt: new Date().toISOString(),
      };
      this.writeCheckpoint(checkpoint);

      results.push({
        name: surface.name,
        row_count: surface.row_count,
        imported_rows: importedRows,
        resumed_from_row: resumeOffset,
        import_time_ms: Math.round(performance.now() - start),
      });

      this.log(`[ok] Imported ${surface.name}: +${importedRows} rows`);
    }

    const sequenceTablesReset = await this.resetSequences();

    if (existsSync(this.checkpointPath)) {
      rmSync(this.checkpointPath, { force: true });
    }

    return {
      manifestPath: this.manifestPath,
      imported_at: new Date().toISOString(),
      surfaces: results,
      checkpointPath: this.checkpointPath,
      sequence_tables_reset: sequenceTablesReset,
    };
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.sql.end();
    }
  }

  private readManifest(): ExportManifest {
    if (!existsSync(this.manifestPath)) {
      throw new Error(`Manifest not found: ${this.manifestPath}`);
    }

    const raw = readFileSync(this.manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as ExportManifest;

    if (!parsed || !Array.isArray(parsed.surfaces)) {
      throw new Error(`Invalid manifest format: ${this.manifestPath}`);
    }

    for (const surface of parsed.surfaces) {
      if (!KNOWN_SURFACES.has(surface.name)) {
        throw new Error(`Unknown surface in manifest: ${surface.name}`);
      }
    }

    return parsed;
  }

  private selectSurfaces(manifest: ExportManifest): SurfaceExportResult[] {
    if (!this.surfaceFilter) {
      return manifest.surfaces;
    }

    const matches = manifest.surfaces.filter((surface) => surface.name === this.surfaceFilter);
    if (matches.length === 0) {
      throw new Error(`Surface not found in manifest: ${this.surfaceFilter}`);
    }
    return matches;
  }

  private readCheckpoint(): ImportCheckpoint {
    if (!existsSync(this.checkpointPath)) {
      return defaultCheckpoint();
    }

    const parsed = JSON.parse(readFileSync(this.checkpointPath, "utf-8")) as Partial<ImportCheckpoint>;
    return {
      lastSurface: parsed.lastSurface ?? null,
      currentSurface: parsed.currentSurface ?? null,
      rowOffset: Math.max(0, Number(parsed.rowOffset ?? 0)),
      surfaces_completed: Array.isArray(parsed.surfaces_completed)
        ? parsed.surfaces_completed.filter((item): item is string => typeof item === "string")
        : [],
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  }

  private writeCheckpoint(checkpoint: ImportCheckpoint): void {
    writeFileSync(this.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  }

  private async truncateSurface(surfaceName: string): Promise<void> {
    const table = quoteIdentifier(surfaceName);
    await this.sql.unsafe(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
  }

  private async importSurfaceRows(
    surface: SurfaceExportResult,
    startOffset: number,
    checkpoint: ImportCheckpoint,
  ): Promise<number> {
    const jsonlPath = join(this.manifestDir, surface.jsonl_filename);
    if (!existsSync(jsonlPath)) {
      throw new Error(`JSONL file not found for surface ${surface.name}: ${jsonlPath}`);
    }

    const stream = createReadStream(jsonlPath, { encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });

    const batch: Array<Record<string, unknown>> = [];
    let lineRows = 0;
    let imported = 0;

    try {
      for await (const line of reader) {
        if (line.trim().length === 0) {
          continue;
        }

        if (lineRows < startOffset) {
          lineRows += 1;
          continue;
        }

        const row = JSON.parse(line) as Record<string, unknown>;
        batch.push(row);
        lineRows += 1;

        if (batch.length >= this.batchSize) {
          await this.insertBatch(surface.name, batch);
          imported += batch.length;
          batch.length = 0;

          this.writeCheckpoint({
            ...checkpoint,
            currentSurface: surface.name,
            rowOffset: lineRows,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      if (batch.length > 0) {
        await this.insertBatch(surface.name, batch);
        imported += batch.length;

        this.writeCheckpoint({
          ...checkpoint,
          currentSurface: surface.name,
          rowOffset: lineRows,
          updatedAt: new Date().toISOString(),
        });
      }
    } finally {
      reader.close();
      stream.close();
    }

    return imported;
  }

  private async insertBatch(surfaceName: string, batch: Array<Record<string, unknown>>): Promise<void> {
    if (batch.length === 0) return;

    if (surfaceName === "node_embeddings") {
      await this.insertNodeEmbeddingsBatch(batch);
      return;
    }

    const first = batch[0];
    const columns = Object.keys(first);
    if (columns.length === 0) return;

    const preparedRows = batch.map((row) => this.prepareGenericRow(surfaceName, row, columns));
    const columnNames = columns as [string, ...string[]];

    await this.sql`
      INSERT INTO ${this.sql(surfaceName)}
      ${this.sql(preparedRows as never, ...columnNames)}
    `;
  }

  private prepareGenericRow(
    surfaceName: string,
    row: Record<string, unknown>,
    columns: string[],
  ): Record<string, unknown> {
    const jsonColumns = JSON_COLUMNS_BY_SURFACE.get(surfaceName) ?? new Set<string>();
    const prepared: Record<string, unknown> = {};

    for (const column of columns) {
      const value = row[column] ?? null;
      if (jsonColumns.has(column) && value !== null) {
        prepared[column] = this.sql.json(value as never);
      } else {
        prepared[column] = value;
      }
    }

    return prepared;
  }

  private async insertNodeEmbeddingsBatch(batch: Array<Record<string, unknown>>): Promise<void> {
    const columns = Object.keys(batch[0]);
    if (columns.length === 0) return;

    const table = quoteIdentifier("node_embeddings");
    const columnSql = columns.map((column) => quoteIdentifier(column)).join(", ");
    const valuesSql: string[] = [];
    const params: unknown[] = [];

    for (const row of batch) {
      const rowSql: string[] = [];

      for (const column of columns) {
        const rawValue = row[column] ?? null;
        const paramIndex = params.length + 1;

        if (column === "embedding") {
          if (typeof rawValue !== "string") {
            throw new Error("node_embeddings.embedding must be base64 string in JSONL");
          }
          params.push(decodeBase64Vector(rawValue));
          rowSql.push(`$${paramIndex}::vector`);
          continue;
        }

        params.push(rawValue);
        rowSql.push(`$${paramIndex}`);
      }

      valuesSql.push(`(${rowSql.join(", ")})`);
    }

    await this.sql.unsafe(
      `INSERT INTO ${table} (${columnSql}) VALUES ${valuesSql.join(", ")}`,
      params as never[],
    );
  }

  private async resetSequences(): Promise<string[]> {
    const resetTables: string[] = [];

    for (const tableName of SEQUENCE_RESET_CANDIDATE_TABLES) {
      const hasId = await this.sql<{ present: number }[]>`
        SELECT 1 AS present
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ${tableName}
          AND column_name = 'id'
        LIMIT 1
      `;
      if (hasId.length === 0) {
        continue;
      }

      const seqRows = await this.sql<{ seq: string | null }[]>`
        SELECT pg_get_serial_sequence(${tableName}, 'id') AS seq
      `;

      if (seqRows.length === 0 || !seqRows[0].seq) {
        continue;
      }

      await this.sql`
        SELECT setval(
          pg_get_serial_sequence(${tableName}, 'id'),
          COALESCE(MAX(id), 1)
        )
        FROM ${this.sql(tableName)}
      `;

      resetTables.push(tableName);
    }

    return resetTables;
  }
}
