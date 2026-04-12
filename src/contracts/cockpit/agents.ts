export type AgentToolPermissionDto = {
  tool_name: string;
  allowed: boolean;
};

export type AgentContextBudgetDto = {
  max_tokens: number;
  reserved_for_coordination?: number;
};

export type AgentItemDto = {
  id: string;
  display_name: string;
  role: string;
  lifecycle: string;
  user_facing: boolean;
  output_mode: string;
  model_id: string;
  persona_id?: string;
  max_output_tokens?: number;
  tool_permissions: AgentToolPermissionDto[];
  context_budget?: AgentContextBudgetDto;
  lorebook_enabled: boolean;
  narrative_context_enabled: boolean;
};

export type AgentListResponseDto = {
  agents: AgentItemDto[];
};
