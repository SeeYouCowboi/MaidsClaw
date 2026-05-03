import type postgres from "postgres";
import { PgAreaWorldProjectionRepo } from "./domain-repos/pg/area-world-projection-repo.js";
import { PgCognitionEventRepo } from "./domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "./domain-repos/pg/cognition-projection-repo.js";
import { PgCoreMemoryBlockRepo } from "./domain-repos/pg/core-memory-block-repo.js";
import { PgEpisodeRepo } from "./domain-repos/pg/episode-repo.js";
import { PgGraphMutableStoreRepo } from "./domain-repos/pg/graph-mutable-store-repo.js";
import { PgInteractionRepo } from "./domain-repos/pg/interaction-repo.js";
import { PgPendingFlushRecoveryRepo } from "./domain-repos/pg/pending-flush-recovery-repo.js";
import { PgRecentCognitionSlotRepo } from "./domain-repos/pg/recent-cognition-slot-repo.js";
import { PgSearchProjectionRepo } from "./domain-repos/pg/search-projection-repo.js";
import { PgSessionRepo } from "./domain-repos/pg/session-repo.js";
import { PgSettlementLedgerRepo } from "./domain-repos/pg/settlement-ledger-repo.js";
import { PgUnresolvedWorldStateOpsRepo } from "./domain-repos/pg/unresolved-world-state-ops-repo.js";
import type { SettlementRepos, SettlementUnitOfWork } from "./unit-of-work.js";

export class PgSettlementUnitOfWork implements SettlementUnitOfWork {
	constructor(private readonly sql: postgres.Sql) {}

	run<T>(fn: (repos: SettlementRepos) => Promise<T>): Promise<T> {
		const buildRepos = (txSql: postgres.Sql): SettlementRepos => ({
			settlementLedger: new PgSettlementLedgerRepo(txSql),
			episodeRepo: new PgEpisodeRepo(txSql),
			cognitionEventRepo: new PgCognitionEventRepo(txSql),
			cognitionProjectionRepo: new PgCognitionProjectionRepo(txSql),
			areaWorldProjectionRepo: new PgAreaWorldProjectionRepo(txSql),
			interactionRepo: new PgInteractionRepo(txSql),
			sessionRepo: new PgSessionRepo(txSql),
			recentCognitionSlotRepo: new PgRecentCognitionSlotRepo(txSql),
			searchProjectionRepo: new PgSearchProjectionRepo(txSql),
			coreMemoryBlockRepo: new PgCoreMemoryBlockRepo(txSql),
			graphStoreRepo: new PgGraphMutableStoreRepo(txSql),
			unresolvedOpsRepo: new PgUnresolvedWorldStateOpsRepo(txSql),
			pendingFlushRecoveryRepo: new PgPendingFlushRecoveryRepo(txSql),
		});

		if (typeof (this.sql as unknown as { begin?: unknown }).begin !== "function") {
			return (async () => {
				await this.sql.unsafe("BEGIN");
				try {
					const result = await fn(buildRepos(this.sql));
					await this.sql.unsafe("COMMIT");
					return result;
				} catch (err) {
					try {
						await this.sql.unsafe("ROLLBACK");
					} catch {
						// Preserve the original error. withTestAppSchema drops the
						// reserved connection's schema after each case, so rollback
						// cleanup failures would only hide the real cause.
					}
					throw err;
				}
			})();
		}

		return this.sql.begin(async (tx) => {
			const txSql = tx as unknown as postgres.Sql;
			return fn(buildRepos(txSql));
		}) as Promise<T>;
	}
}
