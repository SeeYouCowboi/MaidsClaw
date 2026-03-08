import type { Db } from "../storage/database.js";
import { CoreMemoryService } from "./core-memory";
import { RetrievalService } from "./retrieval";
import type { NavigatorResult, ViewerContext } from "./types";

/**
 * Get all core memory blocks formatted as XML for system prompt injection.
 * Always returns all 3 blocks (character, user, index).
 * Data source only — T24 Prompt Builder decides WHERE in the prompt to place this.
 */
export function getCoreMemoryBlocks(agentId: string, db: Db): string {
  const service = new CoreMemoryService(db);
  const blocks = service.getAllBlocks(agentId);

  return blocks
    .map(
      (block) =>
        `<core_memory label="${block.label}" chars_current="${block.chars_current}" chars_limit="${block.char_limit}">${block.value}</core_memory>`,
    )
    .join("\n");
}

/**
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
