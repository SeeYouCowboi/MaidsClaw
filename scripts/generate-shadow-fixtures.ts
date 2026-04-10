#!/usr/bin/env bun
/**
 * GAP-4 §2 Stage B prerequisite — synthetic shadow log generator.
 *
 * Drives the real `RuleBasedQueryRouter` + `DeterministicQueryPlanBuilder`
 * over a diverse fixture set and writes the resulting `query_route_shadow`
 * and `query_plan_shadow` events as logger envelopes (`{level, message,
 * context, timestamp}`) to a JSONL file. `scripts/analyze-shadow.ts` then
 * consumes the file and produces the §10 decision report.
 *
 * Why not run through the full navigator? The navigator needs a real
 * GraphReadQueryRepo, RetrievalService, embeddings, and viewer context —
 * none of which exist outside of scenario tests. The router + builder are
 * pure enough to feed the §10 metrics (disagreement rate, multi-intent
 * rate, entity resolution rate, edge_bias non-empty rate) without any
 * storage wiring. The emit payload format is copied verbatim from
 * `navigator.ts:emitQueryRouteAndPlanShadow` so downstream parsing
 * remains byte-compatible.
 *
 * Usage:
 *   bun scripts/generate-shadow-fixtures.ts --output shadow.jsonl [--verbose]
 *   bun scripts/analyze-shadow.ts --input shadow.jsonl --output report.md
 */

import { writeFileSync } from "node:fs";

import type { AgentRole } from "../src/agents/profile.js";
import type { AliasService } from "../src/memory/alias.js";
import { DeterministicQueryPlanBuilder } from "../src/memory/query-plan-builder.js";
import { RuleBasedQueryRouter } from "../src/memory/query-router.js";
import {
  CONFLICT_KEYWORDS,
  RELATIONSHIP_KEYWORDS,
  STATE_KEYWORDS,
  TIMELINE_KEYWORDS,
  WHY_KEYWORDS,
} from "../src/memory/query-routing-keywords.js";
import { tokenizeQuery } from "../src/memory/query-tokenizer.js";

// ----- Fixture definitions ------------------------------------------------

type Fixture = {
  query: string;
  role: AgentRole;
  explicitMode?: "entity" | "event" | "why" | "relationship" | "timeline" | "state" | "conflict";
  currentAreaId?: number | null;
};

// Alias map shared with the existing router-shadow-parity test, extended with
// CJK-only private aliases to exercise the §8 substring scan path in real
// rules.
const ALIAS_MAP: Record<string, number> = {
  Alice: 1,
  alice: 1,
  Bob: 2,
  bob: 2,
  Carol: 3,
  carol: 3,
  爱丽丝: 1,
  鲍勃: 2,
  管家: 4,
  // Private-only aliases (owned by agent_test)
};

// Private aliases owned only by agent_test — the fixture driver exposes them
// via listPrivateAliasStrings so the §8 substring-scan branch fires at least
// once in the captured log (matched_rules will include `private_alias_scan_hit`).
const PRIVATE_ALIASES_BY_AGENT: Record<string, string[]> = {
  agent_test: ["小红", "阿辉", "小红同学"],
};

function makeAlias(): AliasService {
  return {
    async resolveAlias(alias: string, viewerAgentId?: string): Promise<number | null> {
      if (alias in ALIAS_MAP) return ALIAS_MAP[alias];
      // Private aliases resolve only for the owning agent.
      if (viewerAgentId && PRIVATE_ALIASES_BY_AGENT[viewerAgentId]?.includes(alias)) {
        // Assign deterministic ids: 小红=10, 阿辉=11, 小红同学=12
        if (alias === "小红") return 10;
        if (alias === "阿辉") return 11;
        if (alias === "小红同学") return 12;
      }
      return null;
    },
    async listPrivateAliasStrings(viewerAgentId?: string): Promise<string[]> {
      if (!viewerAgentId) return [];
      return PRIVATE_ALIASES_BY_AGENT[viewerAgentId] ?? [];
    },
  } as unknown as AliasService;
}

// 70 fixtures covering: legacy-parity, multi-intent, CJK, private-alias,
// time-constrained, role-gated, explicit-mode, no-entity edge cases.
const FIXTURES: Fixture[] = [
  // --- why (Latin) ---
  { query: "why did Alice leave", role: "rp_agent" },
  { query: "what is the reason for the conflict", role: "rp_agent" },
  { query: "why did this happen yesterday", role: "rp_agent" },
  { query: "explain the cause of the fight", role: "rp_agent" },

  // --- why (CJK) ---
  { query: "为什么 Alice 突然离开了", role: "rp_agent" },
  { query: "为何 Bob 没有回来", role: "rp_agent" },
  { query: "为什么发生了冲突", role: "rp_agent" },
  { query: "为什么Alice和Bob的关系最近变了", role: "rp_agent" },

  // --- conflict ---
  { query: "Alice and Bob have a conflict", role: "rp_agent" },
  { query: "this is a contested claim", role: "rp_agent" },
  { query: "contradiction between Alice and Carol", role: "rp_agent" },
  { query: "他们之间产生了矛盾", role: "rp_agent" },
  { query: "存在分歧的事件", role: "rp_agent" },
  { query: "before the conflict yesterday", role: "rp_agent" },

  // --- timeline ---
  { query: "timeline of the events", role: "rp_agent" },
  { query: "what happened before the meeting", role: "rp_agent" },
  { query: "sequence of events leading up", role: "rp_agent" },
  { query: "事件的先后顺序", role: "rp_agent" },
  { query: "什么时候发生的", role: "rp_agent" },
  { query: "recently Alice was upset", role: "rp_agent" },
  { query: "昨天 Bob 去了哪里", role: "rp_agent" },

  // --- relationship ---
  { query: "what is the connection", role: "rp_agent" },
  { query: "Alice is related to Bob", role: "rp_agent" },
  { query: "relationship between Alice and Bob", role: "rp_agent" },
  { query: "Alice 和 Bob 的交情", role: "rp_agent" },
  { query: "他们的相关事件", role: "rp_agent" },
  { query: "@爱丽丝 和 @管家 的往来", role: "rp_agent" },

  // --- state ---
  { query: "current status of the project", role: "rp_agent" },
  { query: "what is the state now", role: "rp_agent" },
  { query: "目前的现状如何", role: "rp_agent" },
  { query: "Alice 当前在哪里", role: "rp_agent" },
  { query: "Alice's current state", role: "rp_agent" },

  // --- entity-only ---
  { query: "Alice", role: "rp_agent" },
  { query: "@Bob", role: "rp_agent" },
  { query: "Alice and Bob and Carol", role: "rp_agent" },
  { query: "爱丽丝", role: "rp_agent" },
  { query: "@爱丽丝", role: "rp_agent" },

  // --- event fallback ---
  { query: "lorem ipsum", role: "rp_agent" },
  { query: "tell me about the meeting", role: "rp_agent" },
  { query: "describe the situation", role: "rp_agent" },
  { query: "告诉我详细经过", role: "rp_agent" },

  // --- multi-intent (why+relationship, why+conflict, conflict+timeline, etc.) ---
  { query: "why did Alice and Bob fight last week", role: "rp_agent" },
  { query: "timeline of the relationship between Alice and Bob", role: "rp_agent" },
  { query: "current relationship of Alice and Bob", role: "rp_agent" },
  { query: "Alice's current state after the conflict", role: "rp_agent" },
  { query: "why the recent conflict about Alice happened", role: "rp_agent" },
  { query: "为什么最近Alice和Bob关系发生了改变", role: "rp_agent" },
  { query: "请告诉我昨天@爱丽丝 和 @管家 之间的冲突原因", role: "rp_agent" },

  // --- CJK private alias recovery (§8) ---
  { query: "为什么小红哭了", role: "rp_agent" },
  { query: "小红同学的情况怎么样", role: "rp_agent" },
  { query: "阿辉 和 小红 的关系", role: "rp_agent" },
  { query: "昨天 小红 去了哪里", role: "rp_agent" },

  // --- episode expansion (§4 signals) ---
  { query: "tell me about the scene at the library", role: "rp_agent", currentAreaId: 7 },
  { query: "case file on Alice", role: "rp_agent" },
  { query: "让我回忆那次会面", role: "rp_agent" },

  // --- explicit mode overrides ---
  { query: "why did this happen", role: "rp_agent", explicitMode: "state" },
  { query: "Alice and Bob", role: "rp_agent", explicitMode: "timeline" },

  // --- role-gated (task_agent — all surfaces off) ---
  { query: "why did Alice leave", role: "task_agent" },
  { query: "Alice and Bob have a conflict", role: "task_agent" },

  // --- maiden role (cognition + conflict disabled) ---
  { query: "why did Alice leave", role: "maiden" },
  { query: "timeline of the events", role: "maiden" },
  { query: "Alice 和 Bob 的关系", role: "maiden" },

  // --- companion role ---
  { query: "current status of the project", role: "companion" },
  { query: "为什么发生了冲突", role: "companion" },
  { query: "timeline of the events", role: "companion" },

  // --- dungeon_master role ---
  { query: "sequence of events leading up", role: "dungeon_master" },
  { query: "relationship between Alice and Bob", role: "dungeon_master" },
  { query: "why the recent conflict about Alice happened", role: "dungeon_master" },

  // --- empty / edge ---
  { query: "", role: "rp_agent" },
  { query: "?", role: "rp_agent" },

  // --- extended batch to cross the ≥100 sample gate ---
  // more why variants
  { query: "how did the accident happen", role: "rp_agent" },
  { query: "origin of the rumor about Alice", role: "rp_agent" },
  { query: "为何 Alice 不愿意见 Bob", role: "rp_agent" },
  { query: "why Carol changed her mind recently", role: "rp_agent" },
  { query: "what caused the disagreement last week", role: "rp_agent" },
  // more conflict variants
  { query: "rivalry between Alice and Carol", role: "rp_agent" },
  { query: "Alice 和 Carol 的争执", role: "rp_agent" },
  { query: "contradicting statements about the night", role: "rp_agent" },
  { query: "feud that started recently", role: "rp_agent" },
  // more timeline variants
  { query: "what happened after the dinner", role: "rp_agent" },
  { query: "chronology of yesterday's events", role: "rp_agent" },
  { query: "最近Alice和Bob发生了什么", role: "rp_agent" },
  { query: "sequence before the meeting", role: "rp_agent" },
  { query: "今天Alice做了什么", role: "rp_agent" },
  // more relationship variants
  { query: "how do Alice and Carol know each other", role: "rp_agent" },
  { query: "acquaintance of Bob", role: "rp_agent" },
  { query: "Alice 和 @爱丽丝 的关系", role: "rp_agent" },
  { query: "connection of Bob to Carol", role: "rp_agent" },
  // more state variants
  { query: "where is Alice now", role: "rp_agent" },
  { query: "Bob 的当前状况", role: "rp_agent" },
  { query: "Carol is still at the cafe", role: "rp_agent" },
  // entity-heavy
  { query: "@alice @bob @carol together", role: "rp_agent" },
  { query: "Alice Bob Carol and 爱丽丝", role: "rp_agent" },
  // private alias again (§8)
  { query: "小红 和 Bob 的对话", role: "rp_agent" },
  { query: "阿辉最近怎么样", role: "rp_agent" },
  { query: "小红同学在哪里", role: "rp_agent" },
  // episode expansion
  { query: "那天晚上的案件细节", role: "rp_agent", currentAreaId: 3 },
  { query: "please investigate the scene", role: "rp_agent", currentAreaId: 5 },
  { query: "回忆 Alice 和 Bob 的第一次见面", role: "rp_agent" },
  // multi-intent heavy
  { query: "为什么Alice昨天和Bob发生冲突", role: "rp_agent" },
  { query: "why Alice and Carol have a current rivalry", role: "rp_agent" },
  { query: "timeline and reason for the Bob-Carol conflict", role: "rp_agent" },
  { query: "relationship changes after the recent conflict", role: "rp_agent" },
  // maiden role deeper
  { query: "Alice 和 Bob 昨天发生了什么", role: "maiden" },
  { query: "小红 的状况", role: "maiden" },
  // dungeon_master deeper
  { query: "what is the current status of Alice", role: "dungeon_master" },
  { query: "cause of Bob's departure", role: "dungeon_master" },

  // --- ADVERSARIAL / CHAOS BATCH ---
  // Mixed script — English question + CJK subject + English time adverb
  { query: "why did Alice 昨天 leave because Bob was 生气", role: "rp_agent" },
  { query: "the 关系 between Alice and Bob changed recently", role: "rp_agent" },
  { query: "conflict 和 timeline for Bob and 爱丽丝", role: "rp_agent" },
  // Mixed script with private alias
  { query: "why 小红 and Alice fought yesterday", role: "rp_agent" },
  { query: "阿辉 and Bob 和 小红 关系", role: "rp_agent" },
  // Pathologically long queries
  {
    query:
      "please explain in full detail why Alice and Bob and Carol and 爱丽丝 and 管家 have been in a recent conflict with each other that started last week because of the disagreement about the state of the relationship and the timeline of events leading up to yesterday",
    role: "rp_agent",
  },
  // Repeated keyword stuffing (exercises confidenceFromEvidence saturation)
  { query: "why why why why why did Alice leave", role: "rp_agent" },
  { query: "conflict conflict conflict between Alice and Bob", role: "rp_agent" },
  { query: "timeline timeline timeline 顺序 先后 什么时候", role: "rp_agent" },
  // All-intent keyword soup
  { query: "why conflict timeline relationship state Alice Bob", role: "rp_agent" },
  { query: "为什么冲突先后关系现状 Alice Bob", role: "rp_agent" },
  // Unicode edge — emoji + CJK + Latin
  { query: "why did 🔥 Alice leave Bob 😭", role: "rp_agent" },
  { query: "Alice 💕 Bob relationship", role: "rp_agent" },
  // Numbers and punctuation
  { query: "Alice's 3rd conflict with Bob: why?", role: "rp_agent" },
  { query: "(Alice, Bob, Carol) — timeline?", role: "rp_agent" },
  // Very short queries
  { query: "a", role: "rp_agent" },
  { query: "为", role: "rp_agent" },
  { query: "@", role: "rp_agent" },
  // Only time words — no entity, no intent keyword
  { query: "yesterday", role: "rp_agent" },
  { query: "最近", role: "rp_agent" },
  // Explicit mode vs keyword conflict
  { query: "why did this happen yesterday", role: "rp_agent", explicitMode: "conflict" },
  { query: "timeline of the events", role: "rp_agent", explicitMode: "why" },
  { query: "Alice and Bob", role: "rp_agent", explicitMode: "state", currentAreaId: 1 },
  // Maiden + conflict keyword (role disables conflict_notes surface)
  { query: "Alice and Bob have a conflict", role: "maiden" },
  // task_agent with everything (should still emit zero-weight plan)
  { query: "why Alice left", role: "task_agent" },
  { query: "timeline of the events", role: "task_agent" },
];

// ----- Legacy replica for disagreement accounting ------------------------
// Mirrors GraphNavigator.analyzeQuery exactly: keyword priority chain over
// the canonical buckets in src/memory/query-routing-keywords.ts, with entity
// resolution through the same first-pass tokenizer + resolveAlias call.
// This is NOT the router's second-pass (private alias substring scan), so
// real router-vs-navigator divergence on CJK private aliases will surface
// as legitimate `agreed_with_legacy=false` samples.

async function legacyClassify(
  query: string,
  alias: AliasService,
  viewerAgentId: string,
  mode?: string,
): Promise<string> {
  if (mode) return mode;
  const normalized = query.trim().toLowerCase();
  const tokens = tokenizeQuery(query);
  let resolvedCount = 0;
  const seen = new Set<number>();
  for (const token of tokens) {
    const aliasToken = token.startsWith("@") ? token.slice(1) : token;
    if (aliasToken.length < 2) continue;
    const id = await alias.resolveAlias(aliasToken, viewerAgentId);
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      resolvedCount += 1;
    }
  }

  const includesAny = (needles: readonly string[]) => needles.some((n) => normalized.includes(n));
  if (includesAny(WHY_KEYWORDS)) return "why";
  if (includesAny(CONFLICT_KEYWORDS)) return "conflict";
  if (includesAny(TIMELINE_KEYWORDS)) return "timeline";
  if (includesAny(RELATIONSHIP_KEYWORDS)) return "relationship";
  if (includesAny(STATE_KEYWORDS)) return "state";
  if (resolvedCount > 0) return "entity";
  return "event";
}

// ----- Emit helpers (copied from navigator.ts for byte-identity) ---------

function envelope(message: string, context: Record<string, unknown>): string {
  const entry = {
    level: "debug",
    message,
    context,
    timestamp: Date.now(),
  };
  return JSON.stringify(entry);
}

// ----- Driver -------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let output = "";
  let verbose = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--output" && i + 1 < args.length) {
      output = args[i + 1];
      i += 1;
    } else if (args[i] === "--verbose") {
      verbose = true;
    }
  }
  if (!output) {
    console.error("Usage: bun scripts/generate-shadow-fixtures.ts --output <file.jsonl> [--verbose]");
    process.exit(2);
  }

  // Ensure §4 + §8 feature flags are ON so the captured log reflects the
  // current production surface — this matches the Stage B target env.
  process.env.MAIDSCLAW_ROUTER_EPISODE_SIGNALS = "on";
  process.env.MAIDSCLAW_ROUTER_PRIVATE_ALIAS_SCAN = "on";

  const alias = makeAlias();
  const router = new RuleBasedQueryRouter(alias);
  const builder = new DeterministicQueryPlanBuilder();

  const lines: string[] = [];
  let routeCount = 0;
  let planCount = 0;

  for (const fx of FIXTURES) {
    let route;
    try {
      route = await router.route({
        query: fx.query,
        viewerAgentId: "agent_test",
        explicitMode: fx.explicitMode,
        currentAreaId: fx.currentAreaId ?? null,
      });
    } catch (err) {
      lines.push(
        envelope("retrieval_plan_build_failed", {
          event: "retrieval_plan_build_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      continue;
    }

    const legacyQueryType = await legacyClassify(
      fx.query,
      alias,
      "agent_test",
      fx.explicitMode,
    );

    const routePayload = {
      event: "query_route_shadow",
      classifier: route.classifierVersion,
      primary_intent: route.primaryIntent,
      legacy_query_type: legacyQueryType,
      agreed_with_legacy: route.primaryIntent === legacyQueryType,
      intents: route.intents.map((i) => ({
        type: i.type,
        confidence: Number(i.confidence.toFixed(3)),
        evidence_count: i.evidence.length,
      })),
      intent_count: route.intents.length,
      matched_rules: route.matchedRules,
      resolved_entity_count: route.resolvedEntityIds.length,
      time_signals: route.timeSignals,
      signals: route.signals,
      rationale: route.rationale,
    };
    lines.push(envelope("query_route_shadow", routePayload));
    routeCount += 1;

    let plan;
    try {
      plan = builder.build({ route, role: fx.role });
    } catch (err) {
      lines.push(
        envelope("retrieval_plan_build_failed", {
          event: "retrieval_plan_build_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      continue;
    }

    const planPayload = {
      event: "query_plan_shadow",
      builder: plan.builderVersion,
      primary_intent: plan.graphPlan.primaryIntent,
      secondary_intents: plan.graphPlan.secondaryIntents,
      surface_weights: {
        narrative: Number(plan.surfacePlans.narrative.weight.toFixed(3)),
        cognition: Number(plan.surfacePlans.cognition.weight.toFixed(3)),
        episode: Number(plan.surfacePlans.episode.weight.toFixed(3)),
        conflict_notes: Number(plan.surfacePlans.conflictNotes.weight.toFixed(3)),
      },
      surface_enabled: {
        narrative: plan.surfacePlans.narrative.enabledByRole,
        cognition: plan.surfacePlans.cognition.enabledByRole,
        episode: plan.surfacePlans.episode.enabledByRole,
        conflict_notes: plan.surfacePlans.conflictNotes.enabledByRole,
      },
      cognition_kind: plan.surfacePlans.cognition.kind ?? null,
      cognition_stance: plan.surfacePlans.cognition.stance ?? null,
      seed_bias: plan.graphPlan.seedBias,
      edge_bias: plan.graphPlan.edgeBias,
      time_slice: plan.graphPlan.timeSlice,
      matched_rules: plan.matchedRules,
      rationale: plan.rationale,
    };
    lines.push(envelope("query_plan_shadow", planPayload));
    planCount += 1;

    if (verbose) {
      console.log(
        `[${fx.role.padEnd(14)}] ${fx.query.slice(0, 40).padEnd(40)}  primary=${route.primaryIntent.padEnd(12)} legacy=${legacyQueryType.padEnd(12)} intents=${route.intents.length} entities=${route.resolvedEntityIds.length}`,
      );
    }
  }

  writeFileSync(output, lines.join("\n") + "\n", "utf8");
  console.log(`✓ Wrote ${lines.length} log lines to ${output}`);
  console.log(`  ${routeCount} route events, ${planCount} plan events, ${FIXTURES.length} fixtures`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("generate-shadow-fixtures failed:", err);
    process.exit(1);
  });
}
