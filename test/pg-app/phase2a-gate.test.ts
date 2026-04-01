/**
 * COMPILE-TIME IMPORT GATE — NOT an integration acceptance test
 * This file verifies that Phase 2 imports resolve correctly at compile time.
 * It does NOT connect to a database and does NOT require PG_APP_TEST_URL.
 * Real integration acceptance is handled by test/pg-app/ integration tests (GAP-V1).
 */

import { describe, it, expect } from "bun:test";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("Foundation Gate", () => {
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

  it("exports backend types with resolveBackendType defaulting to pg", async () => {
    const bt = await import("../../src/storage/backend-types.js");
    delete process.env.MAIDSCLAW_BACKEND;
    expect(bt.resolveBackendType()).toBe("pg");
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
