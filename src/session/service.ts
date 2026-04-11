import { decodeCursor, encodeCursor } from "../contracts/cockpit/cursor.js";
import { MaidsClawError } from "../core/errors.js";
import type { Db } from "../storage/db-types.js";
import type { SessionRepo } from "../storage/domain-repos/contracts/session-repo.js";

export type SessionRecord = {
  sessionId: string;
  createdAt: number;
  closedAt?: number;
  agentId: string;
};

export type SessionListStatus = "open" | "closed" | "recovery_required";

export type SessionListParams = {
  agentId?: string;
  status?: SessionListStatus;
  limit?: number;
  cursor?: string;
};

export type SessionListItem = {
  session_id: string;
  agent_id: string;
  created_at: number;
  closed_at?: number;
  status: SessionListStatus;
};

export type SessionListResult = {
  items: SessionListItem[];
  nextCursor: string | null;
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

type CursorBoundary = {
  createdAt: number;
  sessionId: string;
};

function clampListLimit(limit?: number): number {
  const value = Number.isFinite(limit) ? Math.floor(limit as number) : DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, value || DEFAULT_LIST_LIMIT));
}

function deriveStatus(closedAt: number | undefined, recoveryRequired: boolean): SessionListStatus {
  if (recoveryRequired) {
    return "recovery_required";
  }
  if (closedAt !== undefined) {
    return "closed";
  }
  return "open";
}

function compareByCreatedAtDescThenSessionIdDesc(a: SessionListItem, b: SessionListItem): number {
  if (a.created_at !== b.created_at) {
    return b.created_at - a.created_at;
  }
  return b.session_id.localeCompare(a.session_id);
}

function decodeCursorBoundary(cursor?: string): CursorBoundary | undefined {
  if (!cursor) {
    return undefined;
  }
  const payload = decodeCursor(cursor);
  if (typeof payload.sort_key !== "string") {
    throw new MaidsClawError({
      code: "BAD_REQUEST",
      message: "Cursor sort_key must be an ISO date string",
      retriable: false,
    });
  }
  const createdAt = Date.parse(payload.sort_key);
  if (!Number.isFinite(createdAt)) {
    throw new MaidsClawError({
      code: "BAD_REQUEST",
      message: "Cursor sort_key must be a valid ISO date string",
      retriable: false,
    });
  }
  return {
    createdAt,
    sessionId: payload.tie_breaker,
  };
}

function isBeforeCursor(item: SessionListItem, boundary?: CursorBoundary): boolean {
  if (!boundary) {
    return true;
  }
  if (item.created_at < boundary.createdAt) {
    return true;
  }
  if (item.created_at > boundary.createdAt) {
    return false;
  }
  return item.session_id < boundary.sessionId;
}

function buildPagedResult(items: SessionListItem[], limit: number): SessionListResult {
  const hasNext = items.length > limit;
  const pageItems = hasNext ? items.slice(0, limit) : items;
  let nextCursor: string | null = null;
  if (hasNext && pageItems.length > 0) {
    const last = pageItems[pageItems.length - 1];
    nextCursor = encodeCursor({
      v: 1,
      sort_key: new Date(last.created_at).toISOString(),
      tie_breaker: last.session_id,
    });
  }
  return { items: pageItems, nextCursor };
}

export class SessionService {
  private readonly pgRepo?: SessionRepo;
  private readonly db?: Db;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly recoveryRequired = new Set<string>();

  constructor(optionsOrDb?: { pgRepo: SessionRepo } | Db) {
    if (optionsOrDb && "pgRepo" in optionsOrDb) {
      this.pgRepo = optionsOrDb.pgRepo;
    } else {
      this.db = optionsOrDb as Db | undefined;
    }
  }

  private pgAvailable(): boolean {
    if (!this.pgRepo) return false;
    try {
      void (this.pgRepo as unknown as Record<string, unknown>).createSession;
      return true;
    } catch {
      return false;
    }
  }

  private pgRepoOrThrow(): SessionRepo {
    if (!this.pgRepo) {
      throw new MaidsClawError({
        code: "INTERNAL_ERROR",
        message: "PG session repo is unavailable",
        retriable: false,
      });
    }
    return this.pgRepo;
  }

  async createSession(agentId: string): Promise<SessionRecord> {
    if (this.pgAvailable()) {
      return this.pgRepoOrThrow().createSession(agentId);
    }

    const sessionId = crypto.randomUUID();
    const createdAt = Date.now();

    if (this.db) {
      this.db.run(
        "INSERT INTO sessions (session_id, agent_id, created_at, closed_at, recovery_required) VALUES (?, ?, ?, NULL, 0)",
        [sessionId, agentId, createdAt],
      );
      return {
        sessionId,
        createdAt,
        agentId,
      };
    }

    const record: SessionRecord = {
      sessionId,
      createdAt,
      agentId,
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  async listSessions(params: SessionListParams = {}): Promise<SessionListResult> {
    const limit = clampListLimit(params.limit);

    if (this.pgAvailable()) {
      return this.pgRepoOrThrow().listSessions({
        agentId: params.agentId,
        status: params.status,
        limit,
        cursor: params.cursor,
      });
    }

    const cursorBoundary = decodeCursorBoundary(params.cursor);

    if (this.db) {
      const rows = this.db.query<{
        session_id: string;
        agent_id: string;
        created_at: number;
        closed_at: number | null;
        recovery_required: number;
      }>(
        "SELECT session_id, agent_id, created_at, closed_at, recovery_required FROM sessions",
      );

      const items = rows
        .map<SessionListItem>((row) => {
          const closedAt = row.closed_at ?? undefined;
          return {
            session_id: row.session_id,
            agent_id: row.agent_id,
            created_at: Number(row.created_at),
            ...(closedAt !== undefined ? { closed_at: Number(closedAt) } : {}),
            status: deriveStatus(closedAt, row.recovery_required === 1),
          };
        })
        .filter((item) => (params.agentId ? item.agent_id === params.agentId : true))
        .filter((item) => (params.status ? item.status === params.status : true))
        .sort(compareByCreatedAtDescThenSessionIdDesc)
        .filter((item) => isBeforeCursor(item, cursorBoundary));

      return buildPagedResult(items, limit);
    }

    const items = Array.from(this.sessions.values())
      .map<SessionListItem>((record) => {
        const recoveryRequired = this.recoveryRequired.has(record.sessionId);
        return {
          session_id: record.sessionId,
          agent_id: record.agentId,
          created_at: record.createdAt,
          ...(record.closedAt !== undefined ? { closed_at: record.closedAt } : {}),
          status: deriveStatus(record.closedAt, recoveryRequired),
        };
      })
      .filter((item) => (params.agentId ? item.agent_id === params.agentId : true))
      .filter((item) => (params.status ? item.status === params.status : true))
      .sort(compareByCreatedAtDescThenSessionIdDesc)
      .filter((item) => isBeforeCursor(item, cursorBoundary));

    return buildPagedResult(items, limit);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    if (this.pgAvailable()) {
      return this.pgRepoOrThrow().getSession(sessionId);
    }

    if (this.db) {
      const row = this.db.get<{
        session_id: string;
        created_at: number;
        closed_at: number | null;
        agent_id: string;
      }>(
        "SELECT session_id, created_at, closed_at, agent_id FROM sessions WHERE session_id = ?",
        [sessionId],
      );
      if (!row) {
        return undefined;
      }
      return {
        sessionId: row.session_id,
        createdAt: row.created_at,
        closedAt: row.closed_at ?? undefined,
        agentId: row.agent_id,
      };
    }

    return this.sessions.get(sessionId);
  }

  async closeSession(sessionId: string): Promise<SessionRecord> {
    if (this.pgAvailable()) {
      return this.pgRepoOrThrow().closeSession(sessionId);
    }

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

    if (this.db) {
      this.db.run(
        "UPDATE sessions SET closed_at = ?, recovery_required = 0 WHERE session_id = ?",
        [closedAt, sessionId],
      );
    } else {
      record.closedAt = closedAt;
      this.recoveryRequired.delete(sessionId);
    }

    record.closedAt = closedAt;
    return record;
  }

  async isOpen(sessionId: string): Promise<boolean> {
    if (this.pgAvailable()) {
      return this.pgRepoOrThrow().isOpen(sessionId);
    }

    const record = await this.getSession(sessionId);
    if (!record) return false;
    return record.closedAt === undefined;
  }

  async markRecoveryRequired(sessionId: string): Promise<void> {
    if (this.pgAvailable()) {
      return this.pgRepoOrThrow().markRecoveryRequired(sessionId);
    }

    const session = await this.getSession(sessionId);
    if (!session) {
      throw new MaidsClawError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
        retriable: false,
        details: { sessionId },
      });
    }

    if (this.db) {
      this.db.run("UPDATE sessions SET recovery_required = 1 WHERE session_id = ?", [sessionId]);
      return;
    }

    this.recoveryRequired.add(sessionId);
  }

  /** @deprecated Use markRecoveryRequired instead */
  async setRecoveryRequired(sessionId: string): Promise<void> {
    await this.markRecoveryRequired(sessionId);
  }

  async clearRecoveryRequired(sessionId: string): Promise<void> {
    if (this.pgAvailable()) {
      return this.pgRepoOrThrow().clearRecoveryRequired(sessionId);
    }

    if (this.db) {
      this.db.run("UPDATE sessions SET recovery_required = 0 WHERE session_id = ?", [sessionId]);
      return;
    }

    this.recoveryRequired.delete(sessionId);
  }

  async requiresRecovery(sessionId: string): Promise<boolean> {
    if (this.pgAvailable()) {
      return this.pgRepoOrThrow().requiresRecovery(sessionId);
    }

    if (this.db) {
      const row = this.db.get<{ recovery_required: number }>(
        "SELECT recovery_required FROM sessions WHERE session_id = ?",
        [sessionId],
      );
      return row?.recovery_required === 1;
    }

    return this.recoveryRequired.has(sessionId);
  }

  /** @deprecated Use requiresRecovery instead */
  async isRecoveryRequired(sessionId: string): Promise<boolean> {
    return this.requiresRecovery(sessionId);
  }
}
