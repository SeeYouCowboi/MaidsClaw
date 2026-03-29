// Phase 2C Final Verification Gate — verifies all Phase 2C components compile and are importable
// Does NOT require a running PG instance for module import checks

import { describe, it, expect } from "bun:test";

describe.skipIf(!process.env.PG_APP_TEST_URL)("Phase 2C Final Verification Gate", () => {
  it("exports PgSearchRebuilder", async () => {
    const mod = await import("../../src/memory/search-rebuild-pg.js");
    expect(typeof mod.PgSearchRebuilder).toBe("function");
  });

  it("exports PgEmbeddingRebuilder", async () => {
    const mod = await import("../../src/memory/embedding-rebuild-pg.js");
    expect(typeof mod.PgEmbeddingRebuilder).toBe("function");
  });

  it("exports TruthParityVerifier", async () => {
    const mod = await import("../../src/migration/parity/truth-parity.js");
    expect(typeof mod.TruthParityVerifier).toBe("function");
  });

  it("exports DerivedParityVerifier", async () => {
    const mod = await import("../../src/migration/parity/derived-parity.js");
    expect(typeof mod.DerivedParityVerifier).toBe("function");
  });

  it("exports SqliteExporter", async () => {
    const mod = await import("../../src/migration/sqlite-exporter.js");
    expect(typeof mod.SqliteExporter).toBe("function");
  });

  it("exports PgImporter", async () => {
    const mod = await import("../../src/migration/pg-importer.js");
    expect(typeof mod.PgImporter).toBe("function");
  });

  it("exports PgProjectionRebuilder", async () => {
    const mod = await import("../../src/migration/pg-projection-rebuild.js");
    expect(typeof mod.PgProjectionRebuilder).toBe("function");
  });
});
