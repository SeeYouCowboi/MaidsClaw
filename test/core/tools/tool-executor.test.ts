import { describe, expect, it } from "bun:test";

import { MaidsClawError } from "../../../src/core/errors.js";
import { McpClient, type McpListedTool, type McpTransport } from "../../../src/core/tools/mcp-client.js";
import type { DispatchContext, ToolDefinition } from "../../../src/core/tools/tool-definition.js";
import { ToolExecutor } from "../../../src/core/tools/tool-executor.js";

class MockMcpTransport implements McpTransport {
  connectCalls = 0;
  disconnectCalls = 0;
  listToolsCalls = 0;
  callToolCalls = 0;

  private connected = false;

  constructor(
    private readonly tools: McpListedTool[],
    private readonly onCall: (name: string, params: unknown) => unknown
  ) {}

  async connect(): Promise<void> {
    this.connectCalls++;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.connected = false;
  }

  async listTools(): Promise<McpListedTool[]> {
    if (!this.connected) {
      throw new MaidsClawError({
        code: "MCP_DISCONNECTED",
        message: "not connected",
        retriable: true,
      });
    }

    this.listToolsCalls++;
    return this.tools;
  }

  async callTool(name: string, params: unknown): Promise<unknown> {
    if (!this.connected) {
      throw new MaidsClawError({
        code: "MCP_DISCONNECTED",
        message: "not connected",
        retriable: true,
      });
    }

    this.callToolCalls++;
    return this.onCall(name, params);
  }
}

async function waitFor(predicate: () => boolean, maxIterations = 20): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }

  throw new Error("Condition was not met");
}

describe("ToolExecutor", () => {
  it("dispatches local tools directly with context", async () => {
    const executor = new ToolExecutor();
    const seen: { params?: unknown; context?: DispatchContext } = {};

    const localTool: ToolDefinition = {
      name: "local_add",
      description: "adds values",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      },
      async execute(params: unknown, context?: DispatchContext): Promise<unknown> {
        seen.params = params;
        seen.context = context;
        const p = params as { a: number; b: number };
        return p.a + p.b;
      },
    };

    executor.registerLocal(localTool);

    const context: DispatchContext = {
      sessionId: "s1",
      agentId: "a1",
      viewerContext: { session_id: "s1", viewer_agent_id: "a1", viewer_role: "task_agent" },
    };

    const result = await executor.execute("local_add", { a: 2, b: 3 }, context);

    expect(result).toBe(5);
    expect(seen.params).toEqual({ a: 2, b: 3 });
    expect(seen.context?.sessionId).toBe("s1");
  });

  it("loads remote schemas lazily on getSchemas and caches listTools", async () => {
    const transport = new MockMcpTransport(
      [
        {
          name: "remote_echo",
          description: "echoes text",
          parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
      ],
      (_name, params) => params
    );

    const client = new McpClient({ serverName: "mock", transport });
    const executor = new ToolExecutor();
    executor.registerMCP("mock", client);

    expect(transport.listToolsCalls).toBe(0);

    const schemasFirst = executor.getSchemas();
    await waitFor(() => executor.getSchemas().some((s) => s.name === "remote_echo"));
    const schemasSecond = executor.getSchemas();

    expect(schemasFirst.some((s) => s.name === "remote_echo")).toBe(false);
    expect(schemasSecond.some((s) => s.name === "remote_echo")).toBe(true);
    expect(transport.connectCalls).toBe(1);
    expect(transport.listToolsCalls).toBe(1);
  });

  it("executes remote MCP tools via adapter and lazy schema load", async () => {
    const transport = new MockMcpTransport(
      [
        {
          name: "remote_upper",
          description: "uppercases text",
          parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
      ],
      (name, params) => {
        const input = params as { text: string };
        return { name, text: input.text.toUpperCase() };
      }
    );

    const client = new McpClient({ serverName: "mock", transport });
    const executor = new ToolExecutor();
    executor.registerMCP("mock", client);

    expect(transport.listToolsCalls).toBe(0);
    expect(transport.callToolCalls).toBe(0);

    const result = await executor.execute("remote_upper", { text: "maidsclaw" });

    expect(result).toEqual({ name: "remote_upper", text: "MAIDSCLAW" });
    expect(transport.listToolsCalls).toBe(1);
    expect(transport.callToolCalls).toBe(1);
  });

  it("prefers local tool when local and MCP names collide", async () => {
    const transport = new MockMcpTransport(
      [
        {
          name: "shared_name",
          description: "remote shared",
          parameters: { type: "object", properties: {} },
        },
      ],
      () => "remote"
    );

    const client = new McpClient({ serverName: "mock", transport });
    const executor = new ToolExecutor();

    executor.registerLocal({
      name: "shared_name",
      description: "local shared",
      parameters: { type: "object", properties: {} },
      async execute(): Promise<unknown> {
        return "local";
      },
    });
    executor.registerMCP("mock", client);

    const result = await executor.execute("shared_name", {});

    expect(result).toBe("local");
    expect(transport.callToolCalls).toBe(0);
  });

  it("unregisterMCP disconnects and removes remote tools", async () => {
    const transport = new MockMcpTransport(
      [
        {
          name: "remote_drop",
          description: "will disappear",
          parameters: { type: "object", properties: {} },
        },
      ],
      () => "ok"
    );

    const client = new McpClient({ serverName: "mock", transport });
    const executor = new ToolExecutor();
    executor.registerMCP("mock", client);

    await executor.execute("remote_drop", {});
    executor.unregisterMCP("mock");
    await Promise.resolve();

    let err: unknown;
    try {
      await executor.execute("remote_drop", {});
    } catch (error) {
      err = error;
    }

    expect(transport.disconnectCalls).toBe(1);
    expect(err instanceof MaidsClawError).toBe(true);
    expect((err as MaidsClawError).code).toBe("TOOL_ARGUMENT_INVALID");
  });
});
