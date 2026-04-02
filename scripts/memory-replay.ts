#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createAppHost } from "../src/app/host/create-app-host.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    surface: { type: "string", default: "cognition" },
	backend: { type: "string", default: "pg" },
    "pg-url": { type: "string" },
  },
  strict: true,
});

const surface = values.surface ?? "cognition";
if (surface !== "cognition" && surface !== "area" && surface !== "world") {
  console.error(`Invalid --surface value: ${surface}. Must be cognition, area, or world.`);
  process.exit(1);
}

if (values["pg-url"]) process.env.PG_APP_URL = values["pg-url"];
if (values.backend === "pg") process.env.MAIDSCLAW_BACKEND = "pg";

const host = await createAppHost({
  role: "maintenance",
  pgUrl: values["pg-url"],
});

try {
  await host.start();
  console.log(`Replaying projection: surface=${surface}`);
  await host.maintenance!.replayProjection!(surface);
  console.log("Projection replay completed successfully.");
} catch (err) {
  console.error("Projection replay failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await host.shutdown();
}
