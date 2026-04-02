import type { JobPersistence } from "../../jobs/persistence.js";
import { JOB_MAX_ATTEMPTS } from "../../jobs/types.js";
import type { BackendType } from "../../storage/backend-types.js";

export class MaintenanceOrchestrationService {
	constructor(
		private readonly jobPersistence: JobPersistence,
		private readonly backendType: BackendType,
	) {}

	async searchRebuild(agentId: string, scope: string): Promise<void> {
		await this.jobPersistence.enqueue({
			id: `search.rebuild:${scope}:${agentId}:${Date.now()}`,
			jobType: "search.rebuild",
			payload: { agentId, scope },
			status: "pending",
			maxAttempts: JOB_MAX_ATTEMPTS["search.rebuild"],
		});
	}

	async replayProjection(surface: string): Promise<void> {
		await this.jobPersistence.enqueue({
			id: `maintenance.replay_projection:${surface}:${Date.now()}`,
			jobType: "maintenance.replay_projection",
			payload: { surface },
			status: "pending",
			maxAttempts: JOB_MAX_ATTEMPTS["maintenance.replay_projection"],
		});
	}

	async rebuildDerived(
		agentId: string,
		options?: { dryRun?: boolean; reEmbed?: boolean },
	): Promise<void> {
		await this.jobPersistence.enqueue({
			id: `maintenance.rebuild_derived:${agentId}:${Date.now()}`,
			jobType: "maintenance.rebuild_derived",
			payload: { agentId, ...options },
			status: "pending",
			maxAttempts: JOB_MAX_ATTEMPTS["maintenance.rebuild_derived"],
		});
	}

	async runFullMaintenance(): Promise<void> {
		await this.jobPersistence.enqueue({
			id: `maintenance.full:${Date.now()}`,
			jobType: "maintenance.full",
			payload: { backendType: this.backendType },
			status: "pending",
			maxAttempts: JOB_MAX_ATTEMPTS["maintenance.full"],
		});
	}
}
