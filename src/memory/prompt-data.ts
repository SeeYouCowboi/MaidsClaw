import type { Db } from "../storage/database.js";
import { CoreMemoryService } from "./core-memory";
import { RetrievalService } from "./retrieval";
import type { TypedRetrievalResult } from "./retrieval/retrieval-orchestrator.js";
import { SharedBlockRepo } from "./shared-blocks/shared-block-repo.js";

import type { CoreMemoryLabel, NavigatorResult, ViewerContext } from "./types";

const PINNED_LABELS: CoreMemoryLabel[] = ["pinned_summary", "persona"];
// Legacy compat: user blocks still exist in DB (read-only) and are surfaced as shared blocks for display
const SHARED_LABELS: CoreMemoryLabel[] = ["user"];
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

export function getPinnedBlocks(agentId: string, db: Db): string {
  const blocks = getAllCoreMemoryBlocks(agentId, db);
  const pinned = blocks.filter((b) => PINNED_LABELS.includes(b.label));
  return renderCoreMemoryBlocks(pinned, "pinned_block");
}

export function getSharedBlocks(agentId: string, db: Db): string {
  const blocks = getAllCoreMemoryBlocks(agentId, db);
  const shared = blocks.filter((b) => SHARED_LABELS.includes(b.label));
  return renderCoreMemoryBlocks(shared, "shared_block");
}

export async function getTypedRetrievalSurface(
  userMessage: string,
  viewerContext: ViewerContext,
  db: Db,
  retrievalService?: RetrievalService,
): Promise<string> {
  if (userMessage.trim().length < 3) {
    return "";
  }

  const retrieval = resolveRetrievalService(db, retrievalService);
  const recentEntries = getRecentCognitionEntries(
    viewerContext.viewer_agent_id,
    viewerContext.session_id,
    db,
  );
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
  const conversationTexts = getConversationMessageContents(viewerContext.session_id, db);

  const typed = await retrieval.generateTypedRetrieval(userMessage, viewerContext, {
    recentCognitionKeys,
    recentCognitionTexts,
    conversationTexts,
  });

  return renderTypedRetrieval(typed);
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

type RecentCognitionSlotRow = {
  slot_payload: string;
};

type InteractionMessageRow = {
  payload: string;
};

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

export function getRecentCognition(agentId: string, sessionId: string, db: Db): string {
  const entries = getRecentCognitionEntries(agentId, sessionId, db);

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

function getRecentCognitionEntries(agentId: string, sessionId: string, db: Db): RecentCognitionEntry[] {
  const row = db.get<RecentCognitionSlotRow>(
    `SELECT slot_payload FROM recent_cognition_slots WHERE session_id = ? AND agent_id = ?`,
    [sessionId, agentId],
  );

  if (row === undefined) {
    return [];
  }

  try {
    const parsed = JSON.parse(row.slot_payload) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as RecentCognitionEntry[];
  } catch {
    return [];
  }
}

function getConversationMessageContents(sessionId: string, db: Db, limit = 12): string[] {
  const rows = db.query<InteractionMessageRow>(
    `SELECT payload
     FROM interaction_records
     WHERE session_id = ? AND record_type = 'message'
     ORDER BY record_index DESC
     LIMIT ?`,
    [sessionId, limit],
  );

  const lines: string[] = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as { content?: unknown };
      if (typeof payload.content === "string" && payload.content.trim().length > 0) {
        lines.push(payload.content);
      }
    } catch {
      continue;
    }
  }
  return lines;
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

function getAllCoreMemoryBlocks(agentId: string, db: Db): CoreMemoryRenderableBlock[] {
  const service = new CoreMemoryService(db);
  return service.getAllBlocks(agentId);
}

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

type AttachmentRow = {
  block_id: number;
};

/**
 * Get formatted shared blocks attached to an agent for prompt injection.
 * Queries shared_block_attachments for the agent, fetches block title and sections,
 * and formats as XML-like <shared_block> elements.
 * Returns empty string if no attachments exist.
 * Data source only — T24 Prompt Builder decides WHERE in the prompt to place this.
 */
export function getAttachedSharedBlocks(agentId: string, db: Db): string {
  const attachments = db.query<AttachmentRow>(
    `SELECT block_id FROM shared_block_attachments WHERE target_kind = 'agent' AND target_id = ?`,
    [agentId],
  );

  if (attachments.length === 0) {
    return "";
  }

  const repo = new SharedBlockRepo(db);
  const blocks: string[] = [];

  for (const attachment of attachments) {
    const block = repo.getBlock(attachment.block_id);
    if (!block) continue;

    const sections = repo.getSections(attachment.block_id);
    if (sections.length === 0) continue;

    const sectionLines = sections
      .map((s) => `${s.sectionPath}: ${s.content}`)
      .join("\n");

    blocks.push(`<shared_block title="${block.title}">\n${sectionLines}\n</shared_block>`);
  }

  return blocks.join("\n");
}
