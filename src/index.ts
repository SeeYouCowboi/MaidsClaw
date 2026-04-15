import { createAppHost } from "./app/host/index.js";
import { startWithPortCheck } from "./utils/port-check.js";

export const VERSION = "0.1.0";

export function version(): string {
  return VERSION;
}

async function main(): Promise<void> {
  const host = await createAppHost({
    role: "server",
    requireAllProviders: false,
    // Enable per-request trace capture so the dashboard's Retrieval Trace
    // panel has data to show. Disable by setting MAIDSCLAW_TRACE_CAPTURE=off.
    traceCaptureEnabled: process.env.MAIDSCLAW_TRACE_CAPTURE !== "off",
  });

  const port = parseInt(process.env.MAIDSCLAW_PORT ?? "3000", 10);
  await startWithPortCheck(port, () => host.start());

  console.log(`MaidsClaw v${VERSION} started on port ${host.getBoundPort!()}`);

  const shutdown = (): void => {
    console.log("Shutting down...");
    void host.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
