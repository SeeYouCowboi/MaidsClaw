import { describe, it, expect, afterAll } from "bun:test";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import type { Story } from "../dsl/story-types.js";
import {
  bootstrapScenarioSchema,
  cleanupAllSchemas,
  type ScenarioInfra,
} from "./infra.js";

const MINIMAL_STORY: Story = {
  id: "infra_test",
  title: "Infra Bootstrap Test",
  description: "Minimal story for bootstrap testing",
  characters: [
    {
      id: "detective_rin",
      displayName: "Rin",
      entityType: "person",
      surfaceMotives: "Solve the case",
      hiddenCommitments: [],
      initialEvaluations: [],
      aliases: ["rin"],
    },
  ],
  locations: [
    {
      id: "library",
      displayName: "The Library",
      entityType: "location",
      visibilityScope: "area_visible",
    },
  ],
  clues: [
    {
      id: "torn_letter",
      displayName: "Torn Letter",
      entityType: "item",
      initialLocationId: "library",
      description: "A letter torn in half",
    },
  ],
  beats: [],
  probes: [],
};

describe.skipIf(skipPgTests)("ScenarioInfra bootstrap", () => {
  let infra: ScenarioInfra | undefined;

  afterAll(async () => {
    if (infra) {
      await infra._testDb.cleanup();
    }
  });

  it("bootstrap with phase:full creates entityIdMap and schema", async () => {
    infra = await bootstrapScenarioSchema(MINIMAL_STORY, {
      writePath: "settlement",
      phase: "full",
    });

    expect(infra.entityIdMap.size).toBeGreaterThanOrEqual(3);
    expect(infra.entityIdMap.has("detective_rin")).toBe(true);
    expect(infra.entityIdMap.has("library")).toBe(true);
    expect(infra.entityIdMap.has("torn_letter")).toBe(true);

    expect(infra.entityIdMap.has("__self__")).toBe(true);
    expect(infra.entityIdMap.has("__user__")).toBe(true);

    expect(typeof infra.entityIdMap.get("detective_rin")).toBe("number");
    expect(infra.schemaName.length).toBeGreaterThan(0);
    expect(infra.repos.graphStore).toBeDefined();
    expect(infra.services.navigator).toBeDefined();
  });

  it("bootstrap with phase:probe_only on non-existent schema throws", async () => {
    const probeStory: Story = {
      ...MINIMAL_STORY,
      id: "nonexistent_probe",
    };

    await expect(
      bootstrapScenarioSchema(probeStory, {
        writePath: "settlement",
        phase: "probe_only",
      }),
    ).rejects.toThrow("not found");
  });

  it("cleanupAllSchemas removes scenario schemas", async () => {
    if (!infra) {
      throw new Error("infra not initialized — test ordering issue");
    }
    const sql = infra.sql;

    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "scenario_cleanup_test_live"`);

    const before = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'scenario_cleanup_%'
    `;
    expect(before.length).toBeGreaterThan(0);

    await cleanupAllSchemas(sql);

    const after = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'scenario_cleanup_%'
    `;
    expect(after.length).toBe(0);
  });
});
