import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RuleBasedQueryRouter } from "../../src/memory/query-router";
import {
  isCjkSegmenterAvailable,
  loadUserDict,
} from "../../src/memory/cjk-segmenter";
import type { AliasService } from "../../src/memory/alias";

/**
 * GAP-4 §8 — private-alias substring scan tests.
 *
 * Verifies that RuleBasedQueryRouter's second-pass scan recovers CJK
 * private aliases that the global jieba tokenizer cannot recognize
 * (because private aliases are intentionally NOT loaded into jieba's
 * global user dict — that would leak entity names across agents).
 *
 * The router stays in plain bilingual rule-based mode; the only thing
 * under test is the second-pass loop in route().
 *
 * Tests that depend on real jieba segmentation are skipped when
 * @node-rs/jieba is unavailable; the negative-coverage tests still run
 * because they don't require any specific tokenization.
 */

// ----- Stubs --------------------------------------------------------------

type StubConfig = {
  /** Substring → entity id. Returned by resolveAlias regardless of agentId. */
  resolveMap?: Record<string, number>;
  /** Per-agent private alias strings. */
  privateByAgent?: Record<string, string[]>;
  /** Force resolveAlias to throw. */
  resolveThrows?: boolean;
  /** Force listPrivateAliasStrings to throw. */
  listThrows?: boolean;
};

function makeAlias(config: StubConfig = {}): AliasService {
  const resolveMap = config.resolveMap ?? {};
  const privateByAgent = config.privateByAgent ?? {};
  return {
    async resolveAlias(alias: string): Promise<number | null> {
      if (config.resolveThrows) throw new Error("resolve boom");
      return resolveMap[alias] ?? null;
    },
    async listPrivateAliasStrings(agentId: string): Promise<string[]> {
      if (config.listThrows) throw new Error("list boom");
      return privateByAgent[agentId] ?? [];
    },
  } as unknown as AliasService;
}

// Words seeded into jieba's user dict so the tests get deterministic
// segmentation. Critical: 小红同学 is NOT seeded — it's the alias whose
// fragmentation is the whole point of the second-pass scan.
const SHARED_DICT = ["管家", "书房", "小红色", "红色"];

beforeAll(() => {
  if (isCjkSegmenterAvailable()) {
    loadUserDict(SHARED_DICT);
  }
});

// Sanity-check helper: how many tests run depends on whether jieba is up.
const skipIfNoJieba = !isCjkSegmenterAvailable();

// ----- Tests --------------------------------------------------------------

describe("Private alias substring scan (GAP-4 §8)", () => {
  describe.skipIf(skipIfNoJieba)("with real jieba segmenter", () => {
    it("recovers a 4-char private alias that jieba fragments (例 1)", async () => {
      const router = new RuleBasedQueryRouter(
        makeAlias({
          resolveMap: { 管家: 5, 小红同学: 101 },
          privateByAgent: { agent_a: ["小红同学"] },
        }),
      );

      const route = await router.route({
        query: "为什么管家和小红同学吵架了",
        viewerAgentId: "agent_a",
      });

      // First pass picks up 管家 (in shared dict). Second pass picks up
      // 小红同学 via the substring scan + boundary alignment.
      expect(route.resolvedEntityIds).toContain(5);
      expect(route.resolvedEntityIds).toContain(101);
      expect(route.matchedRules).toContain("private_alias_scan_hit");
    });

    it("rejects 小红 substring shadowed by jieba's longer 小红色 (例 3a)", async () => {
      const router = new RuleBasedQueryRouter(
        makeAlias({
          resolveMap: { 小红: 200 },
          privateByAgent: { agent_b: ["小红"] },
        }),
      );

      const route = await router.route({
        query: "我喜欢小红色的衣服",
        viewerAgentId: "agent_b",
      });

      // Boundary alignment must reject 小红 because jieba treats 小红色
      // as one token: end position 5 is inside 小红色 [3, 6).
      expect(route.resolvedEntityIds).not.toContain(200);
      expect(route.matchedRules).not.toContain("private_alias_scan_hit");
    });

    it("does not surface agent A's private alias when agent B asks the same question (scope isolation)", async () => {
      const router = new RuleBasedQueryRouter(
        makeAlias({
          resolveMap: { 小红同学: 101 },
          privateByAgent: { agent_a: ["小红同学"] },
        }),
      );

      const routeFromB = await router.route({
        query: "小红同学在做什么",
        viewerAgentId: "agent_b",
      });

      // agent_b's private list is empty → second pass finds no candidates.
      // resolveMap returning 101 for 小红同学 is irrelevant: the second
      // pass only resolves substrings drawn from agent_b's own list.
      expect(routeFromB.resolvedEntityIds).not.toContain(101);
      expect(routeFromB.matchedRules).not.toContain("private_alias_scan_hit");
    });

    it("dedupes when first-pass token already resolved the alias", async () => {
      // 管家 lives in jieba's shared dict, so the first pass already
      // produces it. Even if it appears in the agent's private list, the
      // second pass must not duplicate the entity id.
      const router = new RuleBasedQueryRouter(
        makeAlias({
          resolveMap: { 管家: 5 },
          privateByAgent: { agent_a: ["管家"] },
        }),
      );

      const route = await router.route({
        query: "管家在哪",
        viewerAgentId: "agent_a",
      });

      const occurrences = route.resolvedEntityIds.filter((id) => id === 5).length;
      expect(occurrences).toBe(1);
    });
  });

  describe("flag and failure modes (no jieba required)", () => {
    it("MAIDSCLAW_ROUTER_PRIVATE_ALIAS_SCAN=off disables the second pass", async () => {
      const previous = process.env.MAIDSCLAW_ROUTER_PRIVATE_ALIAS_SCAN;
      process.env.MAIDSCLAW_ROUTER_PRIVATE_ALIAS_SCAN = "off";
      try {
        const router = new RuleBasedQueryRouter(
          makeAlias({
            resolveMap: { 小红同学: 101 },
            privateByAgent: { agent_a: ["小红同学"] },
          }),
        );

        const route = await router.route({
          query: "小红同学在书房",
          viewerAgentId: "agent_a",
        });

        expect(route.resolvedEntityIds).not.toContain(101);
        expect(route.matchedRules).not.toContain("private_alias_scan_hit");
      } finally {
        if (previous === undefined) {
          delete process.env.MAIDSCLAW_ROUTER_PRIVATE_ALIAS_SCAN;
        } else {
          process.env.MAIDSCLAW_ROUTER_PRIVATE_ALIAS_SCAN = previous;
        }
      }
    });

    it("listPrivateAliasStrings throwing falls back to first-pass result silently", async () => {
      const router = new RuleBasedQueryRouter(
        makeAlias({ resolveMap: { Alice: 1 }, listThrows: true }),
      );

      // First pass should still resolve "Alice" via tokenizeQuery's Latin path.
      const route = await router.route({
        query: "where is Alice",
        viewerAgentId: "agent_a",
      });
      expect(route.resolvedEntityIds).toContain(1);
      expect(route.matchedRules).not.toContain("private_alias_scan_hit");
    });

    it("single-character private aliases are skipped (length < 2 floor)", async () => {
      const router = new RuleBasedQueryRouter(
        makeAlias({
          resolveMap: { 他: 999 },
          privateByAgent: { agent_a: ["他"] },
        }),
      );

      const route = await router.route({
        query: "他在哪里",
        viewerAgentId: "agent_a",
      });

      expect(route.resolvedEntityIds).not.toContain(999);
      expect(route.matchedRules).not.toContain("private_alias_scan_hit");
    });

    it("empty private list short-circuits without calling segmentCjkWithSpans", async () => {
      const router = new RuleBasedQueryRouter(
        makeAlias({
          resolveMap: {},
          privateByAgent: { agent_a: [] },
        }),
      );

      const route = await router.route({
        query: "anything goes here",
        viewerAgentId: "agent_a",
      });

      // No throw, no scan hit, first pass result preserved.
      expect(route.matchedRules).not.toContain("private_alias_scan_hit");
    });
  });
});
