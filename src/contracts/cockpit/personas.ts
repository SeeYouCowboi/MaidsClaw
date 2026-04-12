export type PersonaMessageExampleDto = {
  role: string;
  content: string;
};

export type PersonaItemDto = {
  id: string;
  name: string;
  description: string;
  persona: string;
  world?: string;
  message_examples?: PersonaMessageExampleDto[];
  system_prompt?: string;
  tags?: string[];
  created_at?: number;
  hidden_tasks?: string[];
  private_persona?: string;
};

export type PersonaListResponseDto = {
  items: PersonaItemDto[];
};
