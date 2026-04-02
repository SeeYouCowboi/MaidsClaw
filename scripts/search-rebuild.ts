#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createAppHost } from "../src/app/host/create-app-host.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
	options: {
		agent: { type: "string" },
		scope: { type: "string", default: "all" },
		backend: { type: "string", default: "pg" },
		"pg-url": { type: "string" },
	},
  strict: true,
});

if (!values.agent) {
	console.error("Usage: bun run scripts/search-rebuild.ts --agent <agentId> [--scope all|private|area|world|cognition] [--backend pg] [--pg-url <url>]");
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
  const scope = values.scope ?? "all";
  console.log(`Search rebuild: agent=${values.agent}, scope=${scope}`);
  await host.maintenance!.searchRebuild!(values.agent, scope);
  console.log("Search rebuild completed successfully.");
} catch (err) {
  console.error("Search rebuild failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await host.shutdown();
}
