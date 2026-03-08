// Typed data shapes for each PromptSectionSlot.
// T24 prepares these; T13a's PromptRenderer consumes them after conversion to PromptSection.

import type { AgentRole } from "../agents/profile.js";

/** Data for SYSTEM_PREAMBLE slot — agent identity and system instructions. */
export type SystemPreambleData = {
  agentId: string;
  role: AgentRole;
  systemPrompt: string;
};

/** Data for WORLD_RULES slot — lore canon world rules. */
export type WorldRulesData = {
  entries: string[];
};

/** Data for CORE_MEMORY slot — agent's persistent core memory blocks. */
export type CoreMemoryData = {
  character?: string;
  user?: string;
  index?: string;
};

/** Data for LORE_ENTRIES slot — triggered lore book entries. */
export type LoreEntriesData = {
  entries: Array<{ title: string; content: string }>;
};

/** Data for OPERATIONAL_STATE slot — blackboard excerpts. */
export type OperationalStateData = {
  excerpts: string[];
};

/** Data for MEMORY_HINTS slot — memory search results. */
export type MemoryHintsData = {
  hints: string[];
};

// Note: CONVERSATION slot is handled separately as ChatMessage[] — not a data type here.
