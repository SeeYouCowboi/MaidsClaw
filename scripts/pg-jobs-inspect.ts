#!/usr/bin/env bun
import postgres from "postgres";
import { PgJobStore } from "../src/jobs/pg-store.js";
import { bootstrapPgJobsSchema } from "../src/jobs/pg-schema.js";
import { inspectPgJobs } from "../src/jobs/pg-diagnostics.js";

const JOBS_PG_URL =
  process.env.JOBS_PG_URL ?? "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs";

const sql = postgres(JOBS_PG_URL, { max: 2 });

try {
  await bootstrapPgJobsSchema(sql);
  const store = new PgJobStore(sql);
  const report = await inspectPgJobs(store);

  console.log("PG Jobs Inspect Report");
  console.log("========================");

  const countParts = Object.entries(report.countsByStatus)
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
  console.log(`Counts by status: ${countParts}`);

  console.log(`\nActive rows (${report.activeRows.length}):`);
  if (report.activeRows.length === 0) {
    console.log("  (none)");
  } else {
    for (const row of report.activeRows) {
      console.log(`  [${row.job_key}, ${row.status}, ${row.concurrency_key}]`);
    }
  }

  console.log(`\nExpired leases (${report.expiredLeaseRows.length}):`);
  if (report.expiredLeaseRows.length === 0) {
    console.log("  (none)");
  } else {
    for (const row of report.expiredLeaseRows) {
      console.log(`  [${row.job_key}, lease_expires_at=${row.lease_expires_at}, claimed_by=${row.claimed_by}]`);
    }
  }
} finally {
  await sql.end();
}
