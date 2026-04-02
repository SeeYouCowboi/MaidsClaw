#!/usr/bin/env bun
import postgres from "postgres";
import { PgJobStore } from "../src/jobs/pg-store.js";
import { bootstrapPgJobsSchema } from "../src/jobs/pg-schema.js";

const JOBS_PG_URL =
  process.env.JOBS_PG_URL ?? "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs";

const sql = postgres(JOBS_PG_URL, { max: 2 });

try {
  await bootstrapPgJobsSchema(sql);
  const store = new PgJobStore(sql);
  const expired = await store.listExpiredLeases(Date.now());

  if (expired.length === 0) {
    console.log("HEALTHY");
  } else {
    console.log(`UNHEALTHY: ${expired.length} expired lease(s) found`);
    for (const row of expired) {
      console.log(`  job_key=${row.job_key}  lease_expires_at=${row.lease_expires_at}  claimed_by=${row.claimed_by}`);
    }
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
