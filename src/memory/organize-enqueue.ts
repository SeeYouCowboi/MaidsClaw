import type { JobPersistence } from "../jobs/persistence.js";
import { JOB_MAX_ATTEMPTS } from "../jobs/types.js";
import type { NodeRef } from "./types.js";

/**
 * Default chunk size for organizing node refs into jobs.
 * Each chunk contains up to this many node refs.
 */
export const ORGANIZER_CHUNK_SIZE = 50;

/**
 * Enqueue organizer jobs for the given changed node refs.
 * Chunks the refs into groups of `chunkSize` (default 50) and creates
 * a durable job for each chunk.
 *
 * Job ID format: `memory.organize:${settlementId}:chunk:${ordinal}`
 * where ordinal is 1-based, zero-padded to 4 digits (0001, 0002, etc.)
 *
 * Errors from `jobPersistence.enqueue()` are NOT caught - they propagate
 * to the caller. This is intentional to allow callers to decide error
 * handling policy (e.g., strictDurableMode vs fallback).
 *
 * @param jobPersistence - The job persistence interface for enqueueing
 * @param agentId - The agent ID to include in job payload
 * @param settlementId - The settlement ID (used in job IDs)
 * @param changedNodeRefs - The node refs that changed and need organizing
 * @param chunkSize - Optional chunk size override (default: ORGANIZER_CHUNK_SIZE)
 */
export async function enqueueOrganizerJobs(
  jobPersistence: JobPersistence,
  agentId: string,
  settlementId: string,
  changedNodeRefs: NodeRef[],
  chunkSize: number = ORGANIZER_CHUNK_SIZE,
): Promise<void> {
  const uniqueNodeRefs = Array.from(new Set(changedNodeRefs));
  if (uniqueNodeRefs.length === 0) {
    return;
  }

  const chunkCount = Math.ceil(uniqueNodeRefs.length / chunkSize);
  const now = Date.now();

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * chunkSize;
    const chunkNodeRefs = uniqueNodeRefs.slice(start, start + chunkSize);
    if (chunkNodeRefs.length === 0) {
      continue;
    }

    const ordinal = String(chunkIndex + 1).padStart(4, "0");

    // Let errors propagate - caller decides how to handle
    await jobPersistence.enqueue({
      id: `memory.organize:${settlementId}:chunk:${ordinal}`,
      jobType: "memory.organize",
      payload: {
        agentId,
        chunkNodeRefs,
        settlementId,
      },
      status: "pending",
      maxAttempts: JOB_MAX_ATTEMPTS["memory.organize"],
      nextAttemptAt: now,
    });
  }
}
