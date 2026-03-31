#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createAppHost } from "../src/app/host/create-app-host.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    agent: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "re-embed": { type: "boolean", default: false },
    backend: { type: "string", default: "sqlite" },
    "pg-url": { type: "string" },
  },
  strict: true,
});

if (!values.agent) {
  console.error("Usage: bun run scripts/memory-rebuild-derived.ts --agent <agentId> [--dry-run] [--re-embed] [--backend sqlite|pg] [--pg-url <url>]");
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
  console.log(`Rebuild derived: agent=${values.agent}, dryRun=${values["dry-run"]}, reEmbed=${values["re-embed"]}`);
  await host.maintenance!.rebuildDerived!(values.agent, {
    dryRun: values["dry-run"],
    reEmbed: values["re-embed"],
  });
  console.log("Rebuild derived completed successfully.");
} catch (err) {
  console.error("Rebuild derived failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await host.shutdown();
}
