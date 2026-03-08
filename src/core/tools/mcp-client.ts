import { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { MaidsClawError, wrapError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { JsonSchema } from "./tool-definition.js";

export type McpListedTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export interface McpTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<McpListedTool[]>;
  callTool(name: string, params: unknown): Promise<unknown>;
}

class StdioMcpTransport implements McpTransport {
  private process?: ChildProcessWithoutNullStreams;
  private requestId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly spawnOptions: SpawnOptionsWithoutStdio = {},
    private readonly logger?: Logger
  ) {}

  async connect(): Promise<void> {
    if (this.process) {
      return;
    }

    this.process = spawn(this.command, this.args, {
      ...this.spawnOptions,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.process.stdout });
    rl.on("line", (line: string) => {
      this.onLine(line);
    });

    this.process.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf8").trim();
      if (msg.length > 0) {
        this.logger?.warn("MCP server stderr", { message: msg });
      }
    });

    this.process.on("exit", (_code, signal) => {
      const err = new MaidsClawError({
        code: "MCP_DISCONNECTED",
        message: `MCP server exited${signal ? ` with signal ${signal}` : ""}`,
        retriable: true,
      });

      for (const [, resolver] of this.pending) {
        resolver.reject(err);
      }

      this.pending.clear();
      this.process = undefined;
    });
  }

  async disconnect(): Promise<void> {
    if (!this.process) {
      return;
    }

    const proc = this.process;
    this.process = undefined;

    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill();
    });
  }

  async listTools(): Promise<McpListedTool[]> {
    const result = await this.request("tools/list", {});
    const parsed = this.parseListTools(result);
    return parsed;
  }

  async callTool(name: string, params: unknown): Promise<unknown> {
    return this.request("tools/call", {
      name,
      arguments: params,
    });
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process) {
      throw new MaidsClawError({
        code: "MCP_DISCONNECTED",
        message: "MCP transport is not connected",
        retriable: true,
      });
    }

    const id = ++this.requestId;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const encoded = `${JSON.stringify(payload)}\n`;
    this.process.stdin.write(encoded);

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private onLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let decoded: JsonRpcResponse;
    try {
      decoded = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.logger?.warn("Invalid MCP JSON-RPC line", { line });
      return;
    }

    if (typeof decoded.id !== "number") {
      return;
    }

    const resolver = this.pending.get(decoded.id);
    if (!resolver) {
      return;
    }

    this.pending.delete(decoded.id);

    if (decoded.error) {
      resolver.reject(
        new MaidsClawError({
          code: "MCP_TOOL_ERROR",
          message: decoded.error.message,
          retriable: false,
          details: decoded.error.data,
        })
      );
      return;
    }

    resolver.resolve(decoded.result);
  }

  private parseListTools(result: unknown): McpListedTool[] {
    if (!result || typeof result !== "object") {
      return [];
    }

    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) {
      return [];
    }

    const parsed: McpListedTool[] = [];
    for (const item of tools) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const entry = item as {
        name?: unknown;
        description?: unknown;
        inputSchema?: JsonSchema;
      };

      if (typeof entry.name !== "string") {
        continue;
      }

      parsed.push({
        name: entry.name,
        description: typeof entry.description === "string" ? entry.description : "",
        parameters: (entry.inputSchema ?? { type: "object", properties: {} }) as JsonSchema,
      });
    }

    return parsed;
  }
}

export type McpClientOptions = {
  serverName: string;
  command?: string;
  args?: string[];
  spawnOptions?: SpawnOptionsWithoutStdio;
  logger?: Logger;
  transport?: McpTransport;
};

export class McpClient {
  private readonly transport: McpTransport;
  private schemas?: McpListedTool[];
  private connected = false;

  readonly serverName: string;

  constructor(options: McpClientOptions) {
    this.serverName = options.serverName;
    if (options.transport) {
      this.transport = options.transport;
      return;
    }

    if (!options.command) {
      throw new MaidsClawError({
        code: "CONFIG_MISSING_CREDENTIAL",
        message: `MCP server ${options.serverName} missing command`,
        retriable: false,
      });
    }

    this.transport = new StdioMcpTransport(
      options.command,
      options.args,
      options.spawnOptions,
      options.logger
    );
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.transport.connect();
      this.connected = true;
    } catch (error) {
      throw wrapError(error, { code: "MCP_DISCONNECTED", retriable: true });
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      await this.transport.disconnect();
    } finally {
      this.connected = false;
      this.schemas = undefined;
    }
  }

  async listTools(): Promise<McpListedTool[]> {
    if (this.schemas) {
      return this.schemas;
    }

    await this.connect();

    try {
      this.schemas = await this.transport.listTools();
      return this.schemas;
    } catch (error) {
      throw wrapError(error, { code: "MCP_SCHEMA_LOAD_FAILED", retriable: true });
    }
  }

  async callTool(name: string, params: unknown): Promise<unknown> {
    await this.connect();

    try {
      return await this.transport.callTool(name, params);
    } catch (error) {
      throw wrapError(error, { code: "MCP_TOOL_ERROR", retriable: false });
    }
  }
}
