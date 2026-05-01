/**
 * Regression baselines drawn from the rp:mei 150-turn live test report
 * (see project memory: project_rp_live_tests.md).
 *
 * Each test pins a specific bad-case turn from that transcript and asserts
 * the post-A+C ingestion + ranking pipeline produces the expected behavior.
 *
 * Out of scope here (these are Layer B canonical-merge problems, not
 * solvable by ingestion filtering or rank floor):
 *   - T70/T80 银怀表 ↔ silver_pocket_watch ↔ item:silver_pocket_watch split
 *   - T88   "花房那边的人" → Alice resolution
 * If we add Layer B (deterministic alias seeding + judge follow-up), add
 * regression cases for those here.
 */
import { describe, expect, it } from "bun:test";

import { normalizeEntityMentions } from "./entity-mentions.js";
import { __knownEntitiesTestInternals__ } from "./prompt-data.js";

const { mergeKnownEntityCandidates, rankRecentSessionEntities } =
  __knownEntitiesTestInternals__;

// World seed + mei persona — matches buildCoreEntityPointerKeys() output.
const REGRESSION_CORE_KEYS: ReadonlySet<string> = new Set([
  "茶室",
  "温室",
  "花房",
  "书房",
  "管家",
  "梅姨",
  "alice",
  "mei",
]);

describe("regression: T110 — red-tea preference turn (rp:mei)", () => {
  it("filters function-word noise from the LLM-emitted entity mention list", () => {
    // Synthetic but representative of what the writer model produced for T110:
    // a real entity (红茶), the action ('喝'-style noise), and adjective/noun
    // function words that previously slipped into entity_nodes.
    const raw = [
      "红茶",
      "太苦",
      "偏好",
      "感觉",
      "喜欢",
      "这么",
      "要是",
      "char:butler",
    ];
    expect(normalizeEntityMentions(raw)).toEqual(["红茶", "char:butler"]);
  });
});

describe("regression: T147 — door/window state audit turn (rp:mei)", () => {
  it("drops single-CJK-char surfaces like 门 from the ingestion stream", () => {
    expect(
      normalizeEntityMentions(["门", "窗户", "alice", "管家", "金怀表"]),
    ).toEqual(["窗户", "alice", "管家", "金怀表"]);
  });

  it("ranks Alice and 管家 above scene-state nouns even when scene-state is fresher", () => {
    // T147 ordering before fix: 门, 窗户, 金怀表, 银怀表 occupied the top
    // slots; alice / 管家 were last-mentioned ~30 turns earlier and got
    // evicted. After fix, core entities (alice, 管家) must precede non-core
    // scene-state survivors (窗户, 金怀表, 银怀表).
    const settlementRows = [
      // Recency order: window/items are the freshest mentions in this turn.
      { pointer_key: "窗户", display_name: null, summary: null },
      { pointer_key: "金怀表", display_name: null, summary: null },
      { pointer_key: "银怀表", display_name: null, summary: null },
      // Alice and 管家 appeared earlier in the session; older recency.
      { pointer_key: "管家", display_name: null, summary: null },
      { pointer_key: "alice", display_name: "Alice", summary: null },
    ];

    const merged = mergeKnownEntityCandidates({
      recent: rankRecentSessionEntities(settlementRows, 3),
      corePointerKeys: REGRESSION_CORE_KEYS,
    });

    const order = merged.map((e) => e.pointer_key);
    expect(order.indexOf("管家")).toBeLessThan(order.indexOf("窗户"));
    expect(order.indexOf("alice")).toBeLessThan(order.indexOf("窗户"));
    expect(order.indexOf("管家")).toBeLessThan(order.indexOf("金怀表"));
    expect(order.indexOf("alice")).toBeLessThan(order.indexOf("银怀表"));
  });
});

describe("regression: known noise tokens from the 150-turn report", () => {
  it.each([
    "早安",
    "安静",
    "正式",
    "随便",
    "聊聊",
    "这么",
    "要是",
    "感觉",
    "一遍",
    "假设",
    "偏好",
    "太苦",
    "喜欢",
    "还是",
  ])("rejects %s as a candidate entity surface", (token) => {
    expect(normalizeEntityMentions([token])).toEqual([]);
  });
});

describe("regression: must NOT regress canonical entity surfaces", () => {
  it.each([
    ["茶室", "茶室"],
    ["温室", "温室"],
    ["花房", "花房"],
    ["书房", "书房"],
    ["管家", "管家"],
    ["梅姨", "梅姨"],
    ["Alice", "Alice"],
    ["银怀表", "银怀表"],
    ["金怀表", "金怀表"],
    ["花房的人", "花房的人"],
    ["char:butler", "char:butler"],
    ["item:silver_pocket_watch", "item:silver_pocket_watch"],
    ["silver_pocket_watch", "silver_pocket_watch"],
  ])("preserves %s through normalizeEntityMentions", (input, expected) => {
    expect(normalizeEntityMentions([input])).toEqual([expected]);
  });
});

describe("regression: mixed input — noise stripped, signal preserved", () => {
  it("passes a realistic mid-session settlement payload", () => {
    // Approximates a settlement where the writer model dumped 12 surface
    // candidates: a few real entities, several function words, one typed
    // pointer, and the special 'self'/'user' tokens that should be excluded.
    const raw = [
      "self",
      "user",
      "Alice",
      "管家",
      "茶室",
      "早安",
      "感觉",
      "char:butler",
      "门", // single CJK — noise floor
      "银怀表",
      "随便",
      "current_location",
    ];
    expect(normalizeEntityMentions(raw, { maxItems: 20 })).toEqual([
      "Alice",
      "管家",
      "茶室",
      "char:butler",
      "银怀表",
    ]);
  });
});
