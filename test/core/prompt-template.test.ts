import { describe, it, expect } from "bun:test";
import { PromptSectionSlot, SECTION_SLOT_ORDER } from "../../src/core/prompt-template.js";
import type { PromptSection } from "../../src/core/prompt-template.js";
import { PromptRenderer } from "../../src/core/prompt-renderer.js";
import type { RenderInput } from "../../src/core/prompt-renderer.js";
import { MaidsClawError } from "../../src/core/errors.js";
import type { TokenBudget } from "../../src/core/token-budget.js";
import type { ChatMessage } from "../../src/core/models/chat-provider.js";

// --- Helpers ---

function makeConversationContent(messages: ChatMessage[]): string {
  return JSON.stringify(messages);
}

function makeSection(slot: PromptSectionSlot, content: string, tokenEstimate?: number): PromptSection {
  return { slot, content, tokenEstimate };
}

const SAMPLE_MESSAGES: ChatMessage[] = [
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hi there!" },
];

function makeMinimalInput(): RenderInput {
  return {
    sections: [
      makeSection(PromptSectionSlot.SYSTEM_PREAMBLE, "You are a helpful assistant.", 10),
      makeSection(PromptSectionSlot.CONVERSATION, makeConversationContent(SAMPLE_MESSAGES), 20),
    ],
  };
}

// --- Tests ---

describe("PromptSectionSlot enum", () => {
  it("has exactly 7 slots", () => {
    const values = Object.values(PromptSectionSlot);
    expect(values.length).toBe(7);
  });

  it("canonical order matches enum values", () => {
    expect(SECTION_SLOT_ORDER).toEqual([
      PromptSectionSlot.SYSTEM_PREAMBLE,
      PromptSectionSlot.WORLD_RULES,
      PromptSectionSlot.CORE_MEMORY,
      PromptSectionSlot.LORE_ENTRIES,
      PromptSectionSlot.OPERATIONAL_STATE,
      PromptSectionSlot.MEMORY_HINTS,
      PromptSectionSlot.CONVERSATION,
    ]);
  });
});

describe("PromptRenderer", () => {
  const renderer = new PromptRenderer();

  describe("happy path — all sections", () => {
    it("renders all sections in canonical order with correct output", () => {
      const input: RenderInput = {
        sections: [
          makeSection(PromptSectionSlot.SYSTEM_PREAMBLE, "You are Agent X.", 10),
          makeSection(PromptSectionSlot.WORLD_RULES, "Rule 1: Be nice.\nRule 2: No violence.", 15),
          makeSection(PromptSectionSlot.CORE_MEMORY, "User likes cats.", 8),
          makeSection(PromptSectionSlot.LORE_ENTRIES, "## Castle\nA grand castle.", 12),
          makeSection(PromptSectionSlot.OPERATIONAL_STATE, "Current mood: happy", 6),
          makeSection(PromptSectionSlot.MEMORY_HINTS, "Mentioned pets yesterday.", 5),
          makeSection(PromptSectionSlot.CONVERSATION, makeConversationContent(SAMPLE_MESSAGES), 20),
        ],
      };

      const output = renderer.render(input);

      // System prompt is all system sections joined with \n\n
      const expectedSystem = [
        "You are Agent X.",
        "Rule 1: Be nice.\nRule 2: No violence.",
        "User likes cats.",
        "## Castle\nA grand castle.",
        "Current mood: happy",
        "Mentioned pets yesterday.",
      ].join("\n\n");

      expect(output.systemPrompt).toBe(expectedSystem);
      expect(output.conversationMessages).toEqual(SAMPLE_MESSAGES);
      expect(output.estimatedTokens).toBe(10 + 15 + 8 + 12 + 6 + 5 + 20);
    });

    it("is deterministic — same input produces same output", () => {
      const input: RenderInput = {
        sections: [
          makeSection(PromptSectionSlot.SYSTEM_PREAMBLE, "Agent Y.", 10),
          makeSection(PromptSectionSlot.CORE_MEMORY, "Mem block.", 5),
          makeSection(PromptSectionSlot.CONVERSATION, makeConversationContent(SAMPLE_MESSAGES), 20),
        ],
      };

      const output1 = renderer.render(input);
      const output2 = renderer.render(input);

      expect(output1.systemPrompt).toBe(output2.systemPrompt);
      expect(output1.conversationMessages).toEqual(output2.conversationMessages);
      expect(output1.estimatedTokens).toBe(output2.estimatedTokens);
    });

    it("sorts sections into canonical order regardless of input order", () => {
      // Provide sections out of order
      const input: RenderInput = {
        sections: [
          makeSection(PromptSectionSlot.MEMORY_HINTS, "Hint data", 5),
          makeSection(PromptSectionSlot.CONVERSATION, makeConversationContent(SAMPLE_MESSAGES), 20),
          makeSection(PromptSectionSlot.SYSTEM_PREAMBLE, "Preamble", 10),
          makeSection(PromptSectionSlot.WORLD_RULES, "World rule", 8),
        ],
      };

      const output = renderer.render(input);

      // System prompt must follow canonical order: preamble, world_rules, ..., memory_hints
      const expectedSystem = ["Preamble", "World rule", "Hint data"].join("\n\n");
      expect(output.systemPrompt).toBe(expectedSystem);
    });
  });

  describe("error path — missing required sections", () => {
    it("throws PROMPT_TEMPLATE_ERROR when SYSTEM_PREAMBLE is missing", () => {
      const input: RenderInput = {
        sections: [
          makeSection(PromptSectionSlot.CONVERSATION, makeConversationContent(SAMPLE_MESSAGES), 20),
        ],
      };

      try {
        renderer.render(input);
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err instanceof MaidsClawError).toBe(true);
        const mcErr = err as MaidsClawError;
        expect(mcErr.code).toBe("PROMPT_TEMPLATE_ERROR");
        expect(mcErr.message).toContain("SYSTEM_PREAMBLE");
        expect(mcErr.retriable).toBe(false);
      }
    });

    it("throws PROMPT_TEMPLATE_ERROR when CONVERSATION is missing", () => {
      const input: RenderInput = {
        sections: [
          makeSection(PromptSectionSlot.SYSTEM_PREAMBLE, "Agent Z.", 10),
        ],
      };

      try {
        renderer.render(input);
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err instanceof MaidsClawError).toBe(true);
        const mcErr = err as MaidsClawError;
        expect(mcErr.code).toBe("PROMPT_TEMPLATE_ERROR");
        expect(mcErr.message).toContain("CONVERSATION");
        expect(mcErr.retriable).toBe(false);
      }
    });

    it("throws PROMPT_TEMPLATE_ERROR when CONVERSATION content is invalid JSON", () => {
      const input: RenderInput = {
        sections: [
          makeSection(PromptSectionSlot.SYSTEM_PREAMBLE, "Agent Z.", 10),
          makeSection(PromptSectionSlot.CONVERSATION, "not valid json", 5),
        ],
      };

      try {
        renderer.render(input);
        expect(true).toBe(false);
      } catch (err) {
        expect(err instanceof MaidsClawError).toBe(true);
        const mcErr = err as MaidsClawError;
        expect(mcErr.code).toBe("PROMPT_TEMPLATE_ERROR");
        expect(mcErr.message).toContain("not valid JSON");
      }
    });
  });

  describe("edge path — optional sections omitted", () => {
    it("renders correctly with only required sections (no empty placeholders)", () => {
      const input = makeMinimalInput();
      const output = renderer.render(input);

      // Only SYSTEM_PREAMBLE content, no empty strings or separators for missing slots
      expect(output.systemPrompt).toBe("You are a helpful assistant.");
      expect(output.conversationMessages).toEqual(SAMPLE_MESSAGES);
      expect(output.estimatedTokens).toBe(30);

      // Verify no double newlines from missing sections
      expect(output.systemPrompt.includes("\n\n")).toBe(false);
    });

    it("skips sections with empty content", () => {
      const input: RenderInput = {
        sections: [
          makeSection(PromptSectionSlot.SYSTEM_PREAMBLE, "Agent.", 5),
          makeSection(PromptSectionSlot.WORLD_RULES, "", 0),
          makeSection(PromptSectionSlot.CORE_MEMORY, "   ", 0), // whitespace-only
          makeSection(PromptSectionSlot.CONVERSATION, makeConversationContent(SAMPLE_MESSAGES), 10),
        ],
      };

      const output = renderer.render(input);

      // Empty and whitespace-only sections are skipped
      expect(output.systemPrompt).toBe("Agent.");
      expect(output.estimatedTokens).toBe(5 + 0 + 0 + 10);
    });

    it("handles sections without tokenEstimate", () => {
      const input: RenderInput = {
        sections: [
          makeSection(PromptSectionSlot.SYSTEM_PREAMBLE, "Agent."),
          makeSection(PromptSectionSlot.CONVERSATION, makeConversationContent(SAMPLE_MESSAGES)),
        ],
      };

      const output = renderer.render(input);
      expect(output.estimatedTokens).toBe(0); // No estimates provided
    });
  });

  describe("budget awareness", () => {
    it("logs warning when estimated tokens exceed budget", () => {
      const warnings: string[] = [];
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => { warnings.push(msg); },
        error: () => {},
        child: () => mockLogger,
      };

      const budgetRenderer = new PromptRenderer({ logger: mockLogger });
      const budget: TokenBudget = {
        maxContextTokens: 100,
        maxOutputTokens: 20,
        inputBudget: 50,
        coordinationReserve: 30,
        role: "rp_agent",
      };

      const input: RenderInput = {
        sections: [
          makeSection(PromptSectionSlot.SYSTEM_PREAMBLE, "Agent.", 30),
          makeSection(PromptSectionSlot.CONVERSATION, makeConversationContent(SAMPLE_MESSAGES), 40),
        ],
        budget,
      };

      // Should NOT throw — just warn
      const output = budgetRenderer.render(input);
      expect(output.estimatedTokens).toBe(70);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("70");
      expect(warnings[0]).toContain("50");
    });

    it("does not warn when under budget", () => {
      const warnings: string[] = [];
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => { warnings.push(msg); },
        error: () => {},
        child: () => mockLogger,
      };

      const budgetRenderer = new PromptRenderer({ logger: mockLogger });
      const budget: TokenBudget = {
        maxContextTokens: 200,
        maxOutputTokens: 20,
        inputBudget: 150,
        coordinationReserve: 30,
        role: "rp_agent",
      };

      const input: RenderInput = {
        sections: [
          makeSection(PromptSectionSlot.SYSTEM_PREAMBLE, "Agent.", 10),
          makeSection(PromptSectionSlot.CONVERSATION, makeConversationContent(SAMPLE_MESSAGES), 20),
        ],
        budget,
      };

      budgetRenderer.render(input);
      expect(warnings.length).toBe(0);
    });
  });
});
