import { describe, expect, it } from "bun:test";
import { RuleBasedQueryRouter } from "../../src/memory/query-router";
import type { AliasService } from "../../src/memory/alias";

const ALIAS_MAP: Record<string, number> = {
  Alice: 1,
  alice: 1,
  Bob: 2,
  bob: 2,
  Carol: 3,
  carol: 3,
  Dave: 4,
  dave: 4,
};

function makeAlias(): AliasService {
  return {
    async resolveAlias(alias: string): Promise<number | null> {
      return ALIAS_MAP[alias] ?? null;
    },
  } as unknown as AliasService;
}

function makeRouter(): RuleBasedQueryRouter {
  return new RuleBasedQueryRouter(makeAlias());
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe("QueryRouter — timeConstraint derivation", () => {
  it("yesterday → asOfCommittedTime ≈ now - 24h", async () => {
    const before = Date.now();
    const route = await makeRouter().route({
      query: "what happened yesterday",
      viewerAgentId: "agent_test",
    });
    const after = Date.now();
    expect(route.timeConstraint).not.toBeNull();
    expect(route.timeConstraint!.asOfCommittedTime).toBeDefined();
    const t = route.timeConstraint!.asOfCommittedTime!;
    expect(t).toBeGreaterThanOrEqual(before - ONE_DAY_MS);
    expect(t).toBeLessThanOrEqual(after - ONE_DAY_MS);
  });

  it("昨天 (CJK) → asOfCommittedTime ≈ now - 24h", async () => {
    const before = Date.now();
    const route = await makeRouter().route({
      query: "昨天发生了什么",
      viewerAgentId: "agent_test",
    });
    const after = Date.now();
    expect(route.timeConstraint).not.toBeNull();
    const t = route.timeConstraint!.asOfCommittedTime!;
    expect(t).toBeGreaterThanOrEqual(before - ONE_DAY_MS);
    expect(t).toBeLessThanOrEqual(after - ONE_DAY_MS);
  });

  it("today / 今天 → asOfCommittedTime ≈ now", async () => {
    const before = Date.now();
    const route = await makeRouter().route({
      query: "今天的事件",
      viewerAgentId: "agent_test",
    });
    const after = Date.now();
    expect(route.timeConstraint).not.toBeNull();
    const t = route.timeConstraint!.asOfCommittedTime!;
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it("recent / 最近 → 7-day window", async () => {
    const before = Date.now();
    const route = await makeRouter().route({
      query: "最近的事件",
      viewerAgentId: "agent_test",
    });
    const after = Date.now();
    expect(route.timeConstraint).not.toBeNull();
    const t = route.timeConstraint!.asOfCommittedTime!;
    expect(t).toBeGreaterThanOrEqual(before - 7 * ONE_DAY_MS);
    expect(t).toBeLessThanOrEqual(after - 7 * ONE_DAY_MS);
  });

  it("recently (Latin) → 7-day window", async () => {
    const before = Date.now();
    const route = await makeRouter().route({
      query: "what happened recently",
      viewerAgentId: "agent_test",
    });
    const after = Date.now();
    const t = route.timeConstraint!.asOfCommittedTime!;
    expect(t).toBeGreaterThanOrEqual(before - 7 * ONE_DAY_MS);
    expect(t).toBeLessThanOrEqual(after - 7 * ONE_DAY_MS);
  });

  it("last week / 上周 → 7-day window", async () => {
    const before = Date.now();
    const route = await makeRouter().route({
      query: "上周的事件",
      viewerAgentId: "agent_test",
    });
    const after = Date.now();
    const t = route.timeConstraint!.asOfCommittedTime!;
    expect(t).toBeGreaterThanOrEqual(before - 7 * ONE_DAY_MS);
    expect(t).toBeLessThanOrEqual(after - 7 * ONE_DAY_MS);
  });

  it("last month / 上个月 → 30-day window", async () => {
    const before = Date.now();
    const route = await makeRouter().route({
      query: "上个月发生了什么",
      viewerAgentId: "agent_test",
    });
    const after = Date.now();
    const t = route.timeConstraint!.asOfCommittedTime!;
    expect(t).toBeGreaterThanOrEqual(before - 30 * ONE_DAY_MS);
    expect(t).toBeLessThanOrEqual(after - 30 * ONE_DAY_MS);
  });

  it("query without time keyword → timeConstraint = null", async () => {
    const route = await makeRouter().route({
      query: "Alice and Bob",
      viewerAgentId: "agent_test",
    });
    expect(route.timeConstraint).toBeNull();
  });

  it("matchedRules includes time_window_derived when timeConstraint set", async () => {
    const route = await makeRouter().route({
      query: "yesterday Alice left",
      viewerAgentId: "agent_test",
    });
    expect(route.matchedRules).toContain("time_window_derived");
  });

  it("matchedRules omits time_window_derived when no time keyword", async () => {
    const route = await makeRouter().route({
      query: "Alice left",
      viewerAgentId: "agent_test",
    });
    expect(route.matchedRules).not.toContain("time_window_derived");
  });
});

describe("QueryRouter — relationPairs derivation", () => {
  it("0 entities → []", async () => {
    const route = await makeRouter().route({
      query: "lorem ipsum",
      viewerAgentId: "agent_test",
    });
    expect(route.relationPairs).toEqual([]);
  });

  it("1 entity → []", async () => {
    const route = await makeRouter().route({
      query: "Alice",
      viewerAgentId: "agent_test",
    });
    expect(route.relationPairs).toEqual([]);
  });

  it("2 entities → 1 pair [[1,2]]", async () => {
    const route = await makeRouter().route({
      query: "Alice and Bob",
      viewerAgentId: "agent_test",
    });
    expect(route.relationPairs.length).toBe(1);
    expect(route.relationPairs[0]).toEqual([1, 2]);
  });

  it("3 entities → 3 pairs", async () => {
    const route = await makeRouter().route({
      query: "Alice Bob Carol",
      viewerAgentId: "agent_test",
    });
    expect(route.relationPairs.length).toBe(3);
    // C(3,2) = 3, ordered (i<j) by resolution order: Alice=1, Bob=2, Carol=3
    const serialized = route.relationPairs.map((p) => `${p[0]},${p[1]}`);
    expect(serialized).toContain("1,2");
    expect(serialized).toContain("1,3");
    expect(serialized).toContain("2,3");
  });

  it("4 entities → 6 pairs", async () => {
    const route = await makeRouter().route({
      query: "Alice Bob Carol Dave",
      viewerAgentId: "agent_test",
    });
    expect(route.relationPairs.length).toBe(6);
  });

  it("matchedRules includes relation_pairs:N when pairs exist", async () => {
    const route = await makeRouter().route({
      query: "Alice and Bob",
      viewerAgentId: "agent_test",
    });
    expect(route.matchedRules.some((r) => r.startsWith("relation_pairs:"))).toBe(true);
  });
});
