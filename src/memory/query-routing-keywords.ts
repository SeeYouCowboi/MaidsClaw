/**
 * Bilingual keyword tables shared between GraphNavigator.analyzeQuery
 * (legacy single-intent classifier) and RuleBasedQueryRouter (Phase 1
 * shadow router). Single source of truth — do not duplicate elsewhere.
 *
 * Episode bucket migration (GAP-4 §4 prereq): EPISODE_MEMORY_KEYWORDS,
 * EPISODE_DETECTIVE_KEYWORDS, and EPISODE_SCENE_KEYWORDS below contain the
 * vocabulary that historically lived as EPISODE_*_TRIGGER regexes inside
 * retrieval-orchestrator.ts. They feed needsEpisode in RuleBasedQueryRouter
 * via substring-contains semantics (the regexes used the same effective
 * matching). The orchestrator regexes will be removed in a follow-up once
 * the parity fixture (test/memory/episode-signal-parity.test.ts) is green.
 */

export const WHY_KEYWORDS = [
  "why", "because", "reason", "cause",
  "为什么", "因为", "原因", "缘由", "为何", "怎么会",
] as const;

export const TIMELINE_KEYWORDS = [
  "when", "timeline", "before", "after", "sequence",
  "什么时候", "时间线", "之前", "之后", "顺序", "先后", "何时",
] as const;

export const RELATIONSHIP_KEYWORDS = [
  "relationship", "between", "connected", "related",
  "关系", "之间", "联系", "相关", "交情",
] as const;

export const STATE_KEYWORDS = [
  "state", "status", "current", "now", "is",
  "状态", "现状", "目前", "当前", "现在",
] as const;

export const CONFLICT_KEYWORDS = [
  "conflict", "contradict", "dispute", "contested", "inconsistent",
  "冲突", "矛盾", "争议", "对立", "不一致", "分歧",
] as const;

export const TIME_CONSTRAINT_KEYWORDS = [
  "yesterday", "today", "last week", "last month",
  "earlier", "recent", "recently", "ago", "before", "after",
  "昨天", "今天", "上周", "上个月",
  "之前", "最近", "近期", "以前", "刚才", "前天",
] as const;

/**
 * Phase 1 add-on (not in legacy navigator): "change" detector for asksChange
 * signal. Used by router only — does not affect legacy classification.
 */
export const CHANGE_KEYWORDS = [
  "change", "changed", "different", "shift", "shifted",
  "变了", "变化", "改变", "不同", "转变", "转变了",
] as const;

/**
 * Phase 1 add-on: comparison detector for asksComparison signal.
 */
export const COMPARISON_KEYWORDS = [
  "compare", "versus", "vs", "than",
  "比较", "对比", "相比", "比起",
] as const;

/**
 * Episode-memory vocabulary: words that signal a request to recall a past
 * episode. Migrated from EPISODE_QUERY_TRIGGER in retrieval-orchestrator.ts.
 *
 * Note: `before`/`之前`, `earlier`, `yesterday`/`昨天` overlap with
 * TIME_CONSTRAINT_KEYWORDS by design — both signals can fire and contribute
 * to needsEpisode independently (the formula uses `length > 0` boolean
 * tests, not summation, so no double-counting occurs).
 */
export const EPISODE_MEMORY_KEYWORDS = [
  "remember", "recall", "recalled", "before", "earlier", "previous",
  "last time", "once", "episode",
  "回忆", "记得", "那次", "上次", "以前", "从前", "经历", "先前",
] as const;

/**
 * Detective/forensic vocabulary: words that signal a clue/evidence-driven
 * investigation, which historically benefited from a wider episode budget.
 * Migrated from EPISODE_DETECTIVE_TRIGGER in retrieval-orchestrator.ts.
 *
 * Note: `who`/`why`/`原因`/`为什么` are deliberately omitted because they
 * collide with WHY_KEYWORDS — those queries are already routed via the
 * needsCognition signal and should not get an additional episode boost
 * just from the question word.
 */
export const EPISODE_DETECTIVE_KEYWORDS = [
  "detective", "investigate", "investigation", "clue", "evidence", "how did",
  "线索", "证据", "调查", "推理", "案发", "谁", "怎么回事", "真相",
] as const;

/**
 * Scene/location vocabulary: words that signal a request grounded in a
 * physical area. Migrated from EPISODE_SCENE_TRIGGER in
 * retrieval-orchestrator.ts. The router only treats this bucket as a
 * needsEpisode contributor when the caller also supplies a non-null
 * `currentAreaId`, mirroring the original `viewerContext.current_area_id`
 * gate in resolveEpisodeBudget.
 */
export const EPISODE_SCENE_KEYWORDS = [
  "here", "there", "room", "hall", "kitchen", "garden", "area", "scene",
  "location",
  "此处", "这里", "那边", "房间", "庭院", "区域", "场景", "大厅", "厨房",
  "花园", "地点",
] as const;
