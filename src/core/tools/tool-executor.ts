import { MaidsClawError, wrapError } from "../errors.js";
import { McpToolAdapter } from "./mcp-adapter.js";
import type { McpClient } from "./mcp-client.js";
import type { DispatchContext, ToolDefinition, ToolSchema } from "./tool-definition.js";

type RemoteRegistration = {
  client: McpClient;
  loaded: boolean;
  loading?: Promise<void>;
  tools: Map<string, ToolDefinition>;
};

export class ToolExecutor {
  private readonly localTools = new Map<string, ToolDefinition>();
  private readonly mcpServers = new Map<string, RemoteRegistration>();

  registerLocal(tool: ToolDefinition): void {
    this.localTools.set(tool.name, tool);
  }

  registerMCP(serverName: string, client: McpClient): void {
    this.mcpServers.set(serverName, {
      client,
      loaded: false,
      loading: undefined,
      tools: new Map(),
    });
  }

  unregisterMCP(serverName: string): void {
    const registration = this.mcpServers.get(serverName);
    if (!registration) {
      return;
    }

    this.mcpServers.delete(serverName);
    void registration.client.disconnect();
  }

  async execute(name: string, params: unknown, context?: DispatchContext): Promise<unknown> {
    const local = this.localTools.get(name);
    if (local) {
      return local.execute(params, context);
    }

    const loadedRemote = this.findLoadedRemoteTool(name);
    if (loadedRemote) {
      return loadedRemote.execute(params, context);
    }

    for (const registration of this.mcpServers.values()) {
      if (!registration.loaded) {
        await this.ensureLoaded(registration);
      }

      const remote = registration.tools.get(name);
      if (remote) {
        return remote.execute(params, context);
      }
    }

    throw new MaidsClawError({
      code: "TOOL_ARGUMENT_INVALID",
      message: `Tool not found: ${name}`,
      retriable: false,
    });
  }

  getSchemas(): ToolSchema[] {
    const localSchemas: ToolSchema[] = [];
    for (const tool of this.localTools.values()) {
      const schema: ToolSchema = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      };
      if (tool.effectClass) schema.effectClass = tool.effectClass;
      if (tool.traceVisibility) schema.traceVisibility = tool.traceVisibility;
      if (tool.executionContract) schema.executionContract = tool.executionContract;
      if (tool.artifactContracts) schema.artifactContracts = tool.artifactContracts;
      localSchemas.push(schema);
    }

    for (const registration of this.mcpServers.values()) {
      if (!registration.loaded) {
        this.startBackgroundLoad(registration);
      }
    }

    const remoteSchemas: ToolSchema[] = [];
    for (const registration of this.mcpServers.values()) {
      for (const tool of registration.tools.values()) {
        const schema: ToolSchema = {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        };
        if (tool.effectClass) schema.effectClass = tool.effectClass;
        if (tool.traceVisibility) schema.traceVisibility = tool.traceVisibility;
        if (tool.executionContract) schema.executionContract = tool.executionContract;
        if (tool.artifactContracts) schema.artifactContracts = tool.artifactContracts;
        remoteSchemas.push(schema);
      }
    }

    return [...localSchemas, ...remoteSchemas];
  }

  private startBackgroundLoad(registration: RemoteRegistration): void {
    if (registration.loaded || registration.loading) {
      return;
    }

    registration.loading = this.loadServerSchemas(registration).finally(() => {
      registration.loading = undefined;
    });
  }

  private async ensureLoaded(registration: RemoteRegistration): Promise<void> {
    if (registration.loaded) {
      return;
    }

    if (registration.loading) {
      await registration.loading;
      return;
    }

    registration.loading = this.loadServerSchemas(registration).finally(() => {
      registration.loading = undefined;
    });

    await registration.loading;
  }

  private findLoadedRemoteTool(name: string): ToolDefinition | undefined {
    for (const registration of this.mcpServers.values()) {
      if (!registration.loaded) {
        continue;
      }

      const tool = registration.tools.get(name);
      if (tool) {
        return tool;
      }
    }

    return undefined;
  }

  private async loadServerSchemas(registration: RemoteRegistration): Promise<void> {
    if (registration.loaded) {
      return;
    }

    let listed: Awaited<ReturnType<McpClient["listTools"]>>;
    try {
      listed = await registration.client.listTools();
    } catch (error) {
      throw wrapError(error, { code: "MCP_SCHEMA_LOAD_FAILED", retriable: true });
    }

    registration.tools.clear();
    for (const tool of listed) {
      registration.tools.set(tool.name, new McpToolAdapter(registration.client, tool));
    }

    registration.loaded = true;
  }
}
