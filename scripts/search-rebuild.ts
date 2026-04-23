#!/usr/bin/env bun
import { parseArgs } from "node:util";
import postgres from "postgres";
import {
	PgSearchRebuilder,
	type PgSearchRebuildScope,
} from "../src/memory/search-rebuild-pg.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
	options: {
		agent: { type: "string" },
		scope: { type: "string", default: "all" },
		"pg-url": { type: "string" },
	},
  strict: true,
});

if (!values.agent) {
	console.error("Usage: bun run scripts/search-rebuild.ts --agent <agentId> [--scope all|private|area|world|cognition|episode] [--pg-url <url>]");
	process.exit(1);
}

const pgUrl = values["pg-url"] ?? process.env.PG_APP_URL;
if (!pgUrl) {
	console.error("Missing PG URL. Provide --pg-url <url> or set PG_APP_URL.");
	process.exit(1);
}

const scope = (values.scope ?? "all") as PgSearchRebuildScope;
const allowedScopes = new Set<PgSearchRebuildScope>([
	"all",
	"private",
	"area",
	"world",
	"cognition",
	"episode",
]);
if (!allowedScopes.has(scope)) {
	console.error(`Invalid --scope: ${String(values.scope)}. Allowed: all|private|area|world|cognition|episode`);
	process.exit(1);
}

const sql = postgres(pgUrl, { max: 1, onnotice() {} });
const rebuilder = new PgSearchRebuilder(sql);

try {
	console.log(`Search rebuild: agent=${values.agent}, scope=${scope}`);
	await rebuilder.rebuild({
		agentId: values.agent,
		scope,
	});
	console.log(
		"Search rebuild completed successfully (BM25 helper columns content_search_text/content_ngram_text/alias_text were regenerated).",
	);
} catch (err) {
	console.error("Search rebuild failed:", err instanceof Error ? err.message : err);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 });
}
