// Canonical prompt section slots and ordering for MaidsClaw prompt assembly.
// T13a owns these definitions; T24 consumes them for injection coordination.

/**
 * Canonical section slots in render order.
 * SYSTEM_PREAMBLE is always first; CONVERSATION is always last.
 */
export enum PromptSectionSlot {
  SYSTEM_PREAMBLE = "system_preamble",    // Required: agent identity/role
  WORLD_RULES = "world_rules",            // Optional: lore canon world rules
  CORE_MEMORY = "core_memory",            // Optional: agent's core memory blocks
  LORE_ENTRIES = "lore_entries",           // Optional: triggered lore entries
  OPERATIONAL_STATE = "operational_state", // Optional: blackboard excerpts
  MEMORY_HINTS = "memory_hints",          // Optional: memory search results
  CONVERSATION = "conversation",          // Required: the actual messages
}

/**
 * The canonical ordering of slots for deterministic rendering.
 * Sections are always concatenated in this order.
 */
export const SECTION_SLOT_ORDER: readonly PromptSectionSlot[] = [
  PromptSectionSlot.SYSTEM_PREAMBLE,
  PromptSectionSlot.WORLD_RULES,
  PromptSectionSlot.CORE_MEMORY,
  PromptSectionSlot.LORE_ENTRIES,
  PromptSectionSlot.OPERATIONAL_STATE,
  PromptSectionSlot.MEMORY_HINTS,
  PromptSectionSlot.CONVERSATION,
] as const;

/**
 * A single section of prompt content ready for rendering.
 */
export type PromptSection = {
  slot: PromptSectionSlot;
  content: string;
  tokenEstimate?: number;
};
