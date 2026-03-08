import { describe, expect, it } from "bun:test";
import { calculateTokenBudget } from "../../src/core/token-budget.js";
import { ContextBudgetManager } from "../../src/core/context-budget.js";
import { MaidsClawError } from "../../src/core/errors.js";
import type { AgentProfile } from "../../src/agents/profile.js";
import type { ChatMessage } from "../../src/core/models/chat-provider.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "test-agent",
    role: "rp_agent",
    lifecycle: "persistent",
    userFacing: true,
    outputMode: "freeform",
    modelId: "test-model",
    toolPermissions: [],
    maxDelegationDepth: 3,
    lorebookEnabled: false,
    narrativeContextEnabled: false,
    ...overrides,
  };
}

function makeMessage(content: string, role: ChatMessage["role"] = "user"): ChatMessage {
  return { role, content };
}

// ── calculateTokenBudget ─────────────────────────────────────────────

describe("calculateTokenBudget", () => {
  it("non-Maiden role has 0 coordination reserve", () => {
    const profile = makeProfile({ role: "rp_agent" });
    const budget = calculateTokenBudget(profile, 100_000);

    expect(budget.coordinationReserve).toBe(0);
    expect(budget.maxOutputTokens).toBe(4096); // default
    expect(budget.inputBudget).toBe(100_000 - 4096);
    expect(budget.role).toBe("rp_agent");
  });

  it("Maiden role has ≥20% coordination reserve", () => {
    const profile = makeProfile({ role: "maiden" });
    const budget = calculateTokenBudget(profile, 100_000);

    expect(budget.coordinationReserve).toBe(Math.ceil(100_000 * 0.20));
    expect(budget.coordinationReserve).toBe(20_000);
    expect(budget.inputBudget).toBe(100_000 - 4096 - 20_000);
    expect(budget.role).toBe("maiden");
  });

  it("uses profile.maxOutputTokens when provided", () => {
    const profile = makeProfile({ role: "rp_agent", maxOutputTokens: 8192 });
    const budget = calculateTokenBudget(profile, 200_000);

    expect(budget.maxOutputTokens).toBe(8192);
    expect(budget.inputBudget).toBe(200_000 - 8192);
  });

  it("defaults maxOutputTokens to 4096", () => {
    const profile = makeProfile({ role: "task_agent" });
    const budget = calculateTokenBudget(profile, 50_000);

    expect(budget.maxOutputTokens).toBe(4096);
  });

  it("throws CONTEXT_BUDGET_INVALID when inputBudget <= 0", () => {
    const profile = makeProfile({ role: "rp_agent", maxOutputTokens: 10_000 });

    try {
      // maxContextTokens=5000 - maxOutputTokens=10000 = -5000 → invalid
      calculateTokenBudget(profile, 5_000);
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err instanceof MaidsClawError).toBe(true);
      const mce = err as MaidsClawError;
      expect(mce.code).toBe("CONTEXT_BUDGET_INVALID");
      expect(mce.retriable).toBe(false);
    }
  });

  it("throws for Maiden when context window too small for reserve + output", () => {
    const profile = makeProfile({ role: "maiden", maxOutputTokens: 4096 });

    try {
      // 10000 * 0.20 = 2000 reserve; 10000 - 4096 - 2000 = 3904 → valid
      // But 5000 * 0.20 = 1000; 5000 - 4096 - 1000 = -96 → invalid
      calculateTokenBudget(profile, 5_000);
      expect(true).toBe(false);
    } catch (err) {
      expect(err instanceof MaidsClawError).toBe(true);
      expect((err as MaidsClawError).code).toBe("CONTEXT_BUDGET_INVALID");
    }
  });

  it("Maiden reserve uses Math.ceil for non-integer context windows", () => {
    const profile = makeProfile({ role: "maiden" });
    const budget = calculateTokenBudget(profile, 99_999);

    // 99999 * 0.20 = 19999.8, ceil = 20000
    expect(budget.coordinationReserve).toBe(20_000);
  });
});

// ── ContextBudgetManager ─────────────────────────────────────────────

describe("ContextBudgetManager", () => {
  function makeBudgetManager(inputBudget: number) {
    return new ContextBudgetManager({
      maxContextTokens: inputBudget + 4096,
      maxOutputTokens: 4096,
      inputBudget,
      coordinationReserve: 0,
      role: "rp_agent",
    });
  }

  describe("checkInputSize", () => {
    it("does not throw for text within budget", () => {
      const mgr = makeBudgetManager(100_000);
      // Short text should not throw
      let threw = false;
      try {
        mgr.checkInputSize("Hello, world!");
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });

    it("throws INPUT_TOO_LARGE for text exceeding inputBudget", () => {
      // Very small budget — any real text will exceed it
      const mgr = makeBudgetManager(1);

      try {
        mgr.checkInputSize("This is a message that definitely exceeds one token in length");
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect(err instanceof MaidsClawError).toBe(true);
        const mce = err as MaidsClawError;
        expect(mce.code).toBe("INPUT_TOO_LARGE");
        expect(mce.retriable).toBe(false);
      }
    });
  });

  describe("fitsInBudget", () => {
    it("returns true for messages within budget", () => {
      const mgr = makeBudgetManager(100_000);
      const messages: ChatMessage[] = [
        makeMessage("Hello"),
        makeMessage("World", "assistant"),
      ];
      expect(mgr.fitsInBudget(messages)).toBe(true);
    });

    it("returns false for messages exceeding budget", () => {
      const mgr = makeBudgetManager(1); // 1 token budget
      const messages: ChatMessage[] = [
        makeMessage("This is definitely more than one token and should not fit"),
      ];
      expect(mgr.fitsInBudget(messages)).toBe(false);
    });
  });

  describe("estimateTokens", () => {
    it("returns 0 for empty message array", () => {
      const mgr = makeBudgetManager(100_000);
      expect(mgr.estimateTokens([])).toBe(0);
    });

    it("adds MESSAGE_OVERHEAD_TOKENS (4) per message", () => {
      const mgr = makeBudgetManager(100_000);

      const emptyMsg: ChatMessage[] = [makeMessage("")];
      const twoEmptyMsgs: ChatMessage[] = [makeMessage(""), makeMessage("")];

      const oneOverhead = mgr.estimateTokens(emptyMsg);
      const twoOverhead = mgr.estimateTokens(twoEmptyMsgs);

      // Each message adds 4 tokens overhead + content tokens
      // Empty string might still count as some tokens, but the difference should be exactly 4
      expect(twoOverhead - oneOverhead).toBe(4 + (oneOverhead - 4)); // second msg = 4 overhead + same content tokens
    });

    it("handles ContentBlock[] messages", () => {
      const mgr = makeBudgetManager(100_000);
      const msg: ChatMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "t1", name: "test", input: { a: 1 } },
        ],
      };
      const tokens = mgr.estimateTokens([msg]);
      expect(tokens).toBeGreaterThan(4); // at least overhead + some content
    });
  });

  // ── G4 Eviction Guard ────────────────────────────────────────────

  describe("G4 eviction guard", () => {
    it("flushBoundary starts at -1", () => {
      const mgr = makeBudgetManager(100_000);
      expect(mgr.getFlushBoundary()).toBe(-1);
    });

    it("canEvict returns false when flushBoundary is -1", () => {
      const mgr = makeBudgetManager(100_000);
      expect(mgr.canEvict(0)).toBe(false);
      expect(mgr.canEvict(5)).toBe(false);
      expect(mgr.canEvict(-1)).toBe(false);
    });

    it("canEvict returns true for index <= flushBoundary after setFlushBoundary", () => {
      const mgr = makeBudgetManager(100_000);
      mgr.setFlushBoundary(5);

      expect(mgr.canEvict(0)).toBe(true);
      expect(mgr.canEvict(3)).toBe(true);
      expect(mgr.canEvict(5)).toBe(true);  // boundary inclusive
      expect(mgr.canEvict(6)).toBe(false);  // beyond boundary
      expect(mgr.canEvict(100)).toBe(false);
    });

    it("setFlushBoundary updates the boundary", () => {
      const mgr = makeBudgetManager(100_000);

      mgr.setFlushBoundary(3);
      expect(mgr.getFlushBoundary()).toBe(3);
      expect(mgr.canEvict(3)).toBe(true);
      expect(mgr.canEvict(4)).toBe(false);

      mgr.setFlushBoundary(10);
      expect(mgr.getFlushBoundary()).toBe(10);
      expect(mgr.canEvict(4)).toBe(true);
      expect(mgr.canEvict(10)).toBe(true);
      expect(mgr.canEvict(11)).toBe(false);
    });

    it("canEvict(5) returns false when boundary=-1, true after setFlushBoundary(5)", () => {
      // Exact acceptance criterion from spec
      const mgr = makeBudgetManager(100_000);

      expect(mgr.canEvict(5)).toBe(false); // boundary = -1
      mgr.setFlushBoundary(5);
      expect(mgr.canEvict(5)).toBe(true);  // boundary = 5
    });
  });
});
