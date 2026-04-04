import type {
	AreaWorldProjectionRepo,
	CognitionEventRepo,
	CognitionProjectionRepo,
	CoreMemoryBlockRepo,
	EpisodeRepo,
	GraphMutableStoreRepo,
	InteractionRepo,
	PendingFlushRecoveryRepo,
	RecentCognitionSlotRepo,
	SearchProjectionRepo,
	SessionRepo,
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
	sessionRepo: SessionRepo;
	recentCognitionSlotRepo: RecentCognitionSlotRepo;
	searchProjectionRepo: SearchProjectionRepo;
	coreMemoryBlockRepo: CoreMemoryBlockRepo;
	graphStoreRepo: GraphMutableStoreRepo;
	pendingFlushRecoveryRepo: PendingFlushRecoveryRepo;
}
