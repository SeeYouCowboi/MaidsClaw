import type { CoreMemoryBlockRepo } from "../storage/domain-repos/contracts/core-memory-block-repo.js";
import type { EpisodeRepo } from "../storage/domain-repos/contracts/episode-repo.js";
import type { InteractionRepo } from "../storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import type { RecentSessionEntity } from "../storage/domain-repos/contracts/episode-repo.js";
import type { SharedBlockRepo as SharedBlockRepoContract } from "../storage/domain-repos/contracts/shared-block-repo.js";
import type { RetrievalService } from "./retrieval";
import type { TypedRetrievalResult } from "./retrieval/retrieval-orchestrator.js";
import type {
  KnownEntityPromptOptions,
  TypedRetrievalSurfaceOptions,
} from "../core/prompt-data-sources.js";
import type { TurnSettlementPayload } from "../interaction/contracts.js";
import {
  canonicalizeEntityMentionPointer,
  normalizeEntityMentions,
} from "./entity-mentions.js";

import type { CoreMemoryLabel, NavigatorResult, ViewerContext } from "./types";

export type PromptDataRepos = {
  coreMemoryBlockRepo: CoreMemoryBlockRepo;
  recentCognitionSlotRepo: RecentCognitionSlotRepo;
  interactionRepo: InteractionRepo;
  sharedBlockRepo: SharedBlockRepoContract;
};

const PINNED_LABELS: CoreMemoryLabel[] = ["pinned_summary", "persona"];
/**
 * Labels surfaced in the prompt as shared blocks.
 *
 * `user` was removed in V3 closeout — existing DB rows are retained (read-only)
 * but no longer injected into the active prompt. Use `persona` or `pinned_summary`
 * for any new agent-visible context. If re-display is needed for migration, add
 * `"user"` back here temporarily.
 */
const SHARED_LABELS: CoreMemoryLabel[] = [];

/**
 * Format graph navigator evidence for prompt injection.
 * Called by memory_explore tool to format response for RP Agent.
 * ViewerContext ensures evidence paths only include nodes visible to the requesting agent
 * (filtering happens at the navigator level; this function formats what it receives).
 * Handles null/empty navigatorResult gracefully.
 * Data source only — T24 Prompt Builder decides WHERE in the prompt to place this.
 */
export function formatNavigatorEvidence(
  navigatorResult: unknown,
  _viewerContext: ViewerContext,
): string {
  if (!navigatorResult || typeof navigatorResult !== "object") {
    return "";
  }

  const result = navigatorResult as NavigatorResult;

  if (!result.evidence_paths || result.evidence_paths.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push(`Query: "${result.query}" (${result.query_type})`);
  lines.push("");

  for (let i = 0; i < result.evidence_paths.length; i++) {
    const ep = result.evidence_paths[i];
    lines.push(`--- Evidence Path ${i + 1} (score: ${ep.score.path_score.toFixed(3)}) ---`);
    lines.push(`Seed: ${ep.path.seed}`);
    lines.push(`Depth: ${ep.path.depth}`);

    if (ep.path.edges.length > 0) {
      lines.push("Edges:");
      for (const edge of ep.path.edges) {
        const ts = edge.timestamp ? ` @${edge.timestamp}` : "";
        const summary = edge.summary ? ` — ${edge.summary}` : "";
        lines.push(`  ${edge.from} -[${edge.kind}]-> ${edge.to}${ts}${summary}`);
      }
    }

    if (ep.supporting_facts.length > 0) {
      lines.push(`Supporting facts: ${ep.supporting_facts.map((id) => `f:${id}`).join(", ")}`);
    }

    if (ep.supporting_nodes.length > 0) {
      lines.push(`Supporting nodes: ${ep.supporting_nodes.join(", ")}`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

type RecentCognitionEntry = {
  settlementId: string;
  committedAt: number;
  kind: string;
  key: string;
  summary: string;
  status?: "active" | "retracted";
  stance?: string;
  preContestedStance?: string;
  conflictEvidence?: string[];
  conflictSummary?: string;
  conflictFactorRefs?: string[];
  basis?: string;
  provenance?: string;
  groundingVerificationLevel?: string;
  sourceTurnVersion?: number;
};

export function formatRecentCognitionFromPayload(
  slotPayload: string | undefined,
  knownEntityHints?: string[],
): string {
  if (!slotPayload) {
    return "";
  }

  try {
    const parsed = JSON.parse(slotPayload) as unknown;
    if (!Array.isArray(parsed)) {
      return "";
    }
    return formatRecentCognitionEntries(
      parsed as RecentCognitionEntry[],
      knownEntityHints,
    );
  } catch {
    return "";
  }
}

function formatRecentCognitionEntries(
  entries: RecentCognitionEntry[],
  knownEntityHints?: string[],
): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "";
  }

  const activeEntries = filterContradictoryRecentCognitionEntries(
    entries.filter((e) => e.status !== "retracted"),
    knownEntityHints,
  );
  if (activeEntries.length === 0) {
    return "";
  }

  const latestByKey = new Map<string, RecentCognitionEntry>();
  for (const entry of activeEntries) {
    const compoundKey = `${entry.kind}:${entry.key}`;
    const existing = latestByKey.get(compoundKey);
    if (!existing) {
      latestByKey.set(compoundKey, entry);
    } else {
      const existingVer = existing.sourceTurnVersion ?? 0;
      const newVer = entry.sourceTurnVersion ?? 0;
      if (newVer > existingVer) {
        latestByKey.set(compoundKey, entry);
      } else if (newVer === existingVer && (entry.committedAt ?? 0) >= (existing.committedAt ?? 0)) {
        latestByKey.set(compoundKey, entry);
      }
    }
  }

  const compacted = Array.from(latestByKey.values());

  const activeCommitments = compacted.filter(
    (e) => e.kind === "commitment",
  );
  const nonCommitments = compacted.filter(
    (e) => e.kind !== "commitment",
  );

  nonCommitments.sort((a, b) => (b.committedAt ?? 0) - (a.committedAt ?? 0));

  const commitmentSlots = Math.min(activeCommitments.length, 4);
  const otherSlots = 10 - commitmentSlots;

  activeCommitments.sort((a, b) => (b.committedAt ?? 0) - (a.committedAt ?? 0));

  const rendered = [
    ...activeCommitments.slice(0, commitmentSlots),
    ...nonCommitments.slice(0, otherSlots),
  ].sort((a, b) => (b.committedAt ?? 0) - (a.committedAt ?? 0));

  return rendered
    .map((entry) => {
      if (entry.stance === "contested") {
        return formatContestedEntry(entry);
      }
      const prefix = getWeakMemoryPrefix(entry);
      return `• [${entry.kind}:${entry.key}] ${prefix}${entry.summary}`;
    })
    .join("\n");
}

const UNKNOWN_ENTITY_COGNITION_KEY_PATTERN =
  /(knowledge_gap|identity_unknown|uncertain_existence|identity_ambiguity|clarify_.*_identity|verify_.*_identity|no_knowledge(?:_of)?)/i;

function filterContradictoryRecentCognitionEntries(
  entries: RecentCognitionEntry[],
  knownEntityHints?: string[],
): RecentCognitionEntry[] {
  const knownForms = buildKnownEntityForms(knownEntityHints);
  if (knownForms.size === 0) {
    return entries;
  }

  return entries.filter((entry) => {
    if (!isUnknownEntityCognitionEntry(entry)) {
      return true;
    }
    return !recentCognitionEntryMentionsKnownEntity(entry, knownForms);
  });
}

function isUnknownEntityCognitionEntry(entry: RecentCognitionEntry): boolean {
  return (
    UNKNOWN_ENTITY_COGNITION_KEY_PATTERN.test(entry.key) ||
    matchesUnknownEntityConfusion(entry.summary)
  );
}

function recentCognitionEntryMentionsKnownEntity(
  entry: RecentCognitionEntry,
  knownForms: Set<string>,
): boolean {
  if (mentionsKnownEntity(entry.summary, knownForms)) {
    return true;
  }

  const keyParts = entry.key
    .split(/[/:]/)
    .map((part) => trimText(part))
    .filter((part): part is string => Boolean(part));
  for (const part of keyParts) {
    const canonical = canonicalizeEntityMentionPointer(part) ?? part;
    if (knownForms.has(part) || knownForms.has(canonical)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when an entry should be treated as low-confidence / fragmentary
 * memory based on its grounding metadata.
 */
function isWeakMemoryEntry(entry: RecentCognitionEntry): boolean {
  const basis = entry.basis ?? "unknown";
  const verification = entry.groundingVerificationLevel ?? "unverified";

  if (verification === "unverified") return true;
  if (basis === "belief" || basis === "unknown") return true;
  if (basis === "inference" && verification !== "strong_verified") return true;

  return false;
}

/**
 * Produces a `[basis=… provenance=… verification=…] ` prefix for weak-memory
 * entries, or an empty string for strongly-grounded entries.
 */
function getWeakMemoryPrefix(entry: RecentCognitionEntry): string {
  if (!isWeakMemoryEntry(entry)) return "";

  const basis = entry.basis ?? "unknown";
  const provenance = entry.provenance ?? "legacy_unknown";
  const verification = entry.groundingVerificationLevel ?? "unverified";

  return `[basis=${basis} provenance=${provenance} verification=${verification}] `;
}

function isWeakCognitionSegment(segment: { basis: string | null; groundingVerificationLevel?: string | null }): boolean {
  const basis = segment.basis ?? "unknown";
  const verification = (segment.groundingVerificationLevel as string | undefined) ?? "unverified";

  if (verification === "unverified") return true;
  if (basis === "belief" || basis === "unknown") return true;
  if (basis === "inference" && verification !== "strong_verified") return true;

  return false;
}

function getWeakMemoryPrefixForSegment(segment: { basis: string | null; provenance?: string | null; groundingVerificationLevel?: string | null }): string {
  if (!isWeakCognitionSegment(segment)) return "";

  const basis = segment.basis ?? "unknown";
  const provenance = (segment.provenance as string | undefined) ?? "legacy_unknown";
  const verification = (segment.groundingVerificationLevel as string | undefined) ?? "unverified";

  return `[basis=${basis} provenance=${provenance} verification=${verification}] `;
}

export function formatContestedEntry(entry: RecentCognitionEntry): string {
  const preStance = entry.preContestedStance ?? "unknown";
  const summary = entry.conflictSummary?.trim();
  const hasConflict = (entry.conflictFactorRefs?.length ?? 0) > 0 || (entry.conflictEvidence?.length ?? 0) > 0;
  const riskDetail = summary && summary.length > 0
    ? summary
    : (hasConflict ? "conflict detected" : "contested cognition");
  const riskNote = ` | Risk: ${riskDetail} (use explain tools for details)`;
  return `• [${entry.kind}:${entry.key}] [CONTESTED: was ${preStance}] ${entry.summary}${riskNote}`;
}

function renderTypedRetrieval(result: TypedRetrievalResult): string {
  const parts: string[] = [];

  if (result.scene_area.length > 0) {
    parts.push("[scene_area]");
    for (const fact of result.scene_area) {
      parts.push(`? [${fact.factKey}] ${JSON.stringify(fact.value)}`);
    }
  }

  if (result.scene_world.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("[scene_world]");
    for (const fact of result.scene_world) {
      parts.push(`? [${fact.factKey}] ${JSON.stringify(fact.value)}`);
    }
  }

  if (result.cognition.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("[cognition]");
    for (const hit of result.cognition) {
      const key = hit.cognitionKey ? `:${hit.cognitionKey}` : "";
      const prefix = getWeakMemoryPrefixForSegment(hit);
      parts.push(`• [${hit.kind}${key}] ${prefix}${hit.content}`);
    }
  }

  if (result.conflict_notes.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("[conflict_notes]");
    for (const hit of result.conflict_notes) {
      parts.push(`• ${hit.content}`);
    }
  }

  if (result.narrative.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("[narrative]");
    for (const hit of result.narrative) {
      parts.push(`• [${hit.doc_type}] ${hit.content}`);
    }
  }

  if (result.episode.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("[episode]");
    for (const hit of result.episode) {
      parts.push(`• [${hit.doc_type}] ${hit.content}`);
    }
  }

  return parts.join("\n").trim();
}

const UNKNOWN_ENTITY_CONFUSION_PATTERNS: RegExp[] = [
  /没(?:有)?印象/u,
  /没听过/u,
  /不认识/u,
  /无此人信息/u,
  /还没接触过/u,
  /不知道(?:这位|这个人|是谁)?/u,
  /\bnever heard of\b/i,
  /\bno impression\b/i,
  /\bnot familiar with\b/i,
  /\b(?:do not|don't|didn't)\s+(?:know|recognize|remember)\b/i,
];

function filterContradictoryEntityConfusionSegments(
  result: TypedRetrievalResult,
  knownEntityHints?: string[],
): TypedRetrievalResult {
  const knownForms = buildKnownEntityForms(knownEntityHints);
  if (knownForms.size === 0) {
    return result;
  }

  const shouldKeep = (content: string): boolean => {
    if (!matchesUnknownEntityConfusion(content)) {
      return true;
    }
    return !mentionsKnownEntity(content, knownForms);
  };

  return {
    ...result,
    narrative: result.narrative.filter((hit) => shouldKeep(hit.content)),
    episode: result.episode.filter((hit) => shouldKeep(hit.content)),
  };
}

function buildKnownEntityForms(knownEntityHints?: string[]): Set<string> {
  const forms = new Set<string>();
  for (const hint of knownEntityHints ?? []) {
    const trimmed = trimText(hint);
    if (!trimmed) {
      continue;
    }
    forms.add(trimmed);
    const canonical = canonicalizeEntityMentionPointer(trimmed);
    if (canonical) {
      forms.add(canonical);
    }
  }
  return forms;
}

function matchesUnknownEntityConfusion(content: string): boolean {
  return UNKNOWN_ENTITY_CONFUSION_PATTERNS.some((pattern) =>
    pattern.test(content),
  );
}

function mentionsKnownEntity(content: string, knownForms: Set<string>): boolean {
  for (const form of knownForms) {
    if (/[A-Za-z]/.test(form)) {
      const escaped = escapeRegExp(form);
      if (new RegExp(`\\b${escaped}\\b`, "i").test(content)) {
        return true;
      }
      continue;
    }
    if (content.includes(form)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type CoreMemoryRenderableBlock = {
  label: CoreMemoryLabel;
  chars_current: number;
  char_limit: number;
  value: string;
};

function renderCoreMemoryBlocks(
  blocks: CoreMemoryRenderableBlock[],
  tagName: "pinned_block" | "shared_block",
): string {
  if (blocks.length === 0) {
    return "";
  }

  return blocks
    .map(
      (block) =>
        `<${tagName} label="${block.label}" chars_current="${block.chars_current}" chars_limit="${block.char_limit}">${block.value}</${tagName}>`,
    )
    .join("\n");
}

export async function getPinnedBlocksAsync(agentId: string, repos: PromptDataRepos): Promise<string> {
  const blocks = await repos.coreMemoryBlockRepo.getAllBlocks(agentId);
  const pinned = blocks.filter((b) => PINNED_LABELS.includes(b.label));
  return renderCoreMemoryBlocks(pinned, "pinned_block");
}

export async function getSharedBlocksAsync(agentId: string, repos: PromptDataRepos): Promise<string> {
  const blocks = await repos.coreMemoryBlockRepo.getAllBlocks(agentId);
  const shared = blocks.filter((b) => SHARED_LABELS.includes(b.label));
  return renderCoreMemoryBlocks(shared, "shared_block");
}

export async function getRecentCognitionAsync(
  viewerContext: ViewerContext,
  repos: PromptDataRepos,
  episodeRepo?: EpisodeRepo,
): Promise<string> {
  const payload = await repos.recentCognitionSlotRepo.getSlotPayload(
    viewerContext.session_id,
    viewerContext.viewer_agent_id,
  );
  let recentEntityHints: string[] | undefined;

  if (episodeRepo?.readRecentSessionEntityHints) {
    try {
      recentEntityHints = await episodeRepo.readRecentSessionEntityHints(
        viewerContext.viewer_agent_id,
        viewerContext.session_id,
        20,
      );
    } catch {
      recentEntityHints = undefined;
    }
  }

  const settlementEntityMentions = await readRecentSettlementEntityMentions(
    viewerContext,
    repos,
    20,
  );
  if (settlementEntityMentions.length > 0) {
    const merged = new Set(recentEntityHints ?? []);
    for (const entity of settlementEntityMentions) {
      merged.add(entity.pointer_key);
      if (entity.display_name) {
        merged.add(entity.display_name);
      }
    }
    recentEntityHints = [...merged];
  }

  return formatRecentCognitionFromPayload(payload, recentEntityHints);
}

export async function getAttachedSharedBlocksAsync(agentId: string, repos: PromptDataRepos): Promise<string> {
  const blockIds = await repos.sharedBlockRepo.getAttachedBlockIds("agent", agentId);
  if (blockIds.length === 0) {
    return "";
  }

  const renderedBlocks: string[] = [];

  for (const blockId of blockIds) {
    const block = await repos.sharedBlockRepo.getBlock(blockId);
    if (!block) continue;

    const sections = await repos.sharedBlockRepo.getSections(blockId);
    if (sections.length === 0) continue;

    const sectionLines = sections
      .map((s) => `${s.sectionPath}: ${s.content}`)
      .join("\n");

    renderedBlocks.push(`<shared_block title="${block.title}">\n${sectionLines}\n</shared_block>`);
  }

  return renderedBlocks.join("\n");
}

async function readRecentSettlementEntityMentions(
  viewerContext: ViewerContext,
  repos: PromptDataRepos,
  settlementLimit = 20,
): Promise<RecentSessionEntity[]> {
  if (
    typeof repos.interactionRepo.getMaxIndex !== "function" ||
    typeof repos.interactionRepo.getBySession !== "function"
  ) {
    return [];
  }

  const maxIndex = await repos.interactionRepo.getMaxIndex(
    viewerContext.session_id,
  );
  if (maxIndex === undefined) {
    return [];
  }

  const records = await repos.interactionRepo.getBySession(
    viewerContext.session_id,
    { fromIndex: Math.max(0, maxIndex - settlementLimit * 6) },
  );
  const recentSettlements = records
    .filter((record) => record.recordType === "turn_settlement")
    .slice(-settlementLimit)
    .reverse();

  const merged = new Map<string, RecentSessionEntity>();
  for (const record of recentSettlements) {
    const payload = record.payload as Partial<TurnSettlementPayload>;
    if (
      typeof payload.ownerAgentId === "string" &&
      payload.ownerAgentId.length > 0 &&
      payload.ownerAgentId !== viewerContext.viewer_agent_id
    ) {
      continue;
    }

    let entityMentions: string[];
    try {
      entityMentions = normalizeEntityMentions(payload.entityMentions, {
        fieldName: "entityMentions",
      });
    } catch {
      continue;
    }

    for (const mention of entityMentions) {
      const pointerKey = canonicalizeEntityMentionPointer(mention);
      if (!pointerKey || merged.has(pointerKey)) {
        continue;
      }
      merged.set(pointerKey, {
        pointer_key: pointerKey,
        display_name: mention !== pointerKey ? mention : null,
        summary: null,
      });
    }
  }

  return [...merged.values()];
}

type RankedRecentSessionEntity = RecentSessionEntity & {
  sourcePriority: number;
  recencyRank: number;
};

function rankRecentSessionEntities(
  rows: RecentSessionEntity[],
  sourcePriority: number,
): RankedRecentSessionEntity[] {
  return rows.map((row, index) => ({
    ...row,
    sourcePriority,
    recencyRank: index,
  }));
}

export async function getTypedRetrievalSurfaceAsync(
  userMessage: string,
  viewerContext: ViewerContext,
  repos: PromptDataRepos,
  retrievalService: RetrievalService,
  options?: TypedRetrievalSurfaceOptions,
  episodeRepo?: EpisodeRepo,
): Promise<string> {
  if (userMessage.trim().length < 3) {
    return "";
  }

  const retrieval = retrievalService;
  const payload = await repos.recentCognitionSlotRepo.getSlotPayload(
    viewerContext.session_id,
    viewerContext.viewer_agent_id,
  );
  const recentEntries = parseRecentCognitionPayload(payload);
  const activeRecentEntries = recentEntries.filter(
    (e) => e.status !== "retracted" && (e.summary?.trim().length ?? 0) > 0,
  );
  const recentCognitionKeys = new Set<string>();
  for (const entry of activeRecentEntries) {
    const key = entry.key?.trim();
    const kind = entry.kind?.trim();
    if (!key || key.length === 0) {
      continue;
    }
    recentCognitionKeys.add(key);
    if (kind && kind.length > 0) {
      recentCognitionKeys.add(`${kind}:${key}`);
    }
  }
  const recentCognitionTexts = activeRecentEntries.map((entry) => entry.summary);
  const messageRecords = await repos.interactionRepo.getMessageRecords(viewerContext.session_id);
  const conversationTexts = messageRecords
    .slice(-12)
    .map((record) => {
      const p = record.payload as { content?: unknown };
      return typeof p.content === "string" ? p.content : "";
    })
    .filter((text) => text.trim().length > 0);
  const settlementEntityMentions = await readRecentSettlementEntityMentions(
    viewerContext,
    repos,
    20,
  );

  let recentEntityHints: string[] | undefined;
  if (episodeRepo) {
    try {
      recentEntityHints = await episodeRepo.readRecentSessionEntityHints(
        viewerContext.viewer_agent_id,
        viewerContext.session_id,
        20,
      );
    } catch {
      // Non-fatal — falls back to current-query-only entity resolution
    }
  }

  if (settlementEntityMentions.length > 0) {
    const merged = new Set(recentEntityHints ?? []);
    for (const entity of settlementEntityMentions) {
      merged.add(entity.pointer_key);
      if (entity.display_name) {
        merged.add(entity.display_name);
      }
    }
    recentEntityHints = [...merged];
  }

  const typed = await retrieval.generateTypedRetrieval(userMessage, viewerContext, {
    recentCognitionKeys,
    recentCognitionTexts,
    conversationTexts,
    recentEntityHints,
  }, undefined, "default_retrieval", undefined, options?.sceneRetrieval, options?.onRetrievalTraceCapture);

  const filtered = filterContradictoryEntityConfusionSegments(
    typed,
    recentEntityHints,
  );

  return renderTypedRetrieval(filtered);
}

function trimText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeKnownEntityCandidates(params: {
  recent: RankedRecentSessionEntity[];
}): RecentSessionEntity[] {
  const merged = new Map<string, RankedRecentSessionEntity>();
  for (const row of params.recent) {
    const pointerKey = trimText(row.pointer_key);
    if (!pointerKey) {
      continue;
    }
    const nextDisplayName = trimText(row.display_name);
    const nextSummary = trimText(row.summary);
    const existing = merged.get(pointerKey);
    if (!existing) {
      merged.set(pointerKey, {
        pointer_key: pointerKey,
        display_name: nextDisplayName,
        summary: nextSummary,
        sourcePriority: row.sourcePriority,
        recencyRank: row.recencyRank,
      });
      continue;
    }

    const samePriority = row.sourcePriority === existing.sourcePriority;
    const isFresher = samePriority && row.recencyRank < existing.recencyRank;
    const shouldPreferRow = row.sourcePriority > existing.sourcePriority || isFresher;

    merged.set(pointerKey, {
      pointer_key: pointerKey,
      display_name:
        nextDisplayName && (shouldPreferRow || !trimText(existing.display_name))
          ? nextDisplayName
          : trimText(existing.display_name),
      summary:
        nextSummary && (shouldPreferRow || !trimText(existing.summary))
          ? nextSummary
          : trimText(existing.summary),
      sourcePriority: shouldPreferRow
        ? row.sourcePriority
        : existing.sourcePriority,
      recencyRank: shouldPreferRow
        ? row.recencyRank
        : existing.recencyRank,
    });
  }

  return [...merged.values()]
    .sort((a, b) => {
      if (b.sourcePriority !== a.sourcePriority) {
        return b.sourcePriority - a.sourcePriority;
      }
      if (a.recencyRank !== b.recencyRank) {
        return a.recencyRank - b.recencyRank;
      }
      return a.pointer_key.localeCompare(b.pointer_key);
    })
    .map(({ pointer_key, display_name, summary }) => ({
      pointer_key,
      display_name,
      summary,
    }));
}

function renderKnownEntitiesBlock(
  entities: RecentSessionEntity[],
  options?: KnownEntityPromptOptions,
): string {
  const maxItems = options?.maxItems ?? 40;
  const maxChars = options?.maxChars ?? 800;

  const lines: string[] = [];
  let consumed = 0;
  for (const entity of entities.slice(0, maxItems)) {
    const pointerKey = trimText(entity.pointer_key);
    if (!pointerKey) {
      continue;
    }

    const displayName = trimText(entity.display_name);
    const summary = trimText(entity.summary);
    const detailParts: string[] = [];
    if (displayName && displayName !== pointerKey) {
      detailParts.push(displayName);
    }
    if (summary) {
      detailParts.push(summary);
    }

    const line =
      detailParts.length > 0
        ? `- ${pointerKey} — ${detailParts.join("；")}`
        : `- ${pointerKey}`;
    if (consumed + line.length > maxChars) {
      break;
    }
    lines.push(line);
    consumed += line.length;
  }

  if (lines.length === 0) {
    return "";
  }

  return [
    "<known_entities>",
    "(Use these existing pointer_key values exactly; do not translate or rewrite them. Create a new pointer_key only for genuinely new concepts.)",
    "(Names listed here are already established in session or world memory. Do NOT say you have never heard of them. If only their identity, role, or relationship is unclear, ask for that clarification without denying name familiarity.)",
    "",
    ...lines,
    "</known_entities>",
  ].join("\n");
}

export async function getKnownEntitiesForWritingAsync(
  viewerContext: ViewerContext,
  repos: PromptDataRepos,
  episodeRepo?: EpisodeRepo,
  options?: KnownEntityPromptOptions,
): Promise<string> {
  let recentEntities: RecentSessionEntity[] = [];

  if (episodeRepo?.readRecentSessionEntities) {
    try {
      recentEntities = await episodeRepo.readRecentSessionEntities(
        viewerContext.viewer_agent_id,
        viewerContext.session_id,
        40,
      );
    } catch {
      recentEntities = [];
    }
  } else if (episodeRepo) {
    try {
      const hints = await episodeRepo.readRecentSessionEntityHints(
        viewerContext.viewer_agent_id,
        viewerContext.session_id,
        40,
      );
      recentEntities = hints.map((pointerKey) => ({
        pointer_key: pointerKey,
        display_name: null,
        summary: null,
      }));
    } catch {
      recentEntities = [];
    }
  }

  const settlementEntities = await readRecentSettlementEntityMentions(
    viewerContext,
    repos,
    20,
  );

  const merged = mergeKnownEntityCandidates({
    recent: [
      ...rankRecentSessionEntities(settlementEntities, 3),
      ...rankRecentSessionEntities(recentEntities, 2),
    ],
  });
  return renderKnownEntitiesBlock(merged, options);
}

function parseRecentCognitionPayload(slotPayload: string | undefined): RecentCognitionEntry[] {
  if (!slotPayload) {
    return [];
  }
  try {
    const parsed = JSON.parse(slotPayload) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as RecentCognitionEntry[];
  } catch {
    return [];
  }
}
