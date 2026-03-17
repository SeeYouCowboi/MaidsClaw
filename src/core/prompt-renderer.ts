// Budget-aware prompt renderer — assembles PromptSections into a final prompt.
// T13a owns rendering; T24 owns section preparation and injection coordination.

import type { ChatMessage } from "./models/chat-provider.js";
import type { TokenBudget } from "./token-budget.js";
import type { Logger } from "./logger.js";
import { MaidsClawError } from "./errors.js";
import { PromptSectionSlot, SECTION_SLOT_ORDER } from "./prompt-template.js";
import type { PromptSection } from "./prompt-template.js";

/** Input to PromptRenderer.render(). */
export type RenderInput = {
  sections: PromptSection[];
  budget?: TokenBudget;
};

/** Output from PromptRenderer.render(). */
export type RenderOutput = {
  systemPrompt: string;          // Combined system sections (all except CONVERSATION)
  conversationMessages: ChatMessage[];  // The CONVERSATION section parsed as messages
  estimatedTokens: number;
};

/** Slots that contribute to the system prompt (everything except CONVERSATION). */
const SYSTEM_SLOTS = new Set<PromptSectionSlot>([
  PromptSectionSlot.SYSTEM_PREAMBLE,
  PromptSectionSlot.WORLD_RULES,
  PromptSectionSlot.CORE_MEMORY,
  PromptSectionSlot.RECENT_COGNITION,
  PromptSectionSlot.LORE_ENTRIES,
  PromptSectionSlot.OPERATIONAL_STATE,
  PromptSectionSlot.MEMORY_HINTS,
]);

/**
 * Renders pre-prepared PromptSections into a final prompt structure.
 *
 * Rules:
 * 1. SYSTEM_PREAMBLE is required — throws PROMPT_TEMPLATE_ERROR if missing
 * 2. CONVERSATION is required — throws PROMPT_TEMPLATE_ERROR if missing
 * 3. Sections are rendered in canonical slot order
 * 4. Empty/omitted optional sections are skipped
 * 5. System sections concatenated with "\n\n" separator
 * 6. Budget-aware: warns (does not throw) when estimatedTokens > budget.inputBudget
 * 7. Deterministic: same input always produces same output
 */
export class PromptRenderer {
  private readonly logger?: Logger;

  constructor(options?: { logger?: Logger }) {
    this.logger = options?.logger;
  }

  render(input: RenderInput): RenderOutput {
    const { sections, budget } = input;

    // Build a map for O(1) lookup by slot
    const sectionMap = new Map<PromptSectionSlot, PromptSection>();
    for (const section of sections) {
      sectionMap.set(section.slot, section);
    }

    // Validate required sections
    if (!sectionMap.has(PromptSectionSlot.SYSTEM_PREAMBLE)) {
      throw new MaidsClawError({
        code: "PROMPT_TEMPLATE_ERROR",
        message: "Missing required section: SYSTEM_PREAMBLE",
        retriable: false,
      });
    }

    if (!sectionMap.has(PromptSectionSlot.CONVERSATION)) {
      throw new MaidsClawError({
        code: "PROMPT_TEMPLATE_ERROR",
        message: "Missing required section: CONVERSATION",
        retriable: false,
      });
    }

    // Assemble system prompt in canonical order, skipping empty/missing optional sections
    const systemParts: string[] = [];
    let estimatedTokens = 0;

    for (const slot of SECTION_SLOT_ORDER) {
      const section = sectionMap.get(slot);
      if (!section) continue;
      if (section.content.trim() === "") continue;

      if (SYSTEM_SLOTS.has(slot)) {
        systemParts.push(section.content);
      }

      if (section.tokenEstimate !== undefined) {
        estimatedTokens += section.tokenEstimate;
      }
    }

    const systemPrompt = systemParts.join("\n\n");

    // Extract conversation section — parse as ChatMessage[]
    const conversationSection = sectionMap.get(PromptSectionSlot.CONVERSATION)!;
    let conversationMessages: ChatMessage[];
    try {
      conversationMessages = JSON.parse(conversationSection.content) as ChatMessage[];
    } catch {
      throw new MaidsClawError({
        code: "PROMPT_TEMPLATE_ERROR",
        message: "CONVERSATION section content is not valid JSON",
        retriable: false,
      });
    }

    // Budget warning (non-fatal — T24 handles truncation)
    if (budget && estimatedTokens > budget.inputBudget) {
      const msg = `Estimated tokens (${estimatedTokens}) exceed input budget (${budget.inputBudget})`;
      if (this.logger) {
        this.logger.warn(msg, { estimatedTokens, inputBudget: budget.inputBudget });
      }
    }

    return {
      systemPrompt,
      conversationMessages,
      estimatedTokens,
    };
  }
}
