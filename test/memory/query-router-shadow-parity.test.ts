import { describe, expect, it } from "bun:test";
import { RuleBasedQueryRouter } from "../../src/memory/query-router";
import {
  WHY_KEYWORDS,
  CONFLICT_KEYWORDS,
  TIMELINE_KEYWORDS,
  RELATIONSHIP_KEYWORDS,
  STATE_KEYWORDS,
} from "../../src/memory/query-routing-keywords";
import { tokenizeQuery } from "../../src/memory/query-tokenizer";
import type { AliasService } from "../../src/memory/alias";
import type { QueryType } from "../../src/memory/types";

/**
 * Shadow parity test for Phase 1 router rollout.
 *
 * Replicates GraphNavigator.analyzeQuery's classification logic in this file
 * (priority chain: explicitMode > why > conflict > timeline > relationship >
 * state > entity > event) and asserts that for every fixture query the
 * router's primaryIntent equals the legacy result.
 *
 * Goal: ≥ 95% agreement across 30+ fixtures.
 */

const ALIAS_MAP: Record<string, number> = {
  Alice: 1,
  alice: 1,
  Bob: 2,
  bob: 2,
  Carol: 3,
  carol: 3,
};

function makeAlias(): AliasService {
  return {
    async resolveAlias(alias: string): Promise<number | null> {
      return ALIAS_MAP[alias] ?? null;
    },
  } as unknown as AliasService;
}

/** Inline copy of GraphNavigator.analyzeQuery's classification logic. */
async function legacyClassify(query: string, alias: AliasService): Promise<QueryType> {
  const normalized = query.trim().toLowerCase();
  const tokens = tokenizeQuery(query);
  const resolvedEntityIds = new Set<number>();
  for (const token of tokens) {
    const aliasToken = token.startsWith("@") ? token.slice(1) : token;
    if (aliasToken.length < 2) continue;
    const id = await alias.resolveAlias(aliasToken);
    if (id !== null) resolvedEntityIds.add(id);
  }

  const includesAny = (needles: readonly string[]) =>
    needles.some((n) => normalized.includes(n));

  if (includesAny(WHY_KEYWORDS)) return "why";
  if (includesAny(CONFLICT_KEYWORDS)) return "conflict";
  if (includesAny(TIMELINE_KEYWORDS)) return "timeline";
  if (includesAny(RELATIONSHIP_KEYWORDS)) return "relationship";
  if (includesAny(STATE_KEYWORDS)) return "state";
  if (resolvedEntityIds.size > 0) return "entity";
  return "event";
}

/** 30+ fixtures covering every legacy classifier branch and CJK. */
const FIXTURES: string[] = [
  // why (Latin + CJK)
  "why did Alice leave",
  "what is the reason for the conflict",
  "因为什么 Alice 突然离开了",
  "为何 Bob 没有回来",

  // conflict
  "Alice and Bob have a conflict",
  "this is a contested claim",
  "他们之间产生了矛盾",
  "存在分歧的事件",

  // timeline
  "timeline of the events",
  "what happened before the meeting",
  "sequence of events leading up",
  "事件的先后顺序",
  "什么时候发生的",

  // relationship
  "what is the connection",
  "Alice is related to Bob",
  "Alice 和 Bob 的交情",
  "他们的相关事件",

  // state
  "current status of the project",
  "what is the state now",
  "目前的现状如何",
  "Alice 当前在哪里",

  // entity-only
  "Alice",
  "@Bob",
  "Alice and Bob and Carol",

  // event fallback
  "lorem ipsum",
  "tell me about the meeting",
  "describe the situation",
  "告诉我详细经过",

  // explicit mode targets handled separately

  // multi-intent — primary should follow legacy priority
  "为什么发生了冲突",            // why wins over conflict
  "before the conflict",          // conflict wins over timeline ("before")
  "timeline of the relationship", // timeline wins over relationship
  "current relationship",         // relationship wins over state
  "Alice's current state",        // state wins over entity
];

describe("QueryRouter shadow parity", () => {
  it("agrees with legacy analyzeQuery on ≥ 95% of fixtures", async () => {
    const alias = makeAlias();
    const router = new RuleBasedQueryRouter(alias);

    const disagreements: Array<{ query: string; legacy: QueryType; router: QueryType }> = [];

    for (const query of FIXTURES) {
      const legacy = await legacyClassify(query, alias);
      const route = await router.route({ query, viewerAgentId: "agent_test" });
      if (route.primaryIntent !== legacy) {
        disagreements.push({ query, legacy, router: route.primaryIntent });
      }
    }

    const agreementRate = (FIXTURES.length - disagreements.length) / FIXTURES.length;
    if (disagreements.length > 0) {
      // Print diagnostics for any disagreements (visible on test failure)
      console.error("Disagreements:", JSON.stringify(disagreements, null, 2));
    }
    expect(agreementRate).toBeGreaterThanOrEqual(0.95);
    expect(FIXTURES.length).toBeGreaterThanOrEqual(30);
  });

  it("explicit mode overrides keyword classification (matches legacy)", async () => {
    const alias = makeAlias();
    const router = new RuleBasedQueryRouter(alias);

    // Legacy uses `mode` directly when present
    const route = await router.route({
      query: "why did this happen",
      viewerAgentId: "agent_test",
      explicitMode: "state",
    });
    expect(route.primaryIntent).toBe("state");
  });

  it("multi-intent fixtures expose intents.length >= 2", async () => {
    const alias = makeAlias();
    const router = new RuleBasedQueryRouter(alias);

    const multiIntentQueries = [
      "为什么发生了冲突",                    // why + conflict
      "为什么Alice和Bob的关系最近变了",     // why + relationship
      "before the conflict yesterday",      // conflict + timeline
    ];

    for (const query of multiIntentQueries) {
      const route = await router.route({ query, viewerAgentId: "agent_test" });
      expect(route.intents.length).toBeGreaterThanOrEqual(2);
    }
  });
});
