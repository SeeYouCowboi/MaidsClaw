import type { MemoryPipelineStatus } from "../../bootstrap/types.js";
import type { SessionService } from "../../session/service.js";
import type { CoreMemoryBlockRepo } from "../../storage/domain-repos/contracts/core-memory-block-repo.js";
import type { InteractionRepo } from "../../storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../../storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import type { TraceStore } from "../diagnostics/trace-store.js";

export type InspectRuntimeDeps = {
  sessionService: Pick<SessionService, "getSession" | "requiresRecovery">;
  interactionRepo: InteractionRepo;
  coreMemoryBlockRepo: CoreMemoryBlockRepo;
  recentCognitionSlotRepo: RecentCognitionSlotRepo;
  memoryPipelineReady: boolean;
  memoryPipelineStatus: MemoryPipelineStatus;
  traceStore?: TraceStore;
};
