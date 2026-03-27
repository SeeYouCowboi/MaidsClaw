#!/usr/bin/env bun
import { loadConfig } from "../src/core/config.js";
import { SqliteJobPersistence } from "../src/jobs/persistence.js";
import { JOB_MAX_ATTEMPTS } from "../src/jobs/types.js";
import { runMemoryMigrations } from "../src/memory/schema.js";
import { ORGANIZER_CHUNK_SIZE } from "../src/memory/task-agent.js";
import { openDatabase } from "../src/storage/database.js";

type CliArgs = {
  agentId: string;
  dryRun: boolean;
};

type NodeRefRow = {
  node_ref: string;
};

type RebuildPayload = {
  agentId: string;
  chunkNodeRefs: string[];
  settlementId: string;
};

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const dbPath = resolveDatabasePath();

const db = openDatabase({ path: dbPath });

try {
  runMemoryMigrations(db);

  const nodeRefs = loadAgentNodeRefs(db, args.agentId);
  const chunks = chunkNodeRefs(nodeRefs, ORGANIZER_CHUNK_SIZE);

  console.log(`Agent: ${args.agentId}`);
  console.log(`Database: ${dbPath}`);
  console.log(`Node refs: ${nodeRefs.length}`);
  console.log(`Chunk size: ${ORGANIZER_CHUNK_SIZE}`);
  console.log(`Chunk jobs: ${chunks.length}`);

  if (args.dryRun) {
    console.log("Dry run: no jobs enqueued.");
  } else {
    const persistence = new SqliteJobPersistence(db);
    const settlementId = `rebuild:${args.agentId}:${Date.now()}`;
    let enqueued = 0;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunkNodeRefs = chunks[index];
      const payload: RebuildPayload = {
        agentId: args.agentId,
        chunkNodeRefs,
        settlementId,
      };
      const ordinal = String(index + 1).padStart(4, "0");
      persistence.enqueue({
        id: `memory.organize:${settlementId}:chunk:${ordinal}`,
        jobType: "memory.organize",
        payload,
        status: "pending",
        maxAttempts: JOB_MAX_ATTEMPTS["memory.organize"],
        nextAttemptAt: Date.now(),
      });
      enqueued += 1;
    }

    console.log(`Enqueued ${enqueued} memory.organize jobs.`);
  }
} finally {
  db.close();
}

function parseArgs(input: string[]): CliArgs {
  let agentId = "";
  let dryRun = false;

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];

    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (token === "--agent") {
      const value = input[index + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --agent");
      }
      agentId = value;
      index += 1;
      continue;
    }

    failWithUsage(`Unknown argument: ${token}`);
  }

  if (!agentId) {
    failWithUsage("Missing required --agent <agentId>");
  }

  return { agentId, dryRun };
}

function failWithUsage(message: string): never {
  console.error(message);
  console.error("Usage: bun run scripts/memory-rebuild-derived.ts --agent <agentId> [--dry-run]");
  process.exit(1);
}

function resolveDatabasePath(): string {
  const loaded = loadConfig({
    cwd: process.cwd(),
    requireAllProviders: false,
  });

  if (!loaded.ok) {
    const details = loaded.errors.map((error) => `${error.field}: ${error.message}`).join("; ");
    throw new Error(`Unable to resolve database path from environment/config: ${details}`);
  }

  return loaded.config.storage.databasePath;
}

function loadAgentNodeRefs(
  db: ReturnType<typeof openDatabase>,
  agentId: string,
): string[] {
  const rows = db.query<NodeRefRow>(
    `WITH agent_sessions AS (
       SELECT DISTINCT session_id
       FROM private_episode_events
       WHERE agent_id = ?
     )
     SELECT node_ref
     FROM (
       SELECT DISTINCT 'entity:' || CAST(id AS TEXT) AS node_ref
       FROM entity_nodes
       WHERE memory_scope = 'shared_public' OR owner_agent_id = ?

       UNION

       SELECT DISTINCT 'event:' || CAST(id AS TEXT) AS node_ref
       FROM event_nodes
       WHERE session_id IN (SELECT session_id FROM agent_sessions)

       UNION

       SELECT DISTINCT 'event:' || CAST(source_event_id AS TEXT) AS node_ref
       FROM private_cognition_current
       WHERE agent_id = ? AND source_event_id IS NOT NULL

       UNION

       SELECT DISTINCT 'fact:' || CAST(id AS TEXT) AS node_ref
       FROM fact_edges

       UNION

       SELECT DISTINCT kind || ':' || CAST(id AS TEXT) AS node_ref
       FROM private_cognition_current
       WHERE agent_id = ?
     )
     ORDER BY node_ref ASC`,
    [agentId, agentId, agentId, agentId],
  );

  return rows.map((row) => row.node_ref);
}

function chunkNodeRefs(nodeRefs: string[], chunkSize: number): string[][] {
  if (nodeRefs.length === 0) {
    return [];
  }

  const chunks: string[][] = [];
  for (let index = 0; index < nodeRefs.length; index += chunkSize) {
    chunks.push(nodeRefs.slice(index, index + chunkSize));
  }
  return chunks;
}
