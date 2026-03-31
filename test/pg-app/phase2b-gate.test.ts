// Domain Repositories Gate — verifies all PG repo implementations compile and are importable
// Does NOT require a running PG instance for module import checks

import { describe, it, expect } from "bun:test";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("Domain Repositories Gate", () => {
  it("exports PgSettlementLedgerRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/settlement-ledger-repo.js"
    );
    expect(typeof mod.PgSettlementLedgerRepo).toBe("function");
  });

  it("exports PgEpisodeRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/episode-repo.js"
    );
    expect(typeof mod.PgEpisodeRepo).toBe("function");
  });

  it("exports PgCognitionEventRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/cognition-event-repo.js"
    );
    expect(typeof mod.PgCognitionEventRepo).toBe("function");
  });

  it("exports PgCognitionProjectionRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/cognition-projection-repo.js"
    );
    expect(typeof mod.PgCognitionProjectionRepo).toBe("function");
  });

  it("exports PgAreaWorldProjectionRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/area-world-projection-repo.js"
    );
    expect(typeof mod.PgAreaWorldProjectionRepo).toBe("function");
  });

  it("exports PgInteractionRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/interaction-repo.js"
    );
    expect(typeof mod.PgInteractionRepo).toBe("function");
  });

  it("exports PgSessionRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/session-repo.js"
    );
    expect(typeof mod.PgSessionRepo).toBe("function");
  });

  it("exports PgRecentCognitionSlotRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js"
    );
    expect(typeof mod.PgRecentCognitionSlotRepo).toBe("function");
  });

  it("exports PgPendingFlushRecoveryRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/pending-flush-recovery-repo.js"
    );
    expect(typeof mod.PgPendingFlushRecoveryRepo).toBe("function");
  });

  it("exports PgGraphMutableStoreRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/graph-mutable-store-repo.js"
    );
    expect(typeof mod.PgGraphMutableStoreRepo).toBe("function");
  });

  it("exports PgCoreMemoryBlockRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/core-memory-block-repo.js"
    );
    expect(typeof mod.PgCoreMemoryBlockRepo).toBe("function");
  });

  it("exports PgSharedBlockRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/shared-block-repo.js"
    );
    expect(typeof mod.PgSharedBlockRepo).toBe("function");
  });

  it("exports PgSearchProjectionRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/search-projection-repo.js"
    );
    expect(typeof mod.PgSearchProjectionRepo).toBe("function");
  });

  it("exports PgEmbeddingRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/embedding-repo.js"
    );
    expect(typeof mod.PgEmbeddingRepo).toBe("function");
  });

  it("exports PgSemanticEdgeRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/semantic-edge-repo.js"
    );
    expect(typeof mod.PgSemanticEdgeRepo).toBe("function");
  });

  it("exports PgNodeScoreRepo", async () => {
    const mod = await import(
      "../../src/storage/domain-repos/pg/node-score-repo.js"
    );
    expect(typeof mod.PgNodeScoreRepo).toBe("function");
  });
});

describe.skipIf(skipPgTests)("Settlement UoW Gate", () => {
  it("exports PgSettlementUnitOfWork", async () => {
    const mod = await import("../../src/storage/pg-settlement-uow.js");
    expect(typeof mod.PgSettlementUnitOfWork).toBe("function");
  });
});

describe.skipIf(skipPgTests)("Migration Tools Gate", () => {
  it("exports sqlite-exporter utilities", async () => {
    const mod = await import("../../src/migration/sqlite-exporter.js");
    expect(typeof mod).toBe("object");
    expect(typeof mod.EXPORT_SURFACES).toBe("object");
  });

  it("exports pg-importer utilities", async () => {
    const mod = await import("../../src/migration/pg-importer.js");
    expect(typeof mod).toBe("object");
  });

  it("exports PgProjectionRebuilder", async () => {
    const mod = await import("../../src/migration/pg-projection-rebuild.js");
    expect(typeof mod.PgProjectionRebuilder).toBe("function");
  });
});
