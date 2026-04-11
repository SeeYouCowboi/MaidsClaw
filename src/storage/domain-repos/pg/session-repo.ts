import type postgres from "postgres";
import { decodeCursor, encodeCursor } from "../../../contracts/cockpit/cursor.js";
import { MaidsClawError } from "../../../core/errors.js";
import type { SessionRecord } from "../../../session/service.js";
import type {
  SessionListItem,
  SessionListParams,
  SessionListResult,
  SessionRepo,
} from "../contracts/session-repo.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type SessionListRow = {
  session_id: string;
  agent_id: string;
  created_at: number | string;
  closed_at: number | string | null;
  recovery_required: number;
};

export class PgSessionRepo implements SessionRepo {
  private readonly sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  async createSession(agentId: string): Promise<SessionRecord> {
    const sessionId = crypto.randomUUID();
    const createdAt = Date.now();
    await this.sql`
      INSERT INTO sessions (session_id, agent_id, created_at, closed_at, recovery_required)
      VALUES (${sessionId}, ${agentId}, ${createdAt}, ${null}, 0)
    `;
    return { sessionId, createdAt, agentId };
  }

  async listSessions(params: SessionListParams): Promise<SessionListResult> {
    const requestedLimit = Number.isFinite(params.limit) ? Math.floor(params.limit) : DEFAULT_LIMIT;
    const effectiveLimit = Math.max(1, Math.min(MAX_LIMIT, requestedLimit || DEFAULT_LIMIT));

    let cursorSortKey: number | undefined;
    let cursorTieBreaker: string | undefined;
    if (params.cursor) {
      const payload = decodeCursor(params.cursor);
      if (typeof payload.sort_key !== "string") {
        throw new MaidsClawError({
          code: "BAD_REQUEST",
          message: "Cursor sort_key must be an ISO date string",
          retriable: false,
        });
      }
      const parsedTs = Date.parse(payload.sort_key);
      if (!Number.isFinite(parsedTs)) {
        throw new MaidsClawError({
          code: "BAD_REQUEST",
          message: "Cursor sort_key must be a valid ISO date string",
          retriable: false,
        });
      }
      cursorSortKey = parsedTs;
      cursorTieBreaker = payload.tie_breaker;
    }

    const rows = await this.sql<SessionListRow[]>`
      SELECT session_id, agent_id, created_at, closed_at, recovery_required
      FROM sessions
      WHERE (${params.agentId ?? null}::text IS NULL OR agent_id = ${params.agentId ?? null})
        AND (
          ${params.status ?? null}::text IS NULL
          OR (
            ${params.status ?? null}::text = 'recovery_required'
            AND recovery_required = 1
          )
          OR (
            ${params.status ?? null}::text = 'closed'
            AND recovery_required = 0
            AND closed_at IS NOT NULL
          )
          OR (
            ${params.status ?? null}::text = 'open'
            AND recovery_required = 0
            AND closed_at IS NULL
          )
        )
        AND (
          ${cursorSortKey ?? null}::bigint IS NULL
          OR (created_at, session_id) < (${cursorSortKey ?? null}::bigint, ${cursorTieBreaker ?? null}::text)
        )
      ORDER BY created_at DESC, session_id DESC
      LIMIT ${effectiveLimit + 1}
    `;

    const hasNext = rows.length > effectiveLimit;
    const pageRows = hasNext ? rows.slice(0, effectiveLimit) : rows;

    const items: SessionListItem[] = pageRows.map((row) => {
      const closedAt = row.closed_at == null ? undefined : Number(row.closed_at);
      const status = row.recovery_required === 1
        ? "recovery_required"
        : closedAt !== undefined
          ? "closed"
          : "open";
      return {
        session_id: row.session_id,
        agent_id: row.agent_id,
        created_at: Number(row.created_at),
        ...(closedAt !== undefined ? { closed_at: closedAt } : {}),
        status,
      };
    });

    let nextCursor: string | null = null;
    if (hasNext && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = encodeCursor({
        v: 1,
        sort_key: new Date(last.created_at).toISOString(),
        tie_breaker: last.session_id,
      });
    }

    return { items, nextCursor };
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const rows = await this.sql`
      SELECT session_id, created_at, closed_at, agent_id
      FROM sessions WHERE session_id = ${sessionId}
    `;
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      sessionId: row.session_id as string,
      createdAt: Number(row.created_at),
      closedAt: row.closed_at != null ? Number(row.closed_at) : undefined,
      agentId: row.agent_id as string,
    };
  }

  async closeSession(sessionId: string): Promise<SessionRecord> {
    const record = await this.getSession(sessionId);
    if (!record) {
      throw new MaidsClawError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
        retriable: false,
        details: { sessionId },
      });
    }
    const closedAt = Date.now();
    await this.sql`
      UPDATE sessions SET closed_at = ${closedAt}, recovery_required = 0
      WHERE session_id = ${sessionId}
    `;
    record.closedAt = closedAt;
    return record;
  }

  async isOpen(sessionId: string): Promise<boolean> {
    const record = await this.getSession(sessionId);
    if (!record) return false;
    return record.closedAt === undefined;
  }

  async markRecoveryRequired(sessionId: string): Promise<void> {
    const record = await this.getSession(sessionId);
    if (!record) {
      throw new MaidsClawError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
        retriable: false,
        details: { sessionId },
      });
    }
    await this.sql`
      UPDATE sessions SET recovery_required = 1 WHERE session_id = ${sessionId}
    `;
  }

  async setRecoveryRequired(sessionId: string): Promise<void> {
    return this.markRecoveryRequired(sessionId);
  }

  async clearRecoveryRequired(sessionId: string): Promise<void> {
    await this.sql`
      UPDATE sessions SET recovery_required = 0 WHERE session_id = ${sessionId}
    `;
  }

  async requiresRecovery(sessionId: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT recovery_required FROM sessions WHERE session_id = ${sessionId}
    `;
    return rows.length > 0 && rows[0].recovery_required === 1;
  }

  async isRecoveryRequired(sessionId: string): Promise<boolean> {
    return this.requiresRecovery(sessionId);
  }
}
