/**
 * Bilingual keyword tables shared between GraphNavigator.analyzeQuery
 * (legacy single-intent classifier) and RuleBasedQueryRouter (Phase 1
 * shadow router). Single source of truth — do not duplicate elsewhere.
 *
 * Note: retrieval-orchestrator.ts EPISODE_*_TRIGGER regexes are NOT migrated
 * here in Phase 1 (regex semantics differ from substring contains).
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
