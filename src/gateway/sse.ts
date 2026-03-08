import type { GatewayEvent } from "../core/types.js";

/**
 * Format a single GatewayEvent as an SSE data line.
 * SSE format: "data: {JSON}\n\n"
 */
export function formatSseEvent(event: GatewayEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Build a complete SSE Response for streaming.
 * Consumes an AsyncGenerator of GatewayEvents and writes them as SSE lines.
 */
export function createSseStream(
  sessionId: string,
  requestId: string,
  generator: AsyncGenerator<GatewayEvent>
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await generator.next();
        if (done) {
          controller.close();
          return;
        }
        const sseText = formatSseEvent(value);
        controller.enqueue(encoder.encode(sseText));
      } catch {
        // If generator throws, close the stream gracefully
        controller.close();
      }
    },
    cancel() {
      // Client disconnected — return the generator so it can clean up
      generator.return(undefined);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
