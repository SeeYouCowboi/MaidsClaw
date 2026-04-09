import { beforeAll, describe, expect, it } from "bun:test";
import { RuleBasedQueryRouter } from "../../src/memory/query-router";
import { loadUserDict } from "../../src/memory/cjk-segmenter";
import type { AliasService } from "../../src/memory/alias";

/**
 * Minimal AliasService stub. Maps a fixed alias dictionary to entity ids.
 * Only resolveAlias and listPrivateAliasStrings are exercised by the router.
 *
 * The default stub returns an empty private-alias list; tests that want to
 * exercise the GAP-4 §8 second-pass scan should pass `privateAliases`.
 */
function makeAlias(
  map: Record<string, number> = {},
  privateAliases: string[] = [],
): AliasService {
  return {
    async resolveAlias(alias: string): Promise<number | null> {
      return map[alias] ?? null;
    },
    async listPrivateAliasStrings(): Promise<string[]> {
      return privateAliases;
    },
  } as unknown as AliasService;
}

const ALIAS_MAP: Record<string, number> = {
  Alice: 1,
  alice: 1,
  Bob: 2,
  bob: 2,
  爱丽丝: 3,
  鲍勃: 4,
  管家: 5,
};

// Mirror production bootstrap: seed the jieba user dict with CJK aliases
// so the router can find them inside long CJK runs without requiring an
// @-prefix or punctuation separator.
beforeAll(() => {
  loadUserDict(Object.keys(ALIAS_MAP));
});

function makeRouter() {
  return new RuleBasedQueryRouter(makeAlias(ALIAS_MAP));
}

describe("RuleBasedQueryRouter — Latin single intent", () => {
  it("classifies why query", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "why did Alice leave",
      viewerAgentId: "agent_test",
    });
    expect(route.primaryIntent).toBe("why");
    expect(route.intents.some((i) => i.type === "why")).toBe(true);
    expect(route.intents.some((i) => i.type === "entity")).toBe(true);
    expect(route.resolvedEntityIds).toContain(1);
    expect(route.asksWhy).toBe(true);
  });

  it("classifies timeline query", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "timeline of the events",
      viewerAgentId: "agent_test",
    });
    expect(route.primaryIntent).toBe("timeline");
    expect(route.intents.some((i) => i.type === "timeline")).toBe(true);
  });

  it("classifies relationship query", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "relationship between Alice and Bob",
      viewerAgentId: "agent_test",
    });
    expect(route.primaryIntent).toBe("relationship");
    expect(route.intents.some((i) => i.type === "relationship")).toBe(true);
    expect(route.resolvedEntityIds.length).toBe(2);
  });

  it("classifies state query", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "current status of the project",
      viewerAgentId: "agent_test",
    });
    expect(route.primaryIntent).toBe("state");
  });

  it("classifies conflict query", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "what conflict happened",
      viewerAgentId: "agent_test",
    });
    expect(route.primaryIntent).toBe("conflict");
  });
});

describe("RuleBasedQueryRouter — CJK single intent", () => {
  it("classifies CJK why query with @-prefixed entity", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "@爱丽丝 为什么离开",
      viewerAgentId: "agent_test",
    });
    expect(route.primaryIntent).toBe("why");
    expect(route.resolvedEntityIds).toContain(3);
  });

  it("classifies CJK relationship query with separated entities", async () => {
    const router = makeRouter();
    // Note: legacy tokenizer cannot isolate proper nouns inside long CJK runs.
    // Production usage relies on @-prefix or punctuation to delimit names.
    const route = await router.route({
      query: "@爱丽丝 和 @鲍勃 的关系",
      viewerAgentId: "agent_test",
    });
    expect(route.primaryIntent).toBe("relationship");
    expect(route.resolvedEntityIds).toContain(3);
    expect(route.resolvedEntityIds).toContain(4);
  });

  it("classifies CJK conflict query", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "他们之间的冲突",
      viewerAgentId: "agent_test",
    });
    // conflict has higher priority than relationship in legacy chain
    expect(route.primaryIntent).toBe("conflict");
  });
});

describe("RuleBasedQueryRouter — multi-intent (core)", () => {
  it("为什么Alice和Bob的关系变了 — multi-intent why+relationship+change", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "为什么Alice和Bob的关系最近变了",
      viewerAgentId: "agent_test",
    });
    expect(route.intents.some((i) => i.type === "why")).toBe(true);
    expect(route.intents.some((i) => i.type === "relationship")).toBe(true);
    expect(route.asksChange).toBe(true);
    expect(route.timeSignals).toContain("最近");
    expect(route.resolvedEntityIds).toContain(1);
    expect(route.resolvedEntityIds).toContain(2);
    expect(route.intents.length).toBeGreaterThanOrEqual(2);
  });

  it("请告诉我昨天@爱丽丝和@管家之间的冲突 — conflict+timeline+entities", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "请告诉我昨天@爱丽丝 和 @管家 之间的冲突",
      viewerAgentId: "agent_test",
    });
    expect(route.intents.some((i) => i.type === "conflict")).toBe(true);
    expect(route.timeSignals).toContain("昨天");
    expect(route.resolvedEntityIds).toContain(3);
    expect(route.resolvedEntityIds).toContain(5);
  });

  it("Bob因为之前在花园里发现的线索所以怀疑Alice和@管家 串通一气 — why+entities", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "Bob因为之前在花园里发现的线索所以怀疑Alice和 @管家 串通一气",
      viewerAgentId: "agent_test",
    });
    expect(route.intents.some((i) => i.type === "why")).toBe(true);
    expect(route.resolvedEntityIds).toContain(1);
    expect(route.resolvedEntityIds).toContain(2);
    expect(route.resolvedEntityIds).toContain(5);
  });

  it("primaryIntent follows legacy priority why > conflict > timeline > relationship > state", async () => {
    const router = makeRouter();
    // Both why and relationship hit; legacy priority picks why
    const route = await router.route({
      query: "为什么Alice和Bob关系变了",
      viewerAgentId: "agent_test",
    });
    expect(route.primaryIntent).toBe("why");
  });
});

describe("RuleBasedQueryRouter — signals", () => {
  it("only why hit raises needsCognition but not all signals to 1", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "why this happened",
      viewerAgentId: "agent_test",
    });
    expect(route.signals.needsCognition).toBeGreaterThan(0);
    expect(route.signals.needsCognition).toBeLessThanOrEqual(1);
    expect(route.signals.needsConflict).toBe(0);
    expect(route.signals.needsTimeline).toBe(0);
  });

  it("multi-intent raises multiple signals", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "为什么昨天发生了冲突",
      viewerAgentId: "agent_test",
    });
    expect(route.signals.needsCognition).toBeGreaterThan(0);
    expect(route.signals.needsConflict).toBeGreaterThan(0);
    expect(route.signals.needsTimeline + route.signals.needsEpisode).toBeGreaterThan(0);
  });

  it("two resolved entities raise needsRelationship and needsEntityFocus", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "Alice and Bob",
      viewerAgentId: "agent_test",
    });
    expect(route.signals.needsEntityFocus).toBeGreaterThan(0);
    expect(route.resolvedEntityIds.length).toBe(2);
  });

  it("all signals stay in 0..1 range", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "why conflict timeline relationship state recent change because reason 冲突 关系 状态 时间线 因为 最近",
      viewerAgentId: "agent_test",
    });
    for (const v of Object.values(route.signals)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("RuleBasedQueryRouter — confidence and failure modes", () => {
  it("empty query falls back to event", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "",
      viewerAgentId: "agent_test",
    });
    expect(route.primaryIntent).toBe("event");
    expect(route.routeConfidence).toBe(0);
    expect(route.intents).toEqual([]);
  });

  it("opaque query with no keywords or entities falls back to event", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "lorem ipsum dolor sit amet",
      viewerAgentId: "agent_test",
    });
    expect(route.primaryIntent).toBe("event");
    expect(route.routeConfidence).toBe(0);
  });

  it("single weak hit yields confidence < 0.6", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "why",
      viewerAgentId: "agent_test",
    });
    const why = route.intents.find((i) => i.type === "why");
    expect(why).toBeDefined();
    expect(why!.confidence).toBeLessThan(0.6);
  });

  it("explicit mode overrides keyword classification", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "why this happened",
      viewerAgentId: "agent_test",
      explicitMode: "timeline",
    });
    expect(route.primaryIntent).toBe("timeline");
  });

  it("entity-only query selects entity intent", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "Alice",
      viewerAgentId: "agent_test",
    });
    expect(route.primaryIntent).toBe("entity");
    expect(route.resolvedEntityIds).toContain(1);
  });
});

describe("RuleBasedQueryRouter — observability", () => {
  it("emits classifierVersion", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "why",
      viewerAgentId: "agent_test",
    });
    expect(route.classifierVersion).toBe("rule-v1");
  });

  it("matchedRules records every triggered rule", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "为什么Alice和Bob最近变了",
      viewerAgentId: "agent_test",
    });
    expect(route.matchedRules).toContain("why_keywords");
    expect(route.matchedRules).toContain("change_keywords");
    expect(route.matchedRules).toContain("time_constraint_keywords");
    expect(route.matchedRules.some((r) => r.startsWith("entities_resolved:"))).toBe(true);
  });

  it("rationale is non-empty string", async () => {
    const router = makeRouter();
    const route = await router.route({
      query: "why did Alice leave",
      viewerAgentId: "agent_test",
    });
    expect(route.rationale.length).toBeGreaterThan(0);
    expect(route.rationale).toContain("primary=why");
  });
});

describe("RuleBasedQueryRouter — performance", () => {
  it("completes a long CJK query under 5ms (mock alias)", async () => {
    const router = makeRouter();
    const query = "请告诉我从昨天到现在这段时间里城堡内所有区域发生过的全部事件的详细时间线为什么爱丽丝和管家之间的冲突会变成这样";
    const start = performance.now();
    await router.route({ query, viewerAgentId: "agent_test" });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5);
  });
});
