import type { AgentRole } from "../../agents/profile.js";
import type { ViewerContext } from "../../core/contracts/viewer-context.js";
import type { MemoryHint } from "../types.js";
import type { NarrativeSearchService } from "../narrative/narrative-search.js";
import type { CognitionSearchService, CognitionHit, CurrentProjectionReader } from "../cognition/cognition-search.js";
import type { RetrievalTemplate } from "../contracts/retrieval-template.js";
import { resolveTemplate } from "../contracts/retrieval-template.js";

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
const EPISODE_SCENE_TRIGGER = /(here|there|room|hall|kitchen|garden|area|scene|此处|这里|那边|房间|庭院|区域|场景)/i;

export class RetrievalOrchestrator {
  private readonly currentProjectionReader: CurrentProjectionReader | null;

  constructor(
    private readonly narrativeService: NarrativeSearchService,
    private readonly cognitionService: CognitionSearchService,
    currentProjectionReader?: CurrentProjectionReader,
  ) {
    this.currentProjectionReader = currentProjectionReader ?? null;
  }

  async search(
    query: string,
    viewerContext: ViewerContext,
    role: AgentRole,
    override?: RetrievalTemplate,
    dedupContext?: RetrievalDedupContext,
  ): Promise<RetrievalResult> {
    const template = resolveTemplate(role, override);

    const seenText = this.seedSeenText(dedupContext);

    const recentCognitionKeys = new Set<string>(dedupContext?.recentCognitionKeys ?? []);
    if (this.currentProjectionReader) {
      const currentRows = this.currentProjectionReader.getActiveCurrent(viewerContext.viewer_agent_id);
      for (const row of currentRows) {
        const key = row.cognition_key?.trim();
        if (key) {
          recentCognitionKeys.add(key);
        }
      }
    }

    const effectiveEpisodeBudget = this.resolveEpisodeBudget(query, template, viewerContext);

    const narrativeHints: MemoryHint[] =
      template.narrativeEnabled && (template.narrativeBudget > 0 || effectiveEpisodeBudget > 0)
        ? await this.narrativeService.generateMemoryHints(
            query,
            viewerContext,
            Math.max(template.narrativeBudget + effectiveEpisodeBudget + 4, template.narrativeBudget),
          )
        : [];

    const rawCognitionHits: CognitionHit[] =
      template.cognitionEnabled && (template.cognitionBudget > 0 || template.conflictNotesBudget > 0)
        ? this.cognitionService.searchCognition({
            agentId: viewerContext.viewer_agent_id,
            query,
            activeOnly: true,
            limit: Math.max(template.cognitionBudget + template.conflictNotesBudget + 4, template.cognitionBudget),
          })
        : [];

    const cognitionHits = this.filterCognitionHits(rawCognitionHits, recentCognitionKeys, seenText);
    const typed = this.buildTypedSurface(
      template,
      cognitionHits,
      narrativeHints,
      seenText,
      recentCognitionKeys,
      effectiveEpisodeBudget,
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

  private buildTypedSurface(
    template: Required<RetrievalTemplate>,
    cognitionHits: CognitionHit[],
    narrativeHints: MemoryHint[],
    seenText: Set<string>,
    recentCognitionKeys: Set<string>,
    effectiveEpisodeBudget: number,
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
        if (this.isEpisodeCandidate(hint)) {
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

    if (template.conflictNotesEnabled && template.conflictNotesBudget > 0) {
      for (const hit of cognitionHits) {
        if (typed.conflict_notes.length >= template.conflictNotesBudget) {
          break;
        }
        if (hit.stance !== "contested" || !hit.conflictEvidence || hit.conflictEvidence.length === 0) {
          continue;
        }
        const cognitionKey = hit.cognitionKey ?? this.extractCognitionKey(hit.source_ref);
        for (const note of hit.conflictEvidence) {
          if (typed.conflict_notes.length >= template.conflictNotesBudget) {
            break;
          }
          const normalized = this.normalizeText(note);
          if (normalized.length === 0 || seenText.has(normalized)) {
            continue;
          }
          seenText.add(normalized);
          typed.conflict_notes.push({
            source_ref: `conflict_note:${hit.source_ref}`,
            from_source_ref: String(hit.source_ref),
            cognitionKey,
            content: note,
            score: hit.updated_at,
          });
        }
      }
    }

    if (template.episodeEnabled && effectiveEpisodeBudget > 0) {
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
    let budget = template.episodeBudget;
    const trimmed = query.trim();
    if (trimmed.length > 0 && EPISODE_QUERY_TRIGGER.test(trimmed)) {
      budget += template.queryEpisodeBoost;
    }
    if (viewerContext.current_area_id != null && EPISODE_SCENE_TRIGGER.test(trimmed)) {
      budget += template.sceneEpisodeBoost;
    }
    return Math.max(0, budget);
  }

  private isEpisodeCandidate(hint: MemoryHint): boolean {
    return hint.doc_type.includes("event") || String(hint.source_ref).startsWith("event:");
  }

  private normalizeText(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
  }

  private extractCognitionKey(sourceRef: string): string | null {
    const text = String(sourceRef);
    if (!text.startsWith("cognition_key:")) {
      return null;
    }
    const key = text.slice("cognition_key:".length).trim();
    return key.length > 0 ? key : null;
  }
}
