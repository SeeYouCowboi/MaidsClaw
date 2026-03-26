import type { Db } from "../storage/database.js";
import type { PublicationRecoveryJobPayload } from "./publication-recovery-types.js";
import type { GraphStorageService } from "./storage.js";
import type { PublicEventCategory } from "./types.js";

const JOB_TYPE = "publication_recovery";
const PERIODIC_INTERVAL_MS = 30_000;
const TRANSIENT_BASE_BACKOFF_MS = 30_000;
const TRANSIENT_MAX_BACKOFF_MS = 15 * 60_000;
const DEFAULT_MAX_RETRIES = 5;

type JobStatus = "pending" | "retrying" | "reconciled" | "exhausted";

// PublicationRecoveryJobPayload imported from publication-recovery-types.ts

type PublicationRecoveryJobRow = {
  id: number;
  status: JobStatus;
  payload: string | null;
};

export class PublicationRecoverySweeper {
  private timer?: ReturnType<typeof setInterval>;
  private sweepInFlight = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly storage: GraphStorageService,
    private readonly options: {
      intervalMs?: number;
      maxRetries?: number;
      now?: () => number;
      random?: () => number;
    } = {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.stopped = false;
    this.sweep().catch((err) => {
      console.warn("[PublicationRecoverySweeper] initial sweep failed:", err);
    });

    const intervalMs = this.options.intervalMs ?? PERIODIC_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => {
        console.warn("[PublicationRecoverySweeper] sweep failed:", err);
      });
    }, intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  async sweep(): Promise<void> {
    if (this.sweepInFlight || this.stopped) {
      return;
    }

    this.sweepInFlight = true;
    try {
      const jobs = this.listDueJobs();
      for (const job of jobs) {
        if (this.stopped) {
          return;
        }
        try {
          this.processJob(job);
        } catch (err) {
          console.warn(`[PublicationRecoverySweeper] processJob(${job.id}) failed:`, err);
        }
      }
    } finally {
      this.sweepInFlight = false;
    }
  }

  private listDueJobs(): PublicationRecoveryJobRow[] {
    const now = this.now();
    return this.db.query<PublicationRecoveryJobRow>(
      `SELECT id, status, payload
       FROM _memory_maintenance_jobs
       WHERE job_type = ?
         AND status IN ('pending', 'retrying')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY updated_at ASC, id ASC`,
      [JOB_TYPE, now],
    );
  }

  private processJob(job: PublicationRecoveryJobRow): void {
    const now = this.now();
    const previous = this.readPayload(job.payload);
    if (!previous) {
      this.updateJob(job.id, "exhausted", {
        settlementId: "",
        pubIndex: -1,
        visibilityScope: "area_visible",
        sessionId: "",
        summary: "",
        timestamp: now,
        participants: "[]",
        locationEntityId: 1,
        eventCategory: "speech",
        failureCount: 1,
        lastAttemptAt: now,
        nextAttemptAt: null,
        lastErrorCode: "INVALID_PAYLOAD",
        lastErrorMessage: "Unable to parse publication recovery payload",
      });
      return;
    }

    const payload: PublicationRecoveryJobPayload = {
      ...previous,
      lastAttemptAt: now,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    };

    try {
      this.storage.createProjectedEvent({
        sessionId: payload.sessionId,
        summary: payload.summary,
        timestamp: payload.timestamp,
        participants: payload.participants,
        locationEntityId: payload.locationEntityId,
        eventCategory: payload.eventCategory,
        origin: "runtime_projection",
        visibilityScope: payload.visibilityScope,
        sourceSettlementId: payload.settlementId,
        sourcePubIndex: payload.pubIndex,
      });

      this.updateJob(job.id, "reconciled", {
        ...payload,
        nextAttemptAt: null,
      });
      return;
    } catch (error: unknown) {
      if (isSqliteUniqueConstraintError(error)) {
        this.updateJob(job.id, "reconciled", {
          ...payload,
          nextAttemptAt: null,
        });
        return;
      }

      const failureCount = payload.failureCount + 1;
      const errorCode = error instanceof Error ? error.name : null;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;

      if (failureCount >= maxRetries) {
        this.updateJob(job.id, "exhausted", {
          ...payload,
          failureCount,
          nextAttemptAt: null,
          lastErrorCode: errorCode,
          lastErrorMessage: errorMessage,
        });
        return;
      }

      const delayMs = this.calculateBackoffMs(failureCount, TRANSIENT_BASE_BACKOFF_MS, TRANSIENT_MAX_BACKOFF_MS);
      this.updateJob(job.id, "retrying", {
        ...payload,
        failureCount,
        nextAttemptAt: now + delayMs,
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
      });
    }
  }

  private updateJob(id: number, status: JobStatus, payload: PublicationRecoveryJobPayload): void {
    const now = this.now();
    this.db.run(
      `UPDATE _memory_maintenance_jobs
       SET status = ?, payload = ?, updated_at = ?, next_attempt_at = ?
       WHERE id = ?`,
      [status, JSON.stringify(payload), now, payload.nextAttemptAt, id],
    );
  }

  private readPayload(payload: string | null): PublicationRecoveryJobPayload | null {
    if (!payload) {
      return null;
    }

    try {
      const parsed = JSON.parse(payload) as Partial<PublicationRecoveryJobPayload>;
      if (
        typeof parsed.settlementId !== "string" ||
        typeof parsed.pubIndex !== "number" ||
        (parsed.visibilityScope !== "area_visible" && parsed.visibilityScope !== "world_public") ||
        typeof parsed.sessionId !== "string" ||
        typeof parsed.summary !== "string" ||
        typeof parsed.timestamp !== "number" ||
        typeof parsed.participants !== "string" ||
        typeof parsed.locationEntityId !== "number"
      ) {
        return null;
      }

      return {
        settlementId: parsed.settlementId,
        pubIndex: parsed.pubIndex,
        visibilityScope: parsed.visibilityScope,
        sessionId: parsed.sessionId,
        summary: parsed.summary,
        timestamp: parsed.timestamp,
        participants: parsed.participants,
        locationEntityId: parsed.locationEntityId,
        eventCategory:
          parsed.eventCategory === "speech" ||
          parsed.eventCategory === "action" ||
          parsed.eventCategory === "observation" ||
          parsed.eventCategory === "state_change"
            ? parsed.eventCategory
            : "speech",
        failureCount: typeof parsed.failureCount === "number" ? parsed.failureCount : 0,
        lastAttemptAt: typeof parsed.lastAttemptAt === "number" ? parsed.lastAttemptAt : 0,
        nextAttemptAt: typeof parsed.nextAttemptAt === "number" ? parsed.nextAttemptAt : null,
        lastErrorCode: typeof parsed.lastErrorCode === "string" ? parsed.lastErrorCode : null,
        lastErrorMessage: typeof parsed.lastErrorMessage === "string" ? parsed.lastErrorMessage : null,
      };
    } catch {
      return null;
    }
  }

  private calculateBackoffMs(failureCount: number, baseMs: number, maxMs: number): number {
    const attempt = Math.max(0, failureCount - 1);
    const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
    const jitterRange = exponential * 0.2;
    const jitter = Math.floor(jitterRange * this.random());
    return Math.min(maxMs, exponential - jitterRange + jitter);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private random(): number {
    return this.options.random?.() ?? Math.random();
  }
}

function isSqliteUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("unique constraint") || msg.includes("unique_constraint") || msg.includes("constraint failed");
  }
  return false;
}
