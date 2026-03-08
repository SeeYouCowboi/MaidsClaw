import type { McpClient, McpListedTool } from "./mcp-client.js";
import type { DispatchContext, ToolDefinition } from "./tool-definition.js";

export class McpToolAdapter implements ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: McpListedTool["parameters"];

  constructor(
    private readonly mcpClient: McpClient,
    tool: McpListedTool
  ) {
    this.name = tool.name;
    this.description = tool.description;
    this.parameters = tool.parameters;
  }

  async execute(params: unknown, _context?: DispatchContext): Promise<unknown> {
    return this.mcpClient.callTool(this.name, params);
  }
}
