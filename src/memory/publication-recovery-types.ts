import type { PublicEventCategory } from "./types.js";

export type PublicationRecoveryJobPayload = {
  settlementId: string;
  pubIndex: number;
  visibilityScope: "area_visible" | "world_public";
  sessionId: string;
  failureCount: number;
  lastAttemptAt: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  summary: string;
  timestamp: number;
  participants: string;
  locationEntityId: number;
  eventCategory: PublicEventCategory;
};
