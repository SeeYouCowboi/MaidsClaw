#!/usr/bin/env bun
import { openDatabase } from "../src/storage/database.js";
import { runMemoryMigrations } from "../src/memory/schema.js";
import { PrivateCognitionProjectionRepo } from "../src/memory/cognition/private-cognition-current.js";
import { AreaWorldProjectionRepo } from "../src/memory/projection/area-world-projection-repo.js";

type ReplaySurface = "cognition" | "area" | "world";

type CliArgs = {
  dbPath?: string;
  surface: ReplaySurface;
};

const args = parseArgs(process.argv.slice(2));
const dbPath = args.dbPath ?? process.env.MAIDSCLAW_DB_PATH;
if (!dbPath) {
  failWithUsage("Missing database path.");
}

const db = openDatabase({ path: dbPath });
runMemoryMigrations(db);

try {
  if (args.surface === "cognition") {
    replayCognitionSurface(db);
  } else if (args.surface === "area") {
    replayAreaSurface(db);
  } else {
    replayWorldSurface(db);
  }
} finally {
  db.close();
}

function replayCognitionSurface(dbHandle: ReturnType<typeof openDatabase>): void {
  const eventCount = dbHandle.get<{ count: number }>(
    "SELECT count(*) AS count FROM private_cognition_events",
  )?.count ?? 0;

  if (eventCount === 0) {
    console.log("No cognition events found — nothing to replay.");
    return;
  }

  const agentIds = (
    dbHandle.query<{ agent_id: string }>(
      "SELECT DISTINCT agent_id FROM private_cognition_events",
    ) as Iterable<{ agent_id: string }>
  );

  const repo = new PrivateCognitionProjectionRepo(dbHandle);

  let totalAgents = 0;
  for (const { agent_id } of agentIds) {
    const before = dbHandle.get<{ cnt: number }>(
      "SELECT count(*) as cnt FROM private_cognition_current WHERE agent_id = ?",
      [agent_id],
    )?.cnt ?? 0;

    repo.rebuild(agent_id);

    const after = dbHandle.get<{ cnt: number }>(
      "SELECT count(*) as cnt FROM private_cognition_current WHERE agent_id = ?",
      [agent_id],
    )?.cnt ?? 0;

    console.log(`Agent ${agent_id}: ${before} → ${after} projected rows`);
    totalAgents++;
  }

  console.log(`Replayed ${eventCount} cognition events across ${totalAgents} agents.`);
}

function replayAreaSurface(dbHandle: ReturnType<typeof openDatabase>): void {
  const eventCount = dbHandle.get<{ count: number }>(
    "SELECT count(*) AS count FROM area_state_events",
  )?.count ?? 0;

  if (eventCount === 0) {
    console.log("No area state events found — nothing to replay.");
    return;
  }

  const scopes = dbHandle.query<{ agent_id: string; area_id: number }>(
    "SELECT DISTINCT agent_id, area_id FROM area_state_events ORDER BY agent_id, area_id",
  );
  const repo = new AreaWorldProjectionRepo(dbHandle.raw);

  let totalScopes = 0;
  for (const { agent_id, area_id } of scopes) {
    const before = dbHandle.get<{ cnt: number }>(
      "SELECT count(*) as cnt FROM area_state_current WHERE agent_id = ? AND area_id = ?",
      [agent_id, area_id],
    )?.cnt ?? 0;

    repo.rebuildAreaCurrentFromEvents(agent_id, area_id);

    const after = dbHandle.get<{ cnt: number }>(
      "SELECT count(*) as cnt FROM area_state_current WHERE agent_id = ? AND area_id = ?",
      [agent_id, area_id],
    )?.cnt ?? 0;

    console.log(`Area ${agent_id}@${area_id}: ${before} → ${after} projected rows`);
    totalScopes += 1;
  }

  console.log(`Replayed ${eventCount} area state events across ${totalScopes} scopes.`);
}

function replayWorldSurface(dbHandle: ReturnType<typeof openDatabase>): void {
  const eventCount = dbHandle.get<{ count: number }>(
    "SELECT count(*) AS count FROM world_state_events",
  )?.count ?? 0;

  if (eventCount === 0) {
    console.log("No world state events found — nothing to replay.");
    return;
  }

  const repo = new AreaWorldProjectionRepo(dbHandle.raw);
  const before = dbHandle.get<{ cnt: number }>(
    "SELECT count(*) as cnt FROM world_state_current",
  )?.cnt ?? 0;

  repo.rebuildWorldCurrentFromEvents();

  const after = dbHandle.get<{ cnt: number }>(
    "SELECT count(*) as cnt FROM world_state_current",
  )?.cnt ?? 0;

  console.log(`World current rows: ${before} → ${after}`);
  console.log(`Replayed ${eventCount} world state events.`);
}

function parseArgs(input: string[]): CliArgs {
  let dbPath: string | undefined;
  let surface: ReplaySurface = "cognition";

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];

    if (token === "--surface") {
      const value = input[index + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --surface.");
      }
      surface = parseSurface(value);
      index += 1;
      continue;
    }

    if (token.startsWith("--surface=")) {
      surface = parseSurface(token.slice("--surface=".length));
      continue;
    }

    if (token.startsWith("--")) {
      failWithUsage(`Unknown argument: ${token}`);
    }

    if (dbPath) {
      failWithUsage(`Unexpected extra positional argument: ${token}`);
    }
    dbPath = token;
  }

  return { dbPath, surface };
}

function parseSurface(value: string): ReplaySurface {
  if (value === "cognition" || value === "area" || value === "world") {
    return value;
  }
  failWithUsage(`Invalid --surface value: ${value}`);
}

function failWithUsage(message: string): never {
  console.error(message);
  console.error("Usage: bun run scripts/memory-replay.ts [db-path] [--surface cognition|area|world]");
  console.error("  or set MAIDSCLAW_DB_PATH environment variable");
  process.exit(1);
}
