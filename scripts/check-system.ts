#!/usr/bin/env bun
/**
 * MaidsClaw V1 — System Readiness Check Script
 *
 * Checks if the MaidsClaw server is healthy and ready to accept requests.
 * Exits with code 0 if healthy, code 1 if not.
 */

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "localhost";

async function main(): Promise<void> {
  const host = process.env.MAIDSCLAW_HOST ?? DEFAULT_HOST;
  const port = parseInt(process.env.MAIDSCLAW_PORT ?? String(DEFAULT_PORT), 10);
  const baseUrl = `http://${host}:${port}`;

  console.log(`🔍 Checking system at ${baseUrl}...\n`);

  let healthOk = false;
  let readyOk = false;

  // Check health endpoint
  try {
    const healthResponse = await fetch(`${baseUrl}/healthz`);
    const healthBody = await healthResponse.json();
    console.log(`📊 /healthz — Status: ${healthResponse.status}`);
    console.log(`   Response: ${JSON.stringify(healthBody)}`);
    healthOk = healthResponse.status === 200;
  } catch (error) {
    console.error(`❌ /healthz — Failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log();

  // Check readiness endpoint
  try {
    const readyResponse = await fetch(`${baseUrl}/readyz`);
    const readyBody = await readyResponse.json();
    console.log(`📊 /readyz — Status: ${readyResponse.status}`);
    console.log(`   Response: ${JSON.stringify(readyBody)}`);
    readyOk = readyResponse.status === 200;
  } catch (error) {
    console.error(`❌ /readyz — Failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log();

  // Final result
  if (healthOk && readyOk) {
    console.log("✅ System check: OK");
    process.exit(0);
  } else {
    console.log("❌ System check: FAILED");
    if (!healthOk) console.log("   → Health endpoint not responding correctly");
    if (!readyOk) console.log("   → Readiness endpoint not responding correctly");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("System check failed with error:", error);
  process.exit(1);
});
