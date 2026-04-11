import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("pg sessions list indexes", () => {
  it("defines deterministic session list indexes in bootstrap schema", () => {
    const schemaPath = resolve(import.meta.dir, "../../src/storage/pg-app-schema-ops.ts");
    const source = readFileSync(schemaPath, "utf8");

    expect(source.includes("idx_sessions_created_at_session_id_desc")).toBe(true);
    expect(source.includes("ON sessions(created_at DESC, session_id DESC)")).toBe(true);

    expect(source.includes("idx_sessions_agent_id_created_at_session_id_desc")).toBe(true);
    expect(source.includes("ON sessions(agent_id, created_at DESC, session_id DESC)")).toBe(true);
  });
});
