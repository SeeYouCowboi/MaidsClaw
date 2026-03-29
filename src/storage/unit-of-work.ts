import type {
  AreaWorldProjectionRepo,
  CognitionEventRepo,
  CognitionProjectionRepo,
  EpisodeRepo,
  InteractionRepo,
  RecentCognitionSlotRepo,
  SettlementLedgerRepo,
} from "./domain-repos/contracts/index.js";

export interface SettlementUnitOfWork {
  run<T>(fn: (repos: SettlementRepos) => Promise<T>): Promise<T>;
}

export interface SettlementRepos {
  settlementLedger: SettlementLedgerRepo;
  episodeRepo: EpisodeRepo;
  cognitionEventRepo: CognitionEventRepo;
  cognitionProjectionRepo: CognitionProjectionRepo;
  areaWorldProjectionRepo: AreaWorldProjectionRepo;
  interactionRepo: InteractionRepo;
  recentCognitionSlotRepo: RecentCognitionSlotRepo;
}
