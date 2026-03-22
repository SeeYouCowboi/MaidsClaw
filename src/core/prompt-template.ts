// Canonical prompt section slots and ordering for MaidsClaw prompt assembly.
// T13a owns these definitions; T24 consumes them for injection coordination.

/**
 * Canonical section slots in render order.
 * SYSTEM_PREAMBLE is always first; CONVERSATION is always last.
 */
export enum PromptSectionSlot {
  SYSTEM_PREAMBLE = "system_preamble",
  WORLD_RULES = "world_rules",
  CORE_MEMORY = "core_memory",
  PINNED_SHARED = "pinned_shared",
  RECENT_COGNITION = "recent_cognition",
  LORE_ENTRIES = "lore_entries",
  OPERATIONAL_STATE = "operational_state",
  MEMORY_HINTS = "memory_hints",
  CONVERSATION = "conversation",
}

/**
 * The canonical ordering of slots for deterministic rendering.
 * Sections are always concatenated in this order.
 */
export const SECTION_SLOT_ORDER: readonly PromptSectionSlot[] = [
  PromptSectionSlot.SYSTEM_PREAMBLE,
  PromptSectionSlot.WORLD_RULES,
  PromptSectionSlot.CORE_MEMORY,
  PromptSectionSlot.PINNED_SHARED,
  PromptSectionSlot.RECENT_COGNITION,
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
