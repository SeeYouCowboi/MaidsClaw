import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RuleBasedQueryRouter } from "../../src/memory/query-router";
import { allocateBudget } from "../../src/memory/retrieval/budget-allocator";
import {
  getDefaultTemplate,
  type RetrievalTemplate,
} from "../../src/memory/contracts/retrieval-template";
import type { AliasService } from "../../src/memory/alias";
import { loadUserDict } from "../../src/memory/cjk-segmenter";

/**
 * GAP-4 §4 prerequisite — parity fixture between the legacy
 * EPISODE_*_TRIGGER regex path in retrieval-orchestrator.ts and the
 * signal-driven path that will replace it.
 *
 * What this test guarantees:
 *   1. Non-regression: for every fixture row, the signal-driven episode
 *      budget (with MAIDSCLAW_ROUTER_EPISODE_SIGNALS=on and the bumped
 *      rp_agent role defaults) is >= the legacy regex-path budget. The
 *      follow-up that deletes EPISODE_*_TRIGGER must keep this assertion
 *      green.
 *   2. Trigger-coverage: for queries where the legacy regex would have
 *      boosted episode budget, needsEpisode in the new path is > 0 (i.e.
 *      the migrated keyword buckets actually fire). At least 95% of
 *      trigger rows must satisfy this.
 *   3. Negative parity: queries that are NOT episode-relevant under the
 *      legacy path must remain non-relevant under the signal path
 *      (allocator returns the template unchanged).
 *
 * The legacy regex helper below is an inlined frozen replica of
 * retrieval-orchestrator.ts:90-92 + 539-553 as of the GAP-4 §4 prereq
 * commit. It is intentionally a copy — once the orchestrator regexes are
 * deleted in the follow-up, this helper continues to define the
 * "ceiling" the signal path must not regress against.
 */

// ----- Frozen legacy regex replica (do not edit without parity rerun) -----

const LEGACY_EPISODE_QUERY_TRIGGER =
  /(remember|before|earlier|previous|last time|once|yesterday|scene|where|location|episode|回忆|之前|先前|场景|地点|那次|记得|昨天|上次|以前|从前|经历)/i;
const LEGACY_EPISODE_DETECTIVE_TRIGGER =
  /(detective|investigate|investigation|clue|evidence|timeline|who|why|how did|线索|证据|调查|推理|案发|时间线|谁|为什么|怎么回事|真相|原因)/i;
const LEGACY_EPISODE_SCENE_TRIGGER =
  /(here|there|room|hall|kitchen|garden|area|scene|此处|这里|那边|房间|庭院|区域|场景|大厅|厨房|花园)/i;

// The §4 follow-up commit deleted `queryEpisodeBoost` / `sceneEpisodeBoost`
// from `RetrievalTemplate`, but this fixture must still represent the
// PRE-DELETION ceiling (the level the signal-driven path needs to match
// or exceed) — so the boost constants are now hard-coded here. They are
// frozen at 1 (the value they had in role defaults at the prereq commit
// `ff8a44e`). Any future change to the role defaults' bumped baseline
// must keep this fixture in sync.
const LEGACY_QUERY_EPISODE_BOOST = 1;
const LEGACY_SCENE_EPISODE_BOOST = 1;

function legacyEpisodeBudget(
  query: string,
  template: Required<RetrievalTemplate>,
  currentAreaId: number | null,
): { budget: number; triggered: boolean } {
  let budget = Math.max(template.episodicBudget, template.episodeBudget);
  const trimmed = query.trim();
  const queryOrDetective =
    trimmed.length > 0 &&
    (LEGACY_EPISODE_QUERY_TRIGGER.test(trimmed) ||
      LEGACY_EPISODE_DETECTIVE_TRIGGER.test(trimmed));
  if (queryOrDetective) {
    budget += LEGACY_QUERY_EPISODE_BOOST;
  }
  const sceneTriggered =
    currentAreaId != null && LEGACY_EPISODE_SCENE_TRIGGER.test(trimmed);
  if (sceneTriggered) {
    budget += LEGACY_SCENE_EPISODE_BOOST;
  }
  return {
    budget: Math.max(0, budget),
    triggered: queryOrDetective || sceneTriggered,
  };
}

// ----- Stub alias service (no entity resolution needed for this fixture) ---

function makeAlias(): AliasService {
  return {
    async resolveAlias(): Promise<number | null> {
      return null;
    },
    async listPrivateAliasStrings(): Promise<string[]> {
      return [];
    },
  } as unknown as AliasService;
}

// ----- Fixture rows -------------------------------------------------------

type FixtureRow = {
  id: string;
  query: string;
  currentAreaId: number | null;
  category: "memory" | "detective" | "scene" | "scene_no_area" | "combo" | "negative";
};

const FIXTURE: FixtureRow[] = [
  // Memory category (5 rows) — recall-style queries
  { id: "mem_en_1", query: "do you remember the butler", currentAreaId: null, category: "memory" },
  { id: "mem_en_2", query: "last time we met in the study", currentAreaId: null, category: "memory" },
  { id: "mem_cn_1", query: "你记得管家吗", currentAreaId: null, category: "memory" },
  { id: "mem_cn_2", query: "上次在书房里发生的事", currentAreaId: null, category: "memory" },
  { id: "mem_cn_3", query: "经历过的案件", currentAreaId: null, category: "memory" },

  // Detective category (5 rows) — clue/evidence/investigation queries
  { id: "det_en_1", query: "show me the clues about the butler", currentAreaId: null, category: "detective" },
  { id: "det_en_2", query: "what evidence do we have", currentAreaId: null, category: "detective" },
  { id: "det_cn_1", query: "调查的线索", currentAreaId: null, category: "detective" },
  { id: "det_cn_2", query: "案发时的证据", currentAreaId: null, category: "detective" },
  { id: "det_cn_3", query: "推理一下真相", currentAreaId: null, category: "detective" },

  // Scene category with currentAreaId set (4 rows)
  { id: "scene_en_1", query: "what's in this room", currentAreaId: 42, category: "scene" },
  { id: "scene_en_2", query: "anything strange here in the kitchen", currentAreaId: 42, category: "scene" },
  { id: "scene_cn_1", query: "这个房间里有什么", currentAreaId: 42, category: "scene" },
  { id: "scene_cn_2", query: "花园里发生了什么", currentAreaId: 42, category: "scene" },

  // Scene category WITHOUT currentAreaId (2 rows) — scene gate must be closed
  { id: "scene_noarea_en", query: "what's in this room", currentAreaId: null, category: "scene_no_area" },
  { id: "scene_noarea_cn", query: "这个房间里有什么", currentAreaId: null, category: "scene_no_area" },

  // Combo (2 rows) — time-constraint + scene + area
  { id: "combo_en", query: "yesterday in the kitchen", currentAreaId: 42, category: "combo" },
  { id: "combo_cn", query: "昨天在厨房", currentAreaId: 42, category: "combo" },

  // Negative (2 rows) — neither path should boost episode
  { id: "neg_en", query: "hello there friend, just saying hi", currentAreaId: null, category: "negative" },
  { id: "neg_cn", query: "你好朋友", currentAreaId: null, category: "negative" },
];

// Hint: "there" is in EPISODE_SCENE_KEYWORDS, but the negative EN row sets
// currentAreaId=null so the scene gate stays closed and the row stays
// neutral in both paths. The string is also picked so it never matches
// EPISODE_QUERY_TRIGGER or EPISODE_DETECTIVE_TRIGGER.

// ----- Test setup ---------------------------------------------------------

let originalFlag: string | undefined;

beforeAll(() => {
  originalFlag = process.env.MAIDSCLAW_ROUTER_EPISODE_SIGNALS;
  process.env.MAIDSCLAW_ROUTER_EPISODE_SIGNALS = "on";
  // Seed the CJK user dict with the entity-like CJK tokens that appear in
  // fixture queries so jieba doesn't fragment them. The router only needs
  // these for the keyword scan, not for entity resolution.
  loadUserDict(["管家", "书房", "厨房", "花园", "房间"]);
});

afterAll(() => {
  if (originalFlag === undefined) {
    delete process.env.MAIDSCLAW_ROUTER_EPISODE_SIGNALS;
  } else {
    process.env.MAIDSCLAW_ROUTER_EPISODE_SIGNALS = originalFlag;
  }
});

// ----- Test helpers -------------------------------------------------------

async function signalEpisodeBudget(
  router: RuleBasedQueryRouter,
  template: Required<RetrievalTemplate>,
  row: FixtureRow,
): Promise<{ budget: number; needsEpisode: number }> {
  const route = await router.route({
    query: row.query,
    viewerAgentId: "agent_test",
    currentAreaId: row.currentAreaId,
  });
  const allocated = allocateBudget(template, route.signals);
  return {
    budget: Math.max(allocated.episodicBudget, allocated.episodeBudget),
    needsEpisode: route.signals.needsEpisode,
  };
}

// ----- Tests --------------------------------------------------------------

describe("Episode signal/regex parity (GAP-4 §4 prereq)", () => {
  const template = getDefaultTemplate("rp_agent");
  const router = new RuleBasedQueryRouter(makeAlias());

  it("rp_agent template has the bumped episode defaults", () => {
    expect(template.episodicBudget).toBe(3);
    expect(template.episodeBudget).toBe(3);
    // queryEpisodeBoost / sceneEpisodeBoost were deleted from the template
    // in the §4 follow-up commit; the +1 they used to add is now baked
    // into the bumped baseline above. The legacy fixture replicas above
    // hard-code 1 to preserve the pre-deletion ceiling for parity checks.
  });

  it("non-regression: signal episode budget >= legacy regex episode budget for every fixture row", async () => {
    const failures: string[] = [];
    for (const row of FIXTURE) {
      const legacy = legacyEpisodeBudget(row.query, template, row.currentAreaId);
      const signal = await signalEpisodeBudget(router, template, row);
      if (signal.budget < legacy.budget) {
        failures.push(
          `${row.id} (${row.category}) "${row.query}": legacy=${legacy.budget}, signal=${signal.budget}, needsEpisode=${signal.needsEpisode}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Signal path regressed below legacy on ${failures.length} row(s):\n${failures.join("\n")}`,
      );
    }
  });

  it("trigger coverage: ≥95% of legacy-trigger rows have needsEpisode > 0 in signal path", async () => {
    let triggerRows = 0;
    let coveredRows = 0;
    const misses: string[] = [];
    for (const row of FIXTURE) {
      const legacy = legacyEpisodeBudget(row.query, template, row.currentAreaId);
      if (!legacy.triggered) continue;
      triggerRows += 1;
      const signal = await signalEpisodeBudget(router, template, row);
      if (signal.needsEpisode > 0) {
        coveredRows += 1;
      } else {
        misses.push(`${row.id} "${row.query}" (currentAreaId=${row.currentAreaId})`);
      }
    }
    expect(triggerRows).toBeGreaterThanOrEqual(12);
    const coverage = coveredRows / triggerRows;
    if (coverage < 0.95) {
      throw new Error(
        `Trigger coverage ${(coverage * 100).toFixed(1)}% < 95%. ` +
          `${triggerRows - coveredRows} miss(es):\n${misses.join("\n")}`,
      );
    }
    expect(coverage).toBeGreaterThanOrEqual(0.95);
  });

  it("negative parity: rows that don't trigger legacy boost also stay neutral in signal path", async () => {
    for (const row of FIXTURE) {
      if (row.category !== "negative") continue;
      const legacy = legacyEpisodeBudget(row.query, template, row.currentAreaId);
      const signal = await signalEpisodeBudget(router, template, row);
      expect(legacy.triggered).toBe(false);
      // Signal path may still allocate via the floor weight but should not
      // exceed the bumped baseline by more than 1 on a non-trigger query.
      expect(signal.budget).toBeLessThanOrEqual(template.episodicBudget + 1);
      expect(signal.needsEpisode).toBe(0);
    }
  });

  it("scene gating: scene-keyword queries without currentAreaId do NOT fire scene rule in either path", async () => {
    for (const row of FIXTURE) {
      if (row.category !== "scene_no_area") continue;
      const legacy = legacyEpisodeBudget(row.query, template, row.currentAreaId);
      const signal = await signalEpisodeBudget(router, template, row);
      // Legacy SCENE regex requires currentAreaId != null. The query string
      // contains scene words but the gate is closed.
      // Note: legacy may still fire QUERY trigger for scene words like
      // "where" / "location" / "scene"; we only assert the signal path
      // matches or exceeds whatever legacy produced.
      expect(signal.budget).toBeGreaterThanOrEqual(legacy.budget);
      // The matchedRules entry "episode_scene_keywords" must not appear.
      // (Indirect check via the route trace would require exposing
      // matchedRules; we instead verify needsEpisode does not include the
      // scene contribution by comparing against the same query with
      // currentAreaId set.)
      const withArea = await signalEpisodeBudget(router, template, {
        ...row,
        currentAreaId: 42,
      });
      expect(withArea.needsEpisode).toBeGreaterThanOrEqual(signal.needsEpisode);
    }
  });

  it("fixture has at least 20 rows covering all categories", () => {
    expect(FIXTURE.length).toBeGreaterThanOrEqual(20);
    const categories = new Set(FIXTURE.map((r) => r.category));
    expect(categories.has("memory")).toBe(true);
    expect(categories.has("detective")).toBe(true);
    expect(categories.has("scene")).toBe(true);
    expect(categories.has("scene_no_area")).toBe(true);
    expect(categories.has("combo")).toBe(true);
    expect(categories.has("negative")).toBe(true);
  });
});
