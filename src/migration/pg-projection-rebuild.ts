/**
 * PG Projection Rebuilder — rebuilds current truth projection tables
 * from append-only event ledger tables.
 *
 * Used after import to reconstruct derived state from the canonical
 * truth plane. Each rebuild method wraps its work in a transaction
 * for atomicity — if a replay fails mid-way, the current table is
 * restored to its pre-rebuild state (the transaction rolls back).
 *
 * Design choice: each rebuild opens its own transaction. This ensures
 * DELETE + replay is atomic per surface. The constructor takes a
 * pool-level postgres.Sql handle (not transaction-scoped).
 */

import type postgres from "postgres";
import type { CognitionEventRow } from "../memory/cognition/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../storage/domain-repos/pg/cognition-projection-repo.js";

function stringifyJsonbNullable(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export class PgProjectionRebuilder {
  constructor(private readonly sql: postgres.Sql) {}

  /**
   * Rebuild `private_cognition_current` from `private_cognition_events`.
   *
   * Cognition events have complex upsert/retract semantics per kind
   * (assertion, evaluation, commitment), so we replay row-by-row via
   * PgCognitionProjectionRepo.upsertFromEvent in committed_time order.
   *
   * @param agentId — optional; when given, rebuild only that agent's rows
   */
  async rebuildCognitionCurrent(agentId?: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const txSql = tx as unknown as postgres.Sql;
      const repo = new PgCognitionProjectionRepo(txSql);

      if (agentId) {
        await repo.rebuild(agentId);
      } else {
        await txSql`DELETE FROM private_cognition_current`;

        const rows = await txSql`
          SELECT id, agent_id, cognition_key, kind, op, record_json,
                 settlement_id, committed_time, created_at
          FROM private_cognition_events
          ORDER BY committed_time ASC, id ASC
        `;

        for (const row of rows) {
          const eventRow: CognitionEventRow = {
            id: Number(row.id),
            agent_id: row.agent_id as string,
            cognition_key: row.cognition_key as string,
            kind: row.kind as string,
            op: row.op as string,
            record_json: stringifyJsonbNullable(row.record_json),
            settlement_id: row.settlement_id as string,
            committed_time: Number(row.committed_time),
            created_at: Number(row.created_at),
          };
          await repo.upsertFromEvent(eventRow);
        }
      }
    });
  }

  /**
   * Rebuild `area_state_current` from `area_state_events`.
   *
   * Simple latest-per-key logic via INSERT SELECT with correlated
   * subquery: for each unique (agent_id, area_id, key), take the
   * event row with the highest (committed_time, id).
   *
   * @param agentId — optional agent filter
   * @param areaId  — optional area filter (requires agentId)
   */
  async rebuildAreaStateCurrent(agentId?: string, areaId?: number): Promise<void> {
    await this.sql.begin(async (tx) => {
      const txSql = tx as unknown as postgres.Sql;

      if (agentId != null && areaId != null) {
        await txSql`
          DELETE FROM area_state_current
          WHERE agent_id = ${agentId} AND area_id = ${areaId}
        `;
      } else if (agentId != null) {
        await txSql`
          DELETE FROM area_state_current WHERE agent_id = ${agentId}
        `;
      } else {
        await txSql`DELETE FROM area_state_current`;
      }

      if (agentId != null && areaId != null) {
        await txSql`
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
              SELECT e2.id FROM area_state_events e2
              WHERE e2.agent_id = e1.agent_id
                AND e2.area_id = e1.area_id
                AND e2.key = e1.key
              ORDER BY e2.committed_time DESC, e2.id DESC
              LIMIT 1
            )
        `;
      } else if (agentId != null) {
        await txSql`
          INSERT INTO area_state_current (
            agent_id, area_id, key, value_json, surfacing_classification,
            source_type, updated_at, valid_time, committed_time
          )
          SELECT e1.agent_id, e1.area_id, e1.key, e1.value_json,
                 e1.surfacing_classification, e1.source_type,
                 e1.committed_time AS updated_at, e1.valid_time, e1.committed_time
          FROM area_state_events e1
          WHERE e1.agent_id = ${agentId}
            AND e1.id = (
              SELECT e2.id FROM area_state_events e2
              WHERE e2.agent_id = e1.agent_id
                AND e2.area_id = e1.area_id
                AND e2.key = e1.key
              ORDER BY e2.committed_time DESC, e2.id DESC
              LIMIT 1
            )
        `;
      } else {
        await txSql`
          INSERT INTO area_state_current (
            agent_id, area_id, key, value_json, surfacing_classification,
            source_type, updated_at, valid_time, committed_time
          )
          SELECT e1.agent_id, e1.area_id, e1.key, e1.value_json,
                 e1.surfacing_classification, e1.source_type,
                 e1.committed_time AS updated_at, e1.valid_time, e1.committed_time
          FROM area_state_events e1
          WHERE e1.id = (
            SELECT e2.id FROM area_state_events e2
            WHERE e2.agent_id = e1.agent_id
              AND e2.area_id = e1.area_id
              AND e2.key = e1.key
            ORDER BY e2.committed_time DESC, e2.id DESC
            LIMIT 1
          )
        `;
      }
    });
  }

  /**
   * Rebuild `world_state_current` from `world_state_events`.
   *
   * Simple latest-per-key logic: for each unique key, take the
   * event row with the highest (committed_time, id).
   */
  async rebuildWorldStateCurrent(): Promise<void> {
    await this.sql.begin(async (tx) => {
      const txSql = tx as unknown as postgres.Sql;

      await txSql`DELETE FROM world_state_current`;

      await txSql`
        INSERT INTO world_state_current (
          key, value_json, surfacing_classification, updated_at,
          valid_time, committed_time
        )
        SELECT e1.key, e1.value_json, e1.surfacing_classification,
               e1.committed_time AS updated_at, e1.valid_time, e1.committed_time
        FROM world_state_events e1
        WHERE e1.id = (
          SELECT e2.id FROM world_state_events e2
          WHERE e2.key = e1.key
          ORDER BY e2.committed_time DESC, e2.id DESC
          LIMIT 1
        )
      `;
    });
  }

  /**
   * Rebuild all three projection tables in order:
   * cognition → area → world.
   *
   * Each surface runs in its own transaction.
   */
  async rebuildAll(): Promise<void> {
    await this.rebuildCognitionCurrent();
    await this.rebuildAreaStateCurrent();
    await this.rebuildWorldStateCurrent();
  }
}
