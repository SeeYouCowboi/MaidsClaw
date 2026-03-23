import type { Db } from "../storage/database.js";
import { CoreMemoryService } from "./core-memory";
import { RetrievalService } from "./retrieval";
import { SharedBlockRepo } from "./shared-blocks/shared-block-repo.js";

import type { CoreMemoryLabel, NavigatorResult, ViewerContext } from "./types";

/**
 * Get all core memory blocks formatted as XML for system prompt injection.
 * Always returns all 3 blocks (character, user, index).
 * Data source only — T24 Prompt Builder decides WHERE in the prompt to place this.
 */
export function getCoreMemoryBlocks(agentId: string, db: Db): string {
  const blocks = getAllCoreMemoryBlocks(agentId, db);
  return renderCoreMemoryBlocks(blocks, "core_memory");
}

const PINNED_LABELS: CoreMemoryLabel[] = ["pinned_summary", "character"];
const SHARED_LABELS: CoreMemoryLabel[] = ["user"];

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

/**
 * T9 placeholder — returns empty string until typed retrieval is implemented.
 */
export function getTypedRetrievalPlaceholder(_agentId: string, _db: Db): string {
  return "";
}

/**
 * @deprecated Since T8 — not a canonical RP slot. Kept for non-RP consumers.
 * Get formatted memory hints as bullet list for prompt injection.
 * Returns empty string when no hints (< 3 char query, no matches).
 * ViewerContext determines which scope-partitioned FTS5 tables are queried.
 * Data source only — T24 Prompt Builder decides WHERE in the prompt to place this.
 */
export async function getMemoryHints(
  userMessage: string,
  viewerContext: ViewerContext,
  db: Db,
  limit?: number,
): Promise<string> {
  const service = new RetrievalService(db);
  const hints = await service.generateMemoryHints(userMessage, viewerContext, limit ?? 5);

  if (hints.length === 0) {
    return "";
  }

  return hints
    .map((hint) => {
      const nodeKind = hint.source_ref.split(":")[0];
      return `• [${nodeKind}] ${hint.content}`;
    })
    .join("\n");
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
};

export function getRecentCognition(agentId: string, sessionId: string, db: Db): string {
  const row = db.get<RecentCognitionSlotRow>(
    `SELECT slot_payload FROM recent_cognition_slots WHERE session_id = ? AND agent_id = ?`,
    [sessionId, agentId],
  );

  if (row === undefined) {
    return "";
  }

  let entries: RecentCognitionEntry[];
  try {
    entries = JSON.parse(row.slot_payload) as RecentCognitionEntry[];
  } catch {
    return "";
  }

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
        return `\u2022 [${entry.kind}:${entry.key}] (retracted)`;
      }
      if (entry.stance === "contested") {
        return formatContestedEntry(entry);
      }
      return `\u2022 [${entry.kind}:${entry.key}] ${entry.summary}`;
    })
    .join("\n");
}

export function formatContestedEntry(entry: RecentCognitionEntry): string {
  const preStance = entry.preContestedStance ?? "unknown";
  const hasConflict = (entry.conflictEvidence?.length ?? 0) > 0;
  const riskNote = hasConflict
    ? " | Risk: conflict detected (use explain tools for details)"
    : " | Risk: contested cognition";
  return `• [${entry.kind}:${entry.key}] [CONTESTED: was ${preStance}] ${entry.summary}${riskNote}`;
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
  tagName: "core_memory" | "pinned_block" | "shared_block",
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
