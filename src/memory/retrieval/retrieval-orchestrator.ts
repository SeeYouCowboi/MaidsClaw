import type { AgentRole } from "../../agents/profile.js";
import type { ViewerContext } from "../../core/contracts/viewer-context.js";
import type { MemoryHint } from "../types.js";
import type { NarrativeSearchService } from "../narrative/narrative-search.js";
import type { CognitionSearchService, CognitionHit, CurrentProjectionReader } from "../cognition/cognition-search.js";
import type { RetrievalTemplate } from "../contracts/retrieval-template.js";
import { resolveTemplate } from "../contracts/retrieval-template.js";
import type { EpisodeRepository, EpisodeRow } from "../episode/episode-repo.js";

export type RetrievalQueryStrategy = "default_retrieval" | "deep_explain";

type RetrievalOrchestratorDeps = {
  narrativeService: NarrativeSearchService;
  cognitionService: CognitionSearchService;
  currentProjectionReader?: CurrentProjectionReader | null;
  episodeRepository?: EpisodeRepository | null;
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
};

const EPISODE_QUERY_TRIGGER = /(remember|before|earlier|previous|last time|once|yesterday|scene|where|location|episode|回忆|之前|先前|场景|地点|那次)/i;
const EPISODE_DETECTIVE_TRIGGER = /(detective|investigate|investigation|clue|evidence|timeline|who|why|how did|线索|证据|调查|推理|案发|时间线|谁|为什么)/i;
const EPISODE_SCENE_TRIGGER = /(here|there|room|hall|kitchen|garden|area|scene|此处|这里|那边|房间|庭院|区域|场景)/i;
const COGNITION_KEY_PREFIX = "cognition_key" + ":";

export class RetrievalOrchestrator {
  private readonly currentProjectionReader: CurrentProjectionReader | null;
  private readonly narrativeService: NarrativeSearchService;
  private readonly cognitionService: CognitionSearchService;
  private readonly episodeRepository: EpisodeRepository | null;

  constructor(deps: RetrievalOrchestratorDeps) {
    this.narrativeService = deps.narrativeService;
    this.cognitionService = deps.cognitionService;
    this.currentProjectionReader = deps.currentProjectionReader ?? null;
    this.episodeRepository = deps.episodeRepository ?? null;
  }

  async search(
    query: string,
    viewerContext: ViewerContext,
    role: AgentRole,
    override?: RetrievalTemplate,
    dedupContext?: RetrievalDedupContext,
    queryStrategy: RetrievalQueryStrategy = "default_retrieval",
    contestedCount?: number,
  ): Promise<RetrievalResult> {
    const baseTemplate = resolveTemplate(role, override);
    const template = this.applyQueryStrategy(baseTemplate, queryStrategy);
    const effectiveConflictNotesBudget = this.resolveConflictNotesBudget(template, contestedCount);

    const seenText = this.seedSeenText(dedupContext);

    const recentCognitionKeys = new Set<string>(dedupContext?.recentCognitionKeys ?? []);
    if (this.currentProjectionReader && template.cognitionBudget > 0) {
      const currentRows = this.currentProjectionReader.getActiveCurrent(viewerContext.viewer_agent_id);
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

    const effectiveEpisodeBudget = this.resolveEpisodeBudget(query, template, viewerContext);
    const episodeHints = this.resolveEpisodeHints(query, viewerContext, effectiveEpisodeBudget);

    const narrativeHints: MemoryHint[] =
      template.narrativeEnabled && (template.narrativeBudget > 0 || effectiveEpisodeBudget > 0)
        ? await this.narrativeService.generateMemoryHints(
            query,
            viewerContext,
            Math.max(template.narrativeBudget + effectiveEpisodeBudget + 4, template.narrativeBudget),
          )
        : [];

    const rawCognitionHits: CognitionHit[] =
      template.cognitionEnabled && (template.cognitionBudget > 0 || effectiveConflictNotesBudget > 0)
        ? this.cognitionService.searchCognition({
            agentId: viewerContext.viewer_agent_id,
            query,
            activeOnly: true,
            limit: Math.max(template.cognitionBudget + effectiveConflictNotesBudget + 4, template.cognitionBudget),
          })
        : [];

    const cognitionHits = this.filterCognitionHits(rawCognitionHits, recentCognitionKeys, seenText);
    const typed = this.buildTypedSurface(
      template,
      cognitionHits,
      narrativeHints,
      episodeHints,
      seenText,
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
      queryEpisodeBoost: template.queryEpisodeBoost + 1,
      sceneEpisodeBoost: template.sceneEpisodeBoost + 1,
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

    if (template.cognitionEnabled && template.cognitionBudget > 0) {
      for (const hit of cognitionHits) {
        if (typed.cognition.length >= template.cognitionBudget) {
          break;
        }
        const key = hit.cognitionKey ?? this.extractCognitionKey(hit.source_ref);
        if (key && recentCognitionKeys.has(key)) {
          continue;
        }
        const normalized = this.normalizeText(hit.content);
        if (normalized.length === 0 || seenText.has(normalized)) {
          continue;
        }
        seenText.add(normalized);
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
        if (effectiveEpisodeBudget > 0 && this.isEpisodeCandidate(hint)) {
          continue;
        }
        const normalized = this.normalizeText(hint.content);
        if (normalized.length === 0 || seenText.has(normalized)) {
          continue;
        }
        seenText.add(normalized);
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
          if (normalized.length === 0 || seenText.has(normalized)) {
            continue;
          }
          seenText.add(normalized);
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
        const normalized = this.normalizeText(hint.content);
        if (normalized.length === 0 || seenText.has(normalized)) {
          continue;
        }
        seenText.add(normalized);
        typed.episode.push(hint);
      }

      for (const hint of narrativeHints) {
        if (typed.episode.length >= effectiveEpisodeBudget) {
          break;
        }
        if (!this.isEpisodeCandidate(hint)) {
          continue;
        }
        const normalized = this.normalizeText(hint.content);
        if (normalized.length === 0 || seenText.has(normalized)) {
          continue;
        }
        seenText.add(normalized);
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

  private resolveEpisodeHints(
    query: string,
    viewerContext: ViewerContext,
    effectiveEpisodeBudget: number,
  ): TypedNarrativeSegment[] {
    if (!this.episodeRepository || effectiveEpisodeBudget <= 0) {
      return [];
    }

    const rawRows = this.episodeRepository.readByAgent(
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

  private resolveEpisodeBudget(
    query: string,
    template: Required<RetrievalTemplate>,
    viewerContext: ViewerContext,
  ): number {
    let budget = Math.max(template.episodicBudget, template.episodeBudget);
    const trimmed = query.trim();
    if (trimmed.length > 0 && (EPISODE_QUERY_TRIGGER.test(trimmed) || EPISODE_DETECTIVE_TRIGGER.test(trimmed))) {
      budget += template.queryEpisodeBoost;
    }
    if (viewerContext.current_area_id != null && EPISODE_SCENE_TRIGGER.test(trimmed)) {
      budget += template.sceneEpisodeBoost;
    }
    return Math.max(0, budget);
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
      const terms = queryText.split(/\s+/).filter((term) => term.length >= 3);
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
