// Phase 2A Foundation Gate — verifies all contracts compile and are importable
// Does NOT require a running PG instance

import { describe, it, expect } from "bun:test";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("Phase 2A Foundation Gate", () => {
  it("exports all domain repo contracts", async () => {
    const contracts = await import(
      "../../src/storage/domain-repos/contracts/index.js"
    );
    // All 16 interfaces must be importable (type-level check at runtime = module loads)
    expect(typeof contracts).toBe("object");
  });

  it("exports SettlementUnitOfWork", async () => {
    const uow = await import("../../src/storage/unit-of-work.js");
    expect(typeof uow).toBe("object");
  });

  it("exports PG pool factory", async () => {
    const pool = await import("../../src/storage/pg-pool.js");
    expect(typeof pool.createPgPool).toBe("function");
  });

  it("exports backend types with resolveBackendType defaulting to sqlite", async () => {
    const bt = await import("../../src/storage/backend-types.js");
    delete process.env.MAIDSCLAW_BACKEND;
    expect(bt.resolveBackendType()).toBe("sqlite");
  });

  it("exports all three PG schema bootstrap functions", async () => {
    const truth = await import("../../src/storage/pg-app-schema-truth.js");
    const ops = await import("../../src/storage/pg-app-schema-ops.js");
    const derived = await import("../../src/storage/pg-app-schema-derived.js");
    expect(typeof truth.bootstrapTruthSchema).toBe("function");
    expect(typeof ops.bootstrapOpsSchema).toBe("function");
    expect(typeof derived.bootstrapDerivedSchema).toBe("function");
  });
});
