import type postgres from "postgres";

type Row = Record<string, unknown>;
type ComparisonMode = "exact" | "semantic";

const PAGE_SIZE = 1000;
const DEFAULT_SAMPLE_MISMATCHES = 10;

type SurfaceConfig = {
  surface: string;
  sqliteTable: string;
  pgTable: string;
  keyColumns: string[];
  mode: ComparisonMode;
  compareColumns?: string[];
  excludeColumns?: string[];
  whereSql?: (nowMs: number) => string;
};

export type ParitySurfaceResult = {
  surface: string;
  sqliteCount: number;
  pgCount: number;
  countMatch: boolean;
  mismatches: Array<{ id?: unknown; field?: string; sqliteVal?: unknown; pgVal?: unknown }>;
  sampleMismatches: number;
  matchCount: number;
  mismatchCount: number;
};

export type ParityReport = {
  timestamp: number;
  surfaces: ParitySurfaceResult[];
  totalMismatches: number;
  passed: boolean;
};

const TRUTH_SURFACES: SurfaceConfig[] = [
  {
    surface: "settlement_processing_ledger",
    sqliteTable: "settlement_processing_ledger",
    pgTable: "settlement_processing_ledger",
    keyColumns: ["settlement_id"],
    mode: "exact",
  },
  {
    surface: "private_episode_events",
    sqliteTable: "private_episode_events",
    pgTable: "private_episode_events",
    keyColumns: ["settlement_id", "source_local_ref", "id"],
    mode: "exact",
  },
  {
    surface: "private_cognition_events",
    sqliteTable: "private_cognition_events",
    pgTable: "private_cognition_events",
    keyColumns: ["agent_id", "cognition_key", "committed_time", "id"],
    mode: "exact",
  },
  {
    surface: "area_state_events",
    sqliteTable: "area_state_events",
    pgTable: "area_state_events",
    keyColumns: ["agent_id", "area_id", "key", "committed_time", "id"],
    mode: "exact",
  },
  {
    surface: "world_state_events",
    sqliteTable: "world_state_events",
    pgTable: "world_state_events",
    keyColumns: ["key", "committed_time", "id"],
    mode: "exact",
  },
  {
    surface: "event_nodes",
    sqliteTable: "event_nodes",
    pgTable: "event_nodes",
    keyColumns: ["id"],
    mode: "exact",
  },
  {
    surface: "entity_nodes",
    sqliteTable: "entity_nodes",
    pgTable: "entity_nodes",
    keyColumns: ["pointer_key", "memory_scope", "owner_agent_id", "id"],
    mode: "exact",
  },
  {
    surface: "entity_aliases",
    sqliteTable: "entity_aliases",
    pgTable: "entity_aliases",
    keyColumns: ["canonical_id", "alias", "owner_agent_id", "alias_type", "id"],
    mode: "exact",
  },
  {
    surface: "fact_edges",
    sqliteTable: "fact_edges",
    pgTable: "fact_edges",
    keyColumns: ["source_entity_id", "target_entity_id", "predicate", "source_event_id", "id"],
    mode: "exact",
    whereSql: (nowMs) => `t_invalid > ${Math.floor(nowMs)}`,
  },
  {
    surface: "memory_relations",
    sqliteTable: "memory_relations",
    pgTable: "memory_relations",
    keyColumns: ["source_node_ref", "target_node_ref", "relation_type", "source_kind", "source_ref"],
    mode: "exact",
  },
  {
    surface: "core_memory_blocks",
    sqliteTable: "core_memory_blocks",
    pgTable: "core_memory_blocks",
    keyColumns: ["agent_id", "label"],
    mode: "exact",
  },
];

const CURRENT_PROJECTION_SURFACES: SurfaceConfig[] = [
  {
    surface: "private_cognition_current",
    sqliteTable: "private_cognition_current",
    pgTable: "private_cognition_current",
    keyColumns: ["agent_id", "cognition_key", "kind"],
    mode: "semantic",
    excludeColumns: ["id"],
  },
  {
    surface: "area_state_current",
    sqliteTable: "area_state_current",
    pgTable: "area_state_current",
    keyColumns: ["agent_id", "area_id", "key"],
    mode: "semantic",
  },
  {
    surface: "world_state_current",
    sqliteTable: "world_state_current",
    pgTable: "world_state_current",
    keyColumns: ["key"],
    mode: "semantic",
  },
];

export class TruthParityVerifier {
  private readonly snapshotMs = Date.now();

  constructor(
    private sqliteDb: import("bun:sqlite").Database,
    private pgSql: postgres.Sql,
  ) {}

  async verifyTruthPlane(): Promise<ParitySurfaceResult[]> {
    return this.verifySurfaces(TRUTH_SURFACES);
  }

  async verifyCurrentProjection(): Promise<ParitySurfaceResult[]> {
    return this.verifySurfaces(CURRENT_PROJECTION_SURFACES);
  }

  async generateReport(): Promise<ParityReport> {
    const truth = await this.verifyTruthPlane();
    const projection = await this.verifyCurrentProjection();
    const surfaces = [...truth, ...projection];
    const totalMismatches = surfaces.reduce((sum, surface) => sum + surface.mismatchCount, 0);

    return {
      timestamp: Date.now(),
      surfaces,
      totalMismatches,
      passed: totalMismatches === 0,
    };
  }

  private async verifySurfaces(configs: SurfaceConfig[]): Promise<ParitySurfaceResult[]> {
    const results: ParitySurfaceResult[] = [];
    for (const config of configs) {
      results.push(await this.compareSurface(config));
    }
    return results;
  }

  private async compareSurface(config: SurfaceConfig): Promise<ParitySurfaceResult> {
    const sqliteExists = this.sqliteTableExists(config.sqliteTable);
    const pgExists = await this.pgTableExists(config.pgTable);

    if (!sqliteExists || !pgExists) {
      return this.compareMissingTableSurface(config, sqliteExists, pgExists);
    }

    const whereSql = config.whereSql?.(this.snapshotMs);
    const sqliteCount = this.sqliteCount(config.sqliteTable, whereSql);
    const pgCount = await this.pgCount(config.pgTable, whereSql);

    const sqliteColumns = this.sqliteColumns(config.sqliteTable);
    const pgColumns = await this.pgColumns(config.pgTable);
    const commonColumns = intersect(sqliteColumns, pgColumns);

    const compareColumns = (
      config.compareColumns
      ?? commonColumns.filter((column) => !config.excludeColumns?.includes(column))
    ).filter((column) => commonColumns.includes(column));

    const result: ParitySurfaceResult = {
      surface: config.surface,
      sqliteCount,
      pgCount,
      countMatch: sqliteCount === pgCount,
      mismatches: [],
      sampleMismatches: 0,
      matchCount: 0,
      mismatchCount: 0,
    };

    const sqliteReader = this.createSqliteReader(config.sqliteTable, config.keyColumns, whereSql);
    const pgReader = this.createPgReader(config.pgTable, config.keyColumns, whereSql);

    let sqliteRow = await sqliteReader.next();
    let pgRow = await pgReader.next();

    while (sqliteRow || pgRow) {
      if (!sqliteRow && pgRow) {
        this.recordMismatch(result, {
          id: this.makeRowKeyObject(pgRow, config.keyColumns),
          field: "__row__",
          sqliteVal: null,
          pgVal: "extra row in PG",
        });
        pgRow = await pgReader.next();
        continue;
      }

      if (sqliteRow && !pgRow) {
        this.recordMismatch(result, {
          id: this.makeRowKeyObject(sqliteRow, config.keyColumns),
          field: "__row__",
          sqliteVal: "row exists in SQLite",
          pgVal: null,
        });
        sqliteRow = await sqliteReader.next();
        continue;
      }

      if (!sqliteRow || !pgRow) {
        break;
      }

      const keyCompare = compareKeyTuple(
        this.rowKeyTuple(sqliteRow, config.keyColumns),
        this.rowKeyTuple(pgRow, config.keyColumns),
      );

      if (keyCompare < 0) {
        this.recordMismatch(result, {
          id: this.makeRowKeyObject(sqliteRow, config.keyColumns),
          field: "__row__",
          sqliteVal: "row exists in SQLite",
          pgVal: null,
        });
        sqliteRow = await sqliteReader.next();
        continue;
      }

      if (keyCompare > 0) {
        this.recordMismatch(result, {
          id: this.makeRowKeyObject(pgRow, config.keyColumns),
          field: "__row__",
          sqliteVal: null,
          pgVal: "extra row in PG",
        });
        pgRow = await pgReader.next();
        continue;
      }

      let rowHasMismatch = false;
      for (const column of compareColumns) {
        const sqliteVal = sqliteRow[column];
        const pgVal = pgRow[column];
        if (!valuesEquivalent(sqliteVal, pgVal, config.mode)) {
          rowHasMismatch = true;
          this.recordMismatch(result, {
            id: this.makeRowKeyObject(sqliteRow, config.keyColumns),
            field: column,
            sqliteVal,
            pgVal,
          });
        }
      }

      if (!rowHasMismatch) {
        result.matchCount += 1;
      }

      sqliteRow = await sqliteReader.next();
      pgRow = await pgReader.next();
    }

    result.sampleMismatches = result.mismatches.length;
    return result;
  }

  private compareMissingTableSurface(
    config: SurfaceConfig,
    sqliteExists: boolean,
    pgExists: boolean,
  ): ParitySurfaceResult {
    const whereSql = config.whereSql?.(this.snapshotMs);
    const sqliteCount = sqliteExists ? this.sqliteCount(config.sqliteTable, whereSql) : 0;

    const result: ParitySurfaceResult = {
      surface: config.surface,
      sqliteCount,
      pgCount: 0,
      countMatch: sqliteExists === pgExists,
      mismatches: [],
      sampleMismatches: 0,
      matchCount: 0,
      mismatchCount: 0,
    };

    if (!sqliteExists && !pgExists) {
      return result;
    }

    if (!pgExists) {
      console.warn(
        `[parity-verify] skipping surface "${config.surface}": PG table "${config.pgTable}" missing in current schema.`,
      );
      return result;
    }

    const summary = {
      sqliteTable: config.sqliteTable,
      sqliteExists,
      pgTable: config.pgTable,
      pgExists,
    };

    const extraRows = Math.max(sqliteCount, 1);
    for (let index = 0; index < extraRows; index += 1) {
      this.recordMismatch(result, {
        id: summary,
        field: "__table__",
        sqliteVal: sqliteExists ? "table exists" : "table missing",
        pgVal: pgExists ? "table exists" : "table missing",
      });
    }

    result.sampleMismatches = result.mismatches.length;
    return result;
  }

  private createSqliteReader(table: string, keyColumns: string[], whereSql?: string): {
    next: () => Promise<Row | null>;
  } {
    const orderSql = keyColumns.map(quoteIdentifier).join(", ");
    const query = `SELECT * FROM ${quoteIdentifier(table)}${whereSql ? ` WHERE ${whereSql}` : ""} ORDER BY ${orderSql} LIMIT ? OFFSET ?`;
    const stmt = this.sqliteDb.query(query);

    let offset = 0;
    let page: Row[] = [];
    let index = 0;
    let done = false;

    return {
      next: async () => {
        while (index >= page.length && !done) {
          page = stmt.all(PAGE_SIZE, offset) as Row[];
          index = 0;
          offset += page.length;
          if (page.length < PAGE_SIZE) {
            done = true;
          }
        }

        if (index >= page.length) {
          return null;
        }

        const row = page[index];
        index += 1;
        return row;
      },
    };
  }

  private createPgReader(table: string, keyColumns: string[], whereSql?: string): {
    next: () => Promise<Row | null>;
  } {
    const orderSql = keyColumns.map(quoteIdentifier).join(", ");
    const baseQuery = `SELECT * FROM ${quoteIdentifier(table)}${whereSql ? ` WHERE ${whereSql}` : ""} ORDER BY ${orderSql}`;

    let offset = 0;
    let page: Row[] = [];
    let index = 0;
    let done = false;

    return {
      next: async () => {
        while (index >= page.length && !done) {
          const rows = await this.pgSql.unsafe(
            `${baseQuery} LIMIT $1 OFFSET $2`,
            [PAGE_SIZE, offset] as never[],
          );

          page = rows as Row[];
          index = 0;
          offset += page.length;
          if (page.length < PAGE_SIZE) {
            done = true;
          }
        }

        if (index >= page.length) {
          return null;
        }

        const row = page[index];
        index += 1;
        return row;
      },
    };
  }

  private sqliteTableExists(tableName: string): boolean {
    const row = this.sqliteDb
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName) as Record<string, unknown> | null;
    return row !== null;
  }

  private async pgTableExists(tableName: string): Promise<boolean> {
    const rows = await this.pgSql<{ reg: string | null }[]>`
      SELECT to_regclass(current_schema() || '.' || ${tableName}) AS reg
    `;
    return rows[0]?.reg != null;
  }

  private sqliteColumns(tableName: string): string[] {
    const rows = this.sqliteDb
      .query(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
      .all() as Array<{ name?: unknown }>;
    return rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string");
  }

  private async pgColumns(tableName: string): Promise<string[]> {
    const rows = await this.pgSql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${tableName}
      ORDER BY ordinal_position ASC
    `;

    return rows.map((row) => row.column_name);
  }

  private sqliteCount(tableName: string, whereSql?: string): number {
    const query = `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}${whereSql ? ` WHERE ${whereSql}` : ""}`;
    const row = this.sqliteDb.query(query).get() as { count?: unknown } | null;
    return toSafeNumber(row?.count ?? 0);
  }

  private async pgCount(tableName: string, whereSql?: string): Promise<number> {
    const query = `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(tableName)}${whereSql ? ` WHERE ${whereSql}` : ""}`;
    const rows = await this.pgSql.unsafe(query);
    const first = (rows as Array<{ count?: unknown }>)[0];
    return toSafeNumber(first?.count ?? 0);
  }

  private makeRowKeyObject(row: Row, keyColumns: string[]): Record<string, unknown> {
    const key: Record<string, unknown> = {};
    for (const keyColumn of keyColumns) {
      key[keyColumn] = row[keyColumn] ?? null;
    }
    return key;
  }

  private rowKeyTuple(row: Row, keyColumns: string[]): Array<string | number | null> {
    return keyColumns.map((keyColumn) => keyPrimitive(row[keyColumn]));
  }

  private recordMismatch(
    result: ParitySurfaceResult,
    mismatch: { id?: unknown; field?: string; sqliteVal?: unknown; pgVal?: unknown },
  ): void {
    result.mismatchCount += 1;
    if (result.mismatches.length < DEFAULT_SAMPLE_MISMATCHES) {
      result.mismatches.push(mismatch);
    }
  }
}

function quoteIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function keyPrimitive(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (typeof value === "string") {
    const maybeInt = maybeInteger(value);
    return maybeInt ?? value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return JSON.stringify(normalizeDeep(value));
}

function compareKeyTuple(
  left: Array<string | number | null>,
  right: Array<string | number | null>,
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? null;
    const b = right[index] ?? null;
    if (a === b) continue;
    if (a === null) return -1;
    if (b === null) return 1;

    if (typeof a === "number" && typeof b === "number") {
      return a < b ? -1 : 1;
    }

    const aText = String(a);
    const bText = String(b);
    if (aText < bText) return -1;
    if (aText > bText) return 1;
  }
  return 0;
}

function valuesEquivalent(left: unknown, right: unknown, mode: ComparisonMode): boolean {
  const normalizedLeft = normalizeForComparison(left, mode);
  const normalizedRight = normalizeForComparison(right, mode);
  return stableStringify(normalizedLeft) === stableStringify(normalizedRight);
}

function normalizeForComparison(value: unknown, mode: ComparisonMode): unknown {
  if (value == null) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }

  if (typeof value === "string") {
    const maybeIntValue = maybeInteger(value);
    if (maybeIntValue != null) {
      return maybeIntValue;
    }

    if (looksLikeJson(value)) {
      try {
        const parsed = JSON.parse(value) as unknown;
        return normalizeDeep(parsed);
      } catch {
        return value;
      }
    }

    return value;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForComparison(item, mode));
  }

  if (typeof value === "object") {
    return normalizeDeep(value);
  }

  return mode === "semantic" ? String(value) : value;
}

function normalizeDeep(value: unknown): unknown {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((item) => normalizeDeep(item));
  if (typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  const normalized: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    normalized[key] = normalizeDeep(record[key]);
  }
  return normalized;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeDeep(value));
}

function maybeInteger(value: string): number | null {
  if (!/^-?\d+$/.test(value)) {
    return null;
  }

  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    return null;
  }

  return asNumber;
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return false;
  }

  const startsWithObject = trimmed.startsWith("{") && trimmed.endsWith("}");
  const startsWithArray = trimmed.startsWith("[") && trimmed.endsWith("]");
  return startsWithObject || startsWithArray;
}

function toSafeNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : 0;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
