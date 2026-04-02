import type { Db } from "../storage/db-types.js";
import type { CoreMemoryBlockRepo } from "../storage/domain-repos/contracts/core-memory-block-repo.js";
import type { InteractionRepo } from "../storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import type { SharedBlockRepo as SharedBlockRepoContract } from "../storage/domain-repos/contracts/shared-block-repo.js";
import { RetrievalService } from "./retrieval";
import type { TypedRetrievalResult } from "./retrieval/retrieval-orchestrator.js";

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
const retrievalServiceByDb = new WeakMap<Db, RetrievalService>();

function resolveRetrievalService(db: Db, retrievalService?: RetrievalService): RetrievalService {
  if (retrievalService) {
    return retrievalService;
  }

  const cached = retrievalServiceByDb.get(db);
  if (cached) {
    return cached;
  }

  const created = RetrievalService.create(db);
  retrievalServiceByDb.set(db, created);
  return created;
}

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
};

export function formatRecentCognitionFromPayload(slotPayload: string | undefined): string {
  if (!slotPayload) {
    return "";
  }

  try {
    const parsed = JSON.parse(slotPayload) as unknown;
    if (!Array.isArray(parsed)) {
      return "";
    }
    return formatRecentCognitionEntries(parsed as RecentCognitionEntry[]);
  } catch {
    return "";
  }
}

function formatRecentCognitionEntries(entries: RecentCognitionEntry[]): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "";
  }

  const latestByKey = new Map<string, RecentCognitionEntry>();
  for (const entry of entries) {
    const compoundKey = `${entry.kind}:${entry.key}`;
    const existing = latestByKey.get(compoundKey);
    if (!existing || (entry.committedAt ?? 0) >= (existing.committedAt ?? 0)) {
      latestByKey.set(compoundKey, entry);
    }
  }

  const compacted = Array.from(latestByKey.values());

  const activeCommitments = compacted.filter(
    (e) => e.kind === "commitment" && e.status !== "retracted",
  );
  const nonCommitments = compacted.filter(
    (e) => e.kind !== "commitment" || e.status === "retracted",
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
      if (entry.status === "retracted") {
        return `• [${entry.kind}:${entry.key}] (retracted)`;
      }
      if (entry.stance === "contested") {
        return formatContestedEntry(entry);
      }
      return `• [${entry.kind}:${entry.key}] ${entry.summary}`;
    })
    .join("\n");
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

  if (result.cognition.length > 0) {
    parts.push("[cognition]");
    for (const hit of result.cognition) {
      const key = hit.cognitionKey ? `:${hit.cognitionKey}` : "";
      parts.push(`• [${hit.kind}${key}] ${hit.content}`);
    }
  }

  if (result.narrative.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("[narrative]");
    for (const hit of result.narrative) {
      parts.push(`• [${hit.doc_type}] ${hit.content}`);
    }
  }

  if (result.conflict_notes.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("[conflict_notes]");
    for (const hit of result.conflict_notes) {
      parts.push(`• ${hit.content}`);
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

export async function getRecentCognitionAsync(agentId: string, sessionId: string, repos: PromptDataRepos): Promise<string> {
  const payload = await repos.recentCognitionSlotRepo.getSlotPayload(sessionId, agentId);
  return formatRecentCognitionFromPayload(payload);
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

export async function getTypedRetrievalSurfaceAsync(
  userMessage: string,
  viewerContext: ViewerContext,
  db: Db,
  repos: PromptDataRepos,
  retrievalService?: RetrievalService,
): Promise<string> {
  if (userMessage.trim().length < 3) {
    return "";
  }

  const retrieval = resolveRetrievalService(db, retrievalService);
  const payload = await repos.recentCognitionSlotRepo.getSlotPayload(
    viewerContext.session_id,
    viewerContext.viewer_agent_id,
  );
  const recentEntries = parseRecentCognitionPayload(payload);
  const recentCognitionKeys = new Set<string>();
  for (const entry of recentEntries) {
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
  const recentCognitionTexts = recentEntries.map((entry) => entry.summary);
  const messageRecords = await repos.interactionRepo.getMessageRecords(viewerContext.session_id);
  const conversationTexts = messageRecords
    .slice(-12)
    .map((record) => {
      const p = record.payload as { content?: unknown };
      return typeof p.content === "string" ? p.content : "";
    })
    .filter((text) => text.trim().length > 0);

  const typed = await retrieval.generateTypedRetrieval(userMessage, viewerContext, {
    recentCognitionKeys,
    recentCognitionTexts,
    conversationTexts,
  });

  return renderTypedRetrieval(typed);
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
