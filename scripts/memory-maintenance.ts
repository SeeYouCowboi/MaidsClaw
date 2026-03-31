#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createAppHost } from "../src/app/host/create-app-host.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    days: { type: "string", default: "30" },
    vacuum: { type: "boolean", default: false },
    report: { type: "boolean", default: false },
    "report-only": { type: "boolean", default: false },
    "integrity-check": { type: "boolean", default: false },
    backend: { type: "string", default: "sqlite" },
    "pg-url": { type: "string" },
  },
  strict: true,
});

if (values["pg-url"]) process.env.PG_APP_URL = values["pg-url"];
if (values.backend === "pg") process.env.MAIDSCLAW_BACKEND = "pg";

const host = await createAppHost({
  role: "maintenance",
  pgUrl: values["pg-url"],
});

try {
  await host.start();
  console.log("Running maintenance...");
  await host.maintenance!.runOnce();
  console.log("Maintenance completed successfully.");
} catch (err) {
  console.error("Maintenance failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await host.shutdown();
}
