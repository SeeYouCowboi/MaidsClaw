import type { JobPersistence } from "../../jobs/persistence.js";
import type { BackendType } from "../../storage/backend-types.js";
import { isSqliteFreezeEnabled } from "../../storage/backend-types.js";
import type { MaintenanceOrchestrationService } from "./maintenance-orchestration-service.js";
import type { AppMaintenanceFacade } from "./types.js";

type DrainStatus = {
	draining: boolean;
	activeJobs: number;
	pendingJobs: number;
};

export class AppMaintenanceFacadeImpl implements AppMaintenanceFacade {
	private isDraining = false;

	constructor(
		private readonly orchestrationService: MaintenanceOrchestrationService,
		private readonly jobPersistence: JobPersistence,
		private readonly backendType: BackendType = "sqlite",
	) {}

	async runOnce(): Promise<void> {
		await this.orchestrationService.runFullMaintenance();
	}

	async drain(): Promise<void> {
		if (this.isDraining) {
			return;
		}

		if (this.backendType === "sqlite" && !isSqliteFreezeEnabled()) {
			process.env.MAIDSCLAW_SQLITE_FREEZE = "true";
		}

		this.isDraining = true;
	}

	async getDrainStatus(): Promise<DrainStatus> {
		const [activeJobs, pendingJobs] = await Promise.all([
			this.jobPersistence.countByStatus("processing"),
			this.jobPersistence.countByStatus("pending"),
		]);

		return {
			draining: this.isDraining,
			activeJobs,
			pendingJobs,
		};
	}

	async searchRebuild(agentId: string, scope: string): Promise<void> {
		await this.orchestrationService.searchRebuild(agentId, scope);
	}

	async replayProjection(surface: string): Promise<void> {
		await this.orchestrationService.replayProjection(surface);
	}

	async rebuildDerived(
		agentId: string,
		options?: { dryRun?: boolean; reEmbed?: boolean },
	): Promise<void> {
		await this.orchestrationService.rebuildDerived(agentId, options);
	}
}
