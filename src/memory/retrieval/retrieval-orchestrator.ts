import type { AgentRole } from "../../agents/profile.js";
import type { ViewerContext } from "../../core/contracts/viewer-context.js";
import type { MemoryHint } from "../types.js";
import type { NarrativeSearchService } from "../narrative/narrative-search.js";
import type { CognitionSearchService, CognitionHit, CurrentProjectionReader } from "../cognition/cognition-search.js";
import type { RetrievalTemplate } from "../contracts/retrieval-template.js";
import { estimateTokens, resolveTemplate } from "../contracts/retrieval-template.js";
import type { EpisodeRow } from "../episode/episode-repo.js";
import type { EpisodeRepo } from "../../storage/domain-repos/contracts/episode-repo.js";
import type { QueryPlan } from "../query-plan-types.js";
import { tokenizeQuery } from "../query-tokenizer.js";
import { allocateBudget } from "./budget-allocator.js";

export type RetrievalQueryStrategy = "default_retrieval" | "deep_explain";

type EpisodeSearchHit = {
  sourceRef: string;
  content: string;
  category: string;
  score: number;
};

type EpisodeSearchFn = (query: string, agentId: string, limit: number) => Promise<EpisodeSearchHit[]>;

type RetrievalOrchestratorDeps = {
  narrativeService: NarrativeSearchService;
  cognitionService: CognitionSearchService;
  currentProjectionReader?: CurrentProjectionReader | null;
  episodeRepository?: EpisodeRepo | null;
  episodeSearchFn?: EpisodeSearchFn | null;
};

type TypedRetrievalSegment = {
  source_ref: string;
  content: string;
  score: number;
};

type TypedNarrativeSegment = TypedRetrievalSegment & {
  doc_type: string;
  scope: MemoryHint["scope"];
};

type TypedCognitionSegment = TypedRetrievalSegment & {
  kind: string;
  basis: string | null;
  stance: string | null;
  cognitionKey: string | null;
};

type TypedConflictNoteSegment = TypedRetrievalSegment & {
  from_source_ref: string;
  cognitionKey: string | null;
};

export type TypedRetrievalResult = {
  cognition: TypedCognitionSegment[];
  narrative: TypedNarrativeSegment[];
  conflict_notes: TypedConflictNoteSegment[];
  episode: TypedNarrativeSegment[];
};

export type RetrievalResult = {
  typed: TypedRetrievalResult;
  narrativeHints: MemoryHint[];
  cognitionHits: CognitionHit[];
};

export type RetrievalDedupContext = {
  recentCognitionKeys?: Set<string>;
  recentCognitionTexts?: string[];
  conversationTexts?: string[];
  surfacedNarrativeTexts?: string[];
  allSurfacedTexts?: Set<string>;
};

/**
 * Options object for RetrievalOrchestrator.search() tail parameters.
 * Introduced in Phase 3 to avoid positional-argument drift as more plan
 * consumption fields land in Phase 3.5 / Phase 4.
 */
export type RetrievalSearchOptions = {
  override?: RetrievalTemplate;
  dedupContext?: RetrievalDedupContext;
  queryStrategy?: RetrievalQueryStrategy;
  contestedCount?: number;
  queryPlan?: QueryPlan;
};

const COGNITION_KEY_PREFIX = "cognition_key" + ":";

/**
 * Phase 3 feature flag: when "off", disables plan-driven budget allocation
 * and falls back to the strategy-adjusted template directly. Default is ON
 * — if a QueryPlan is supplied, it will drive the budget reallocation.
 *
 * The §4 follow-up (this commit) removed the legacy `EPISODE_*_TRIGGER`
 * regex path entirely — `MAIDSCLAW_RETRIEVAL_USE_PLAN=off` now means "use
 * the strategy-adjusted template without plan reallocation", not "go back
 * to the regex boost path". The signal-driven router is the only episode
 * boost mechanism now; see test/memory/episode-signal-parity.test.ts.
 */
function isPlanDrivenRetrievalEnabled(): boolean {
  return process.env.MAIDSCLAW_RETRIEVAL_USE_PLAN !== "off";
}

/**
 * GAP-4 §1 feature flag: when enabled, the orchestrator passes the
 * surface-level facets (`entityFilters`, `timeWindow`, `kind`, `stance`)
 * from `queryPlan.surfacePlans.*` through to NarrativeSearchService and
 * CognitionSearchService. When disabled, the services receive `undefined`
 * filters and behave exactly as in pre-§1 commits.
 *
 * Default is ON. Set MAIDSCLAW_RETRIEVAL_USE_FACETS=off for single-env-var
 * rollback if facet consumption causes unexpected recall changes.
 */
function isFacetConsumptionEnabled(): boolean {
  return process.env.MAIDSCLAW_RETRIEVAL_USE_FACETS !== "off";
}

export class RetrievalOrchestrator {
  private readonly currentProjectionReader: CurrentProjectionReader | null;
  private readonly narrativeService: NarrativeSearchService;
  private readonly cognitionService: CognitionSearchService;
  private readonly episodeRepository: EpisodeRepo | null;
  private readonly episodeSearchFn: EpisodeSearchFn | null;

  constructor(deps: RetrievalOrchestratorDeps) {
    this.narrativeService = deps.narrativeService;
    this.cognitionService = deps.cognitionService;
    this.currentProjectionReader = deps.currentProjectionReader ?? null;
    this.episodeRepository = deps.episodeRepository ?? null;
    this.episodeSearchFn = deps.episodeSearchFn ?? null;
  }

  async search(
    query: string,
    viewerContext: ViewerContext,
    role: AgentRole,
    options: RetrievalSearchOptions = {},
  ): Promise<RetrievalResult> {
    const {
      override,
      dedupContext,
      queryStrategy = "default_retrieval",
      contestedCount,
      queryPlan,
    } = options;
    const baseTemplate = resolveTemplate(role, override);
    const strategyAdjusted = this.applyQueryStrategy(baseTemplate, queryStrategy);
    // Phase 3: if a plan is provided and the feature flag is on, let it
    // reshape the per-surface count budgets via signal-weighted conservation.
    // Falls back to the strategy-adjusted template when plan or flag absent.
    const template =
      queryPlan && isPlanDrivenRetrievalEnabled()
        ? allocateBudget(strategyAdjusted, queryPlan.route.signals)
        : strategyAdjusted;
    const effectiveConflictNotesBudget = this.resolveConflictNotesBudget(template, contestedCount);

    const seenText = this.seedSeenText(dedupContext);
    const allSurfacedTexts = dedupContext?.allSurfacedTexts ?? new Set<string>();

    const recentCognitionKeys = new Set<string>(dedupContext?.recentCognitionKeys ?? []);
    if (this.currentProjectionReader && template.cognitionBudget > 0) {
      const currentRows = await this.currentProjectionReader.getActiveCurrent(viewerContext.viewer_agent_id);
      for (const row of currentRows) {
        const key = row.cognition_key?.trim();
        if (!key || !recentCognitionKeys.has(key)) {
          continue;
        }
        const summary = row.summary_text?.trim();
        if (summary && summary.length > 0) {
          seenText.add(this.normalizeText(summary));
        }
      }
    }

    for (const normalized of seenText) {
      allSurfacedTexts.add(normalized);
    }

    const effectiveEpisodeBudget = this.resolveEpisodeBudget(template);
    const episodeHints = await this.resolveEpisodeHints(query, viewerContext, effectiveEpisodeBudget);

    // GAP-4 §1: extract surface-level facets from the plan if a plan is
    // present and the facet consumption flag is on. Empty `entityFilters`
    // arrays are normalized to undefined so the downstream "no filter"
    // path is taken (avoids accidental "match nothing" semantics).
    const facetsEnabled = queryPlan != null && isFacetConsumptionEnabled();
    const narrativeFacets = facetsEnabled
      ? {
          entityIds: nonEmptyOrUndefined(queryPlan.surfacePlans.narrative.entityFilters),
          timeWindow: queryPlan.surfacePlans.narrative.timeWindow ?? undefined,
        }
      : undefined;
    const cognitionFacets = facetsEnabled
      ? {
          kind: queryPlan.surfacePlans.cognition.kind,
          stance: queryPlan.surfacePlans.cognition.stance,
          entityIds: nonEmptyOrUndefined(queryPlan.surfacePlans.cognition.entityFilters),
          timeWindow: queryPlan.surfacePlans.cognition.timeWindow ?? undefined,
        }
      : undefined;

    const narrativeHints: MemoryHint[] =
      template.narrativeEnabled && (template.narrativeBudget > 0 || effectiveEpisodeBudget > 0)
        ? await this.narrativeService.generateMemoryHints(
            query,
            viewerContext,
            Math.max(template.narrativeBudget + effectiveEpisodeBudget + 4, template.narrativeBudget),
            narrativeFacets,
          )
        : [];

    const rawCognitionHits: CognitionHit[] =
      template.cognitionEnabled && (template.cognitionBudget > 0 || effectiveConflictNotesBudget > 0)
        ? await this.cognitionService.searchCognition({
            agentId: viewerContext.viewer_agent_id,
            query,
            activeOnly: true,
            limit: Math.max(template.cognitionBudget + effectiveConflictNotesBudget + 4, template.cognitionBudget),
            kind: cognitionFacets?.kind,
            stance: cognitionFacets?.stance,
            entityIds: cognitionFacets?.entityIds,
            timeWindow: cognitionFacets?.timeWindow,
          })
        : [];

    const cognitionHits = this.filterCognitionHits(rawCognitionHits, recentCognitionKeys, seenText);
    const typed = this.buildTypedSurface(
      template,
      cognitionHits,
      narrativeHints,
      episodeHints,
      seenText,
      allSurfacedTexts,
      recentCognitionKeys,
      effectiveEpisodeBudget,
      effectiveConflictNotesBudget,
    );

    return {
      typed,
      narrativeHints: typed.narrative.map((segment) => ({
        source_ref: segment.source_ref as MemoryHint["source_ref"],
        doc_type: segment.doc_type,
        content: segment.content,
        scope: segment.scope,
        score: segment.score,
      })),
      cognitionHits,
    };
  }

  private applyQueryStrategy(
    template: Required<RetrievalTemplate>,
    queryStrategy: RetrievalQueryStrategy,
  ): Required<RetrievalTemplate> {
    if (queryStrategy === "default_retrieval") {
      return template;
    }

    const narrativeBudget = template.narrativeBudget + 2;
    const cognitionBudget = template.cognitionBudget + 2;

    return {
      ...template,
      narrativeBudget,
      cognitionBudget,
      conflictNotesBudget: template.conflictNotesBudget + 1,
      episodicBudget: template.episodicBudget + 1,
      episodeBudget: template.episodeBudget + 1,
      maxNarrativeHits: narrativeBudget,
      maxCognitionHits: cognitionBudget,
    };
  }

  private buildTypedSurface(
    template: Required<RetrievalTemplate>,
    cognitionHits: CognitionHit[],
    narrativeHints: MemoryHint[],
    episodeHints: TypedNarrativeSegment[],
    seenText: Set<string>,
    allSurfacedTexts: Set<string>,
    recentCognitionKeys: Set<string>,
    effectiveEpisodeBudget: number,
    effectiveConflictNotesBudget: number,
  ): TypedRetrievalResult {
    const typed: TypedRetrievalResult = {
      cognition: [],
      narrative: [],
      conflict_notes: [],
      episode: [],
    };

    let cognitionTokens = 0;
    let narrativeTokens = 0;
    let conflictNotesTokens = 0;
    let episodeTokens = 0;

    if (template.cognitionEnabled && template.cognitionBudget > 0) {
      for (const hit of cognitionHits) {
        if (typed.cognition.length >= template.cognitionBudget) {
          break;
        }
        if (template.cognitionTokenBudget > 0 && cognitionTokens >= template.cognitionTokenBudget) {
          break;
        }
        const key = hit.cognitionKey ?? this.extractCognitionKey(hit.source_ref);
        if (key && recentCognitionKeys.has(key)) {
          continue;
        }
        const normalized = this.normalizeText(hit.content);
        if (normalized.length === 0 || seenText.has(normalized) || allSurfacedTexts.has(normalized)) {
          continue;
        }
        const tokenEstimate = estimateTokens(hit.content);
        if (template.cognitionTokenBudget > 0 && cognitionTokens + tokenEstimate > template.cognitionTokenBudget) {
          continue;
        }
        seenText.add(normalized);
        allSurfacedTexts.add(normalized);
        cognitionTokens += tokenEstimate;
        typed.cognition.push({
          source_ref: String(hit.source_ref),
          content: hit.content,
          score: hit.updated_at,
          kind: hit.kind,
          basis: hit.basis,
          stance: hit.stance,
          cognitionKey: key,
        });
      }
    }

    if (template.narrativeEnabled && template.narrativeBudget > 0) {
      for (const hint of narrativeHints) {
        if (typed.narrative.length >= template.narrativeBudget) {
          break;
        }
        if (template.narrativeTokenBudget > 0 && narrativeTokens >= template.narrativeTokenBudget) {
          break;
        }
        if (effectiveEpisodeBudget > 0 && this.isEpisodeCandidate(hint)) {
          continue;
        }
        const normalized = this.normalizeText(hint.content);
        if (normalized.length === 0 || seenText.has(normalized) || allSurfacedTexts.has(normalized)) {
          continue;
        }
        const tokenEstimate = estimateTokens(hint.content);
        if (template.narrativeTokenBudget > 0 && narrativeTokens + tokenEstimate > template.narrativeTokenBudget) {
          continue;
        }
        seenText.add(normalized);
        allSurfacedTexts.add(normalized);
        narrativeTokens += tokenEstimate;
        typed.narrative.push({
          source_ref: String(hint.source_ref),
          content: hint.content,
          score: hint.score,
          doc_type: hint.doc_type,
          scope: hint.scope,
        });
      }
    }

    if (template.conflictNotesEnabled && effectiveConflictNotesBudget > 0) {
      for (const hit of cognitionHits) {
        if (typed.conflict_notes.length >= effectiveConflictNotesBudget) {
          break;
        }
        if (template.conflictNotesTokenBudget > 0 && conflictNotesTokens >= template.conflictNotesTokenBudget) {
          break;
        }
        if (hit.stance !== "contested" || !hit.conflictEvidence || hit.conflictEvidence.length === 0) {
          continue;
        }
        const cognitionKey = hit.cognitionKey ?? this.extractCognitionKey(hit.source_ref);
        for (const ev of hit.conflictEvidence) {
          if (typed.conflict_notes.length >= effectiveConflictNotesBudget) {
            break;
          }
          const content = `Conflicts with ${ev.targetRef} (strength: ${ev.strength})`;
          const normalized = this.normalizeText(content);
          if (normalized.length === 0 || seenText.has(normalized) || allSurfacedTexts.has(normalized)) {
            continue;
          }
          const tokenEstimate = estimateTokens(content);
          if (
            template.conflictNotesTokenBudget > 0
            && conflictNotesTokens + tokenEstimate > template.conflictNotesTokenBudget
          ) {
            continue;
          }
          seenText.add(normalized);
          allSurfacedTexts.add(normalized);
          conflictNotesTokens += tokenEstimate;
          typed.conflict_notes.push({
            source_ref: `conflict_note:${hit.source_ref}`,
            from_source_ref: String(hit.source_ref),
            cognitionKey,
            content,
            score: hit.updated_at,
          });
        }
      }
    }

    if (template.episodeEnabled && effectiveEpisodeBudget > 0) {
      for (const hint of episodeHints) {
        if (typed.episode.length >= effectiveEpisodeBudget) {
          break;
        }
        if (template.episodicTokenBudget > 0 && episodeTokens >= template.episodicTokenBudget) {
          break;
        }
        const normalized = this.normalizeText(hint.content);
        if (normalized.length === 0 || seenText.has(normalized) || allSurfacedTexts.has(normalized)) {
          continue;
        }
        const tokenEstimate = estimateTokens(hint.content);
        if (template.episodicTokenBudget > 0 && episodeTokens + tokenEstimate > template.episodicTokenBudget) {
          continue;
        }
        seenText.add(normalized);
        allSurfacedTexts.add(normalized);
        episodeTokens += tokenEstimate;
        typed.episode.push(hint);
      }

      for (const hint of narrativeHints) {
        if (typed.episode.length >= effectiveEpisodeBudget) {
          break;
        }
        if (template.episodicTokenBudget > 0 && episodeTokens >= template.episodicTokenBudget) {
          break;
        }
        if (!this.isEpisodeCandidate(hint)) {
          continue;
        }
        const normalized = this.normalizeText(hint.content);
        if (normalized.length === 0 || seenText.has(normalized) || allSurfacedTexts.has(normalized)) {
          continue;
        }
        const tokenEstimate = estimateTokens(hint.content);
        if (template.episodicTokenBudget > 0 && episodeTokens + tokenEstimate > template.episodicTokenBudget) {
          continue;
        }
        seenText.add(normalized);
        allSurfacedTexts.add(normalized);
        episodeTokens += tokenEstimate;
        typed.episode.push({
          source_ref: String(hint.source_ref),
          content: hint.content,
          score: hint.score,
          doc_type: hint.doc_type,
          scope: hint.scope,
        });
      }
    }

    return typed;
  }

  private async resolveEpisodeHints(
    query: string,
    viewerContext: ViewerContext,
    effectiveEpisodeBudget: number,
  ): Promise<TypedNarrativeSegment[]> {
    if (effectiveEpisodeBudget <= 0) {
      return [];
    }

    // Prefer FTS when available
    if (this.episodeSearchFn && query.trim().length > 0) {
      try {
        const ftsHits = await this.episodeSearchFn(
          query,
          viewerContext.viewer_agent_id,
          Math.max(effectiveEpisodeBudget * 3, effectiveEpisodeBudget + 4),
        );
        if (ftsHits.length > 0) {
          return ftsHits.map((hit) => ({
            source_ref: hit.sourceRef,
            content: hit.content,
            score: hit.score,
            doc_type: `episode_${hit.category}`,
            scope: "private" as const,
          }));
        }
      } catch {
        // Fall through to readByAgent scan
      }
    }

    // Fallback: direct scan via episodeRepository
    if (!this.episodeRepository) {
      return [];
    }

    const rawRows = await this.episodeRepository.readByAgent(
      viewerContext.viewer_agent_id,
      Math.max(effectiveEpisodeBudget * 3, effectiveEpisodeBudget + 4),
    );

    if (rawRows.length === 0) {
      return [];
    }

    const rankedRows = rawRows
      .map((row) => ({
        row,
        score: this.scoreEpisodeRow(row, query, viewerContext),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        if (b.row.committed_time !== a.row.committed_time) {
          return b.row.committed_time - a.row.committed_time;
        }
        return b.row.id - a.row.id;
      });

    return rankedRows.map(({ row, score }) => ({
      source_ref: `episode:${row.id}`,
      content: row.summary,
      score,
      doc_type: `episode_${row.category}`,
      scope: "private",
    }));
  }

  private seedSeenText(context?: RetrievalDedupContext): Set<string> {
    const seen = new Set<string>();
    for (const text of context?.conversationTexts ?? []) {
      const normalized = this.normalizeText(text);
      if (normalized) seen.add(normalized);
    }
    for (const text of context?.recentCognitionTexts ?? []) {
      const normalized = this.normalizeText(text);
      if (normalized) seen.add(normalized);
    }
    for (const text of context?.surfacedNarrativeTexts ?? []) {
      const normalized = this.normalizeText(text);
      if (normalized) seen.add(normalized);
    }
    return seen;
  }

  private filterCognitionHits(
    hits: CognitionHit[],
    recentCognitionKeys: Set<string>,
    seenText: Set<string>,
  ): CognitionHit[] {
    const seenKeys = new Set<string>();
    const filtered: CognitionHit[] = [];
    for (const hit of hits) {
      const key = hit.cognitionKey ?? this.extractCognitionKey(hit.source_ref);
      if (key && (recentCognitionKeys.has(key) || seenKeys.has(key))) {
        continue;
      }
      const normalized = this.normalizeText(hit.content);
      if (normalized.length === 0 || seenText.has(normalized)) {
        continue;
      }
      if (key) {
        seenKeys.add(key);
      }
      filtered.push({
        ...hit,
        cognitionKey: key,
      });
    }
    return filtered;
  }

  private resolveEpisodeBudget(template: Required<RetrievalTemplate>): number {
    // GAP-4 §4 follow-up: the EPISODE_*_TRIGGER regex boosts that used to
    // ride on top of the template were removed in favor of the
    // signal-driven router path. The router's needsEpisode signal (fed by
    // EPISODE_MEMORY_KEYWORDS / EPISODE_DETECTIVE_KEYWORDS /
    // EPISODE_SCENE_KEYWORDS in query-routing-keywords.ts) drives episode
    // budget reallocation via budget-allocator before this function runs;
    // the role-default `episodicBudget` was bumped from 2 → 3 in the §4
    // prereq commit (ff8a44e) to absorb the +1 boost the regex used to
    // add. The signal path is strictly broader than the regex path on the
    // bilingual parity fixture (test/memory/episode-signal-parity.test.ts).
    return Math.max(0, Math.max(template.episodicBudget, template.episodeBudget));
  }

  private resolveConflictNotesBudget(
    template: Required<RetrievalTemplate>,
    contestedCount?: number,
  ): number {
    if ((contestedCount ?? 0) <= 0 || template.conflictBoostFactor <= 0) {
      return template.conflictNotesBudget;
    }
    return template.conflictNotesBudget + Math.min(contestedCount ?? 0, 3) * template.conflictBoostFactor;
  }

  private isEpisodeCandidate(hint: MemoryHint): boolean {
    return hint.doc_type.includes("event") || String(hint.source_ref).startsWith("event:");
  }

  private scoreEpisodeRow(row: EpisodeRow, query: string, viewerContext: ViewerContext): number {
    let score = row.committed_time;
    const queryText = query.trim().toLowerCase();
    const haystack = `${row.summary} ${row.location_text ?? ""} ${row.category}`.toLowerCase();

    if (queryText.length > 0) {
      const terms = tokenizeQuery(queryText);
      for (const term of terms) {
        if (haystack.includes(term)) {
          score += 1_000_000;
        }
      }
    }

    if (viewerContext.current_area_id != null && row.location_entity_id === viewerContext.current_area_id) {
      score += 2_000_000;
    }
    if (row.session_id === viewerContext.session_id) {
      score += 500_000;
    }

    return score;
  }

  private normalizeText(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
  }

  private extractCognitionKey(sourceRef: string): string | null {
    const text = String(sourceRef);
    if (!text.startsWith(COGNITION_KEY_PREFIX)) {
      return null;
    }
    const key = text.slice(COGNITION_KEY_PREFIX.length).trim();
    return key.length > 0 ? key : null;
  }
}

/**
 * GAP-4 §1: empty entity id arrays from `plan.surfacePlans.*.entityFilters`
 * must be treated identically to `undefined` (no filter), NEVER as "match
 * nothing". The contracts and PG repos honor this convention but doing
 * the normalization once at the orchestrator boundary keeps every
 * downstream call site simple.
 */
function nonEmptyOrUndefined(arr: number[] | undefined | null): number[] | undefined {
  if (arr == null || arr.length === 0) return undefined;
  return arr;
}
