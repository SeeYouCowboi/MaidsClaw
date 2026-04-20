import type { AreaWorldProjectionRepo } from "../../storage/domain-repos/contracts/area-world-projection-repo.js";

export type SceneAreaFact = {
  factKey: string;
  value: unknown;
  sourceKind: string;
};

export type SceneWorldFact = {
  factKey: string;
  value: unknown;
  sourceKind: string;
};

export class SceneSearchService {
  constructor(
    private readonly areaWorldProjectionRepo: AreaWorldProjectionRepo,
  ) {}

  async getVisibleAreaFacts(
    sessionId: string,
    areaId: number,
  ): Promise<SceneAreaFact[]> {
    const rows = await this.areaWorldProjectionRepo.getVisibleAreaFacts({
      sessionId,
      areaId,
      excludeSystemOnly: true,
    });
    return rows.map((row) => ({
      factKey: row.factKey,
      value: row.valueJson,
      sourceKind: row.sourceKind,
    }));
  }

  async getVisibleWorldFacts(sessionId: string): Promise<SceneWorldFact[]> {
    const rows = await this.areaWorldProjectionRepo.getVisibleWorldFacts({
      sessionId,
      excludeSystemOnly: true,
    });
    return rows.map((row) => ({
      factKey: row.factKey,
      value: row.valueJson,
      sourceKind: row.sourceKind,
    }));
  }
}
