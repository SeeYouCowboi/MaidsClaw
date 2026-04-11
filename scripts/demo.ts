import { GatewayServer } from "../src/gateway/server.js";
import { SessionService } from "../src/session/service.js";
import { LocalSessionClient } from "../src/app/clients/local/local-session-client.js";

async function runDemo(): Promise<void> {
  console.log("MaidsClaw V1 Demo");

  const server = new GatewayServer({
    port: 0,
    host: "localhost",
    context: {
      session: new LocalSessionClient({
        sessionService: new SessionService(),
      }),
    },
  });

  server.start();

  try {
    const port = server.getPort();
    console.log(`Port: ${port}`);

    const response = await fetch(`http://localhost:${port}/healthz`);
    const body = (await response.json()) as { status: string };
    console.log(`Health: ${JSON.stringify(body)}`);
  } finally {
    server.stop();
  }

  console.log("Demo complete");
}

await runDemo();
