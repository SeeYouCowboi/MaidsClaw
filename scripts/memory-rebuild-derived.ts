#!/usr/bin/env bun
import { parseArgs } from "node:util";
import postgres from "postgres";
import { PgSearchRebuilder } from "../src/memory/search-rebuild-pg.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    agent: { type: "string" },
	"dry-run": { type: "boolean", default: false },
	"re-embed": { type: "boolean", default: false },
	"pg-url": { type: "string" },
  },
  strict: true,
});

if (!values.agent) {
	console.error("Usage: bun run scripts/memory-rebuild-derived.ts --agent <agentId> [--dry-run] [--re-embed] [--pg-url <url>]");
	process.exit(1);
}

const pgUrl = values["pg-url"] ?? process.env.PG_APP_URL;
if (!pgUrl) {
	console.error("Missing PG URL. Provide --pg-url <url> or set PG_APP_URL.");
	process.exit(1);
}

const dryRun = values["dry-run"];
const reEmbed = values["re-embed"];

const sql = postgres(pgUrl, { max: 1, onnotice() {} });
const searchRebuilder = new PgSearchRebuilder(sql);

try {
	console.log(`Rebuild derived: agent=${values.agent}, dryRun=${dryRun}, reEmbed=${reEmbed}`);

	if (dryRun) {
		console.log(
			"Dry-run: would execute BM25-aware search projection rebuild (scope=all), which regenerates content_search_text/content_ngram_text/alias_text helper columns.",
		);
		if (reEmbed) {
			console.log("Dry-run: would also trigger embedding refresh in the derived pipeline.");
		}
	} else {
		await searchRebuilder.rebuild({
			agentId: values.agent,
			scope: "all",
		});
		console.log(
			"Search projection rebuild completed (BM25 helper columns refreshed across private/area/world/cognition/episode).",
		);
		if (reEmbed) {
			console.log(
				"Note: --re-embed requested. Embedding refresh remains handled by the separate derived embedding workflow.",
			);
		}
	}

	console.log("Rebuild derived completed successfully.");
} catch (err) {
	console.error("Rebuild derived failed:", err instanceof Error ? err.message : err);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 });
}
