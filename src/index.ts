import { AgentLoop } from "./core/agent-loop.js";
import { ToolExecutor } from "./core/tools/tool-executor.js";
import { bootstrapRegistry } from "./core/models/bootstrap.js";
import { GatewayServer } from "./gateway/server.js";
import { SessionService } from "./session/service.js";
import type { AgentProfile } from "./agents/profile.js";

export const VERSION = "0.1.0";

export function version(): string {
  return VERSION;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "localhost";

const DEFAULT_AGENT_PROFILE: AgentProfile = {
  id: "maid:main",
  role: "maiden",
  lifecycle: "persistent",
  userFacing: true,
  outputMode: "freeform",
  modelId: "anthropic/claude-sonnet-4-20250514",
  toolPermissions: [],
  maxDelegationDepth: 3,
  lorebookEnabled: false,
  narrativeContextEnabled: false,
};

async function main(): Promise<void> {
  const port = parseInt(process.env.MAIDSCLAW_PORT ?? String(DEFAULT_PORT), 10);
  const host = process.env.MAIDSCLAW_HOST ?? DEFAULT_HOST;

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${process.env.MAIDSCLAW_PORT}`);
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.warn("No API keys set. Agent runtime will not be available.");
  }

  const sessionService = new SessionService();
  const modelRegistry = bootstrapRegistry();
  const toolExecutor = new ToolExecutor();

  const createAgentLoop = (agentId: string) => {
    const profile = agentId === DEFAULT_AGENT_PROFILE.id
      ? DEFAULT_AGENT_PROFILE
      : { ...DEFAULT_AGENT_PROFILE, id: agentId };

    try {
      const modelProvider = modelRegistry.resolveChat(profile.modelId);
      return new AgentLoop({
        profile,
        modelProvider,
        toolExecutor,
      });
    } catch {
      return null;
    }
  };

  const server = new GatewayServer({
    port,
    host,
    sessionService,
    createAgentLoop,
  });

  server.start();

  console.log(`MaidsClaw v${VERSION} started on port ${server.getPort()}`);

  const shutdown = (): void => {
    console.log("Shutting down...");
    server.stop();
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
