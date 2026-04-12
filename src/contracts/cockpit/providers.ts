export type ProviderSelectionPolicyDto = {
  enabled_by_default: boolean;
  eligible_for_auto_fallback: boolean;
  is_auto_default: boolean;
};

export type ProviderModelDto = {
  id: string;
  display_name: string;
  context_window: number;
  max_output_tokens: number;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_embedding: boolean;
};

export type ProviderItemDto = {
  id: string;
  display_name: string;
  transport_family: string;
  api_kind: string;
  risk_tier: string;
  base_url: string;
  auth_modes: string[];
  configured: boolean;
  selection_policy: ProviderSelectionPolicyDto;
  default_chat_model_id?: string;
  default_embedding_model_id?: string;
  models: ProviderModelDto[];
};

export type ProviderListResponseDto = {
  providers: ProviderItemDto[];
};
