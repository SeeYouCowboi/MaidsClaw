import type { EffectClass, TraceVisibility, ToolExecutionContract } from "../core/tools/tool-definition.js";
import type { CoreMemoryService } from "./core-memory";
import type { RetrievalService } from "./retrieval";
import { buildTimeSliceQuery, type TimeSliceDimension } from "./time-slice-query.js";
import type { MemoryExploreInput, NavigatorResult, ViewerContext } from "./types.js";

// ---------------------------------------------------------------------------
// Tool definition shape
// ---------------------------------------------------------------------------

export type MemoryToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effectClass?: EffectClass;
  traceVisibility?: TraceVisibility;
  executionContract?: ToolExecutionContract;
  handler: (args: Record<string, unknown>, viewerContext: ViewerContext) => unknown | Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Navigator stub interface (T10 not yet created)
// ---------------------------------------------------------------------------

type GraphNavigatorLike = {
  explore(query: string, ctx: ViewerContext, input?: MemoryExploreInput): NavigatorResult | Promise<NavigatorResult>;
};

// ---------------------------------------------------------------------------
// Service bag passed to registerMemoryTools
// ---------------------------------------------------------------------------

export type MemoryToolServices = {
  coreMemory: CoreMemoryService;
  retrieval: RetrievalService;
  navigator?: GraphNavigatorLike;
  narrativeSearch?: {
    searchNarrative(query: string, viewerContext: ViewerContext): Promise<unknown>;
  };
  cognitionSearch?: {
    searchCognition(params: {
      agentId: string;
      query?: string;
      kind?: string;
      stance?: string;
      basis?: string;
      activeOnly?: boolean;
      limit?: number;
    }): unknown;
  };
};

export type ToolExecutorLike = {
  registerLocal(tool: MemoryToolDefinition): void;
};

// ---------------------------------------------------------------------------
// Pointer syntax guide (shared across descriptions)
// ---------------------------------------------------------------------------

const POINTER_GUIDE =
  "Pointer syntax: @pointer_key for entities, #topic_name for topics, e:id for event IDs, f:id for fact IDs.";

// ---------------------------------------------------------------------------
// Forbidden labels for RP Agent tools
// ---------------------------------------------------------------------------

const FORBIDDEN_LABELS = ["index"] as const;

function isForbiddenLabel(label: string): boolean {
  return (FORBIDDEN_LABELS as readonly string[]).includes(label);
}

// ---------------------------------------------------------------------------
// Tool: core_memory_append
// ---------------------------------------------------------------------------

function makeCoreMemoryAppend(services: MemoryToolServices): MemoryToolDefinition {
  return {
    name: "core_memory_append",
    description:
      `Append content to a Core Memory block. Blocks hold persistent agent knowledge. ` +
      `Labels: 'character' (agent persona) or 'user' (user info). ` +
      POINTER_GUIDE,
    effectClass: "immediate_write",
    traceVisibility: "public",
    executionContract: {
      effect_type: "write_private",
      turn_phase: "in_turn",
      cardinality: "multiple",
      trace_visibility: "public",
    },
    parameters: {
      type: "object",
      properties: {
        label: {
          type: "string",
          enum: ["character", "user"],
          description: "Which core memory block to append to.",
        },
        content: {
          type: "string",
          description: "Text to append to the block.",
        },
      },
      required: ["label", "content"],
      additionalProperties: false,
    },
    handler(args: Record<string, unknown>, viewerContext: ViewerContext) {
      const label = args.label as string;
      const content = args.content as string;

      if (isForbiddenLabel(label)) {
        return { success: false, error: "Label 'index' is forbidden for RP Agent tools" };
      }

      const result = services.coreMemory.appendBlock(
        viewerContext.viewer_agent_id,
        label as "character" | "user",
        content,
      );
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: core_memory_replace
// ---------------------------------------------------------------------------

function makeCoreMemoryReplace(services: MemoryToolServices): MemoryToolDefinition {
  return {
    name: "core_memory_replace",
    description:
      `Replace content in a Core Memory block (first occurrence). ` +
      `Labels: 'character' (agent persona) or 'user' (user info). ` +
      POINTER_GUIDE,
    effectClass: "immediate_write",
    traceVisibility: "public",
    executionContract: {
      effect_type: "write_private",
      turn_phase: "in_turn",
      cardinality: "multiple",
      trace_visibility: "public",
    },
    parameters: {
      type: "object",
      properties: {
        label: {
          type: "string",
          enum: ["character", "user"],
          description: "Which core memory block to edit.",
        },
        old_content: {
          type: "string",
          description: "Existing text to find (must match exactly).",
        },
        new_content: {
          type: "string",
          description: "Replacement text.",
        },
      },
      required: ["label", "old_content", "new_content"],
      additionalProperties: false,
    },
    handler(args: Record<string, unknown>, viewerContext: ViewerContext) {
      const label = args.label as string;
      const oldContent = args.old_content as string;
      const newContent = args.new_content as string;

      if (isForbiddenLabel(label)) {
        return { success: false, error: "Label 'index' is forbidden for RP Agent tools" };
      }

      const result = services.coreMemory.replaceBlock(
        viewerContext.viewer_agent_id,
        label as "character" | "user",
        oldContent,
        newContent,
      );
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_read
// ---------------------------------------------------------------------------

function makeMemoryRead(services: MemoryToolServices): MemoryToolDefinition {
  return {
    name: "memory_read",
    description:
      `Read memory by pointer. Provide ONE of: entity (pointer key), topic (name), event_ids, or fact_ids. ` +
      POINTER_GUIDE,
    effectClass: "read_only",
    traceVisibility: "public",
    executionContract: {
      effect_type: "read_only",
      turn_phase: "any",
      cardinality: "multiple",
      trace_visibility: "public",
    },
    parameters: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description: "Entity pointer key to look up (e.g. @Alice).",
        },
        topic: {
          type: "string",
          description: "Topic name to look up (e.g. #coffee).",
        },
        event_ids: {
          type: "array",
          items: { type: "number" },
          description: "Event IDs to retrieve (e.g. from e:123).",
        },
        fact_ids: {
          type: "array",
          items: { type: "number" },
          description: "Fact IDs to retrieve (e.g. from f:42).",
        },
      },
      additionalProperties: false,
    },
    handler(args: Record<string, unknown>, viewerContext: ViewerContext) {
      if (typeof args.entity === "string") {
        return services.retrieval.readByEntity(args.entity, viewerContext);
      }
      if (typeof args.topic === "string") {
        return services.retrieval.readByTopic(args.topic, viewerContext);
      }
      if (Array.isArray(args.event_ids)) {
        return services.retrieval.readByEventIds(args.event_ids as number[], viewerContext);
      }
      if (Array.isArray(args.fact_ids)) {
        return services.retrieval.readByFactIds(args.fact_ids as number[], viewerContext);
      }
      return { success: false, error: "Provide one of: entity, topic, event_ids, or fact_ids" };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared narrative search handler (used by narrative_search + memory_search alias)
// ---------------------------------------------------------------------------

async function narrativeSearchHandler(
  services: MemoryToolServices,
  args: Record<string, unknown>,
  viewerContext: ViewerContext,
) {
  const query = args.query as string;
  if (services.narrativeSearch) {
    const results = await services.narrativeSearch.searchNarrative(query, viewerContext);
    return { results };
  }
  const results = await services.retrieval.searchVisibleNarrative(query, viewerContext);
  return { results };
}

function toExplainShell(result: NavigatorResult): {
  query: string;
  query_type: string;
  summary: string;
  drilldown?: NavigatorResult["drilldown"];
  evidence_paths: Array<{
    rank: number;
    summary: string;
    score: number;
    seed: string;
    depth: number;
    visible_steps: string[];
    redacted: unknown[];
    supporting_facts: number[];
  }>;
} {
  return {
    query: result.query,
    query_type: result.query_type,
    summary: result.summary ?? `Explain ${result.query_type}: ${result.evidence_paths.length} path(s)`,
    ...(result.drilldown
      ? {
        drilldown: {
          ...result.drilldown,
        },
      }
      : {}),
    evidence_paths: result.evidence_paths.map((path, index) => ({
      rank: index + 1,
      summary: path.summary ?? `${path.path.nodes.length} visible steps`,
      score: path.score.path_score,
      seed: path.path.seed,
      depth: path.path.depth,
      visible_steps: [...path.path.nodes],
      redacted: [...(path.redacted_placeholders ?? [])],
      supporting_facts: [...path.supporting_facts],
    })),
  };
}

// ---------------------------------------------------------------------------
// Tool: narrative_search
// ---------------------------------------------------------------------------

function makeNarrativeSearch(services: MemoryToolServices): MemoryToolDefinition {
  return {
    name: "narrative_search",
    description:
      `Search visible narrative memory using full-text search. Returns matching events and facts scoped to your visibility. ` +
      POINTER_GUIDE,
    effectClass: "read_only",
    traceVisibility: "public",
    executionContract: {
      effect_type: "read_only",
      turn_phase: "any",
      cardinality: "multiple",
      trace_visibility: "public",
    },
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (natural language or keywords, min 3 chars).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (args, viewerContext) => narrativeSearchHandler(services, args, viewerContext),
  };
}

// ---------------------------------------------------------------------------
// Tool: cognition_search
// ---------------------------------------------------------------------------

function makeCognitionSearch(services: MemoryToolServices): MemoryToolDefinition {
  return {
    name: "cognition_search",
    description:
      `Search private cognition (assertions, evaluations, commitments) for the current agent. ` +
      `Returns matching cognition hits scoped to the viewer agent. ` +
      POINTER_GUIDE,
    effectClass: "read_only",
    traceVisibility: "public",
    executionContract: {
      effect_type: "read_only",
      turn_phase: "any",
      cardinality: "multiple",
      capability_requirements: ["cognition_read"],
      trace_visibility: "public",
    },
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (natural language or keywords, min 3 chars).",
        },
        kind: {
          type: "string",
          enum: ["assertion", "evaluation", "commitment"],
          description: "Filter by cognition kind.",
        },
        stance: {
          type: "string",
          description: "Filter by stance (e.g. accepted, tentative, contested, rejected).",
        },
        basis: {
          type: "string",
          description: "Filter by basis (e.g. first_hand, inference, introspection).",
        },
        active_only: {
          type: "boolean",
          description: "If true, return only active cognition (default for commitments).",
        },
      },
      additionalProperties: false,
    },
    handler(args: Record<string, unknown>, viewerContext: ViewerContext) {
      if (!services.cognitionSearch) {
        return { success: false, error: "CognitionSearch not available" };
      }

      return services.cognitionSearch.searchCognition({
        agentId: viewerContext.viewer_agent_id,
        query: typeof args.query === "string" ? args.query : undefined,
        kind: typeof args.kind === "string" ? args.kind : undefined,
        stance: typeof args.stance === "string" ? args.stance : undefined,
        basis: typeof args.basis === "string" ? args.basis : undefined,
        activeOnly: typeof args.active_only === "boolean" ? args.active_only : undefined,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_search (compatibility alias → narrative_search behavior)
// ---------------------------------------------------------------------------

function makeMemorySearch(services: MemoryToolServices): MemoryToolDefinition {
  return {
    name: "memory_search",
    description:
      `Search visible narrative memory (compatibility alias for narrative_search). ` +
      `Returns matching events and facts scoped to your visibility. ` +
      POINTER_GUIDE,
    effectClass: "read_only",
    traceVisibility: "public",
    executionContract: {
      effect_type: "read_only",
      turn_phase: "any",
      cardinality: "multiple",
      trace_visibility: "public",
    },
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (natural language or keywords, min 3 chars).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (args, viewerContext) => narrativeSearchHandler(services, args, viewerContext),
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_explore
// ---------------------------------------------------------------------------

function makeMemoryExplore(services: MemoryToolServices): MemoryToolDefinition {
  return {
    name: "memory_explore",
    description:
      `Explain evidence paths for why/relationship/timeline/state/conflict questions. ` +
      `Returns concise summaries with redacted placeholders for hidden steps. ` +
      POINTER_GUIDE,
    effectClass: "read_only",
    traceVisibility: "public",
    executionContract: {
      effect_type: "read_only",
      turn_phase: "any",
      cardinality: "multiple",
      trace_visibility: "public",
    },
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Exploration query (e.g. 'why did Alice leave the garden').",
        },
        mode: {
          type: "string",
          enum: ["why", "timeline", "relationship", "state", "conflict"],
          description: "Optional explicit explain mode. Overrides query intent guess when set.",
        },
        focusRef: {
          type: "string",
          description: "Optional focus node_ref (e.g. event:12, fact:3).",
        },
        focusCognitionKey: {
          type: "string",
          description: "Optional cognition thread key to anchor conflict/state explain.",
        },
        asOfTime: {
          type: "number",
          description: "Time cutoff value. Use with timeDimension to select valid_time ('what was the world state then') or committed_time ('what did the agent know then').",
        },
        timeDimension: {
          type: "string",
          enum: ["valid_time", "committed_time"],
          description: "Which time dimension to slice: valid_time (world state) or committed_time (agent knowledge). Used with asOfTime.",
        },
        asOfValidTime: {
          type: "number",
          description: "Optional valid-time cutoff (legacy). Prefer asOfTime + timeDimension.",
        },
        asOfCommittedTime: {
          type: "number",
          description: "Optional committed-time cutoff (legacy). Prefer asOfTime + timeDimension.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async handler(args: Record<string, unknown>, viewerContext: ViewerContext) {
      const query = args.query as string;
      if (typeof query !== "string" || query.trim().length === 0) {
        return { success: false, error: "query must be a non-empty string" };
      }

      if (!services.navigator) {
        return { success: false, error: "GraphNavigator not available" };
      }

      let resolvedValidTime = typeof args.asOfValidTime === "number" ? args.asOfValidTime : undefined;
      let resolvedCommittedTime = typeof args.asOfCommittedTime === "number" ? args.asOfCommittedTime : undefined;

      if (typeof args.asOfTime === "number" && typeof args.timeDimension === "string") {
        const dimensionQuery = buildTimeSliceQuery({
          dimension: args.timeDimension as TimeSliceDimension,
          asOf: args.asOfTime,
        });
        if (resolvedValidTime == null && dimensionQuery.asOfValidTime != null) {
          resolvedValidTime = dimensionQuery.asOfValidTime;
        }
        if (resolvedCommittedTime == null && dimensionQuery.asOfCommittedTime != null) {
          resolvedCommittedTime = dimensionQuery.asOfCommittedTime;
        }
      }

      const result = await services.navigator.explore(query.trim(), viewerContext, {
        query: query.trim(),
        mode: typeof args.mode === "string" ? args.mode as MemoryExploreInput["mode"] : undefined,
        focusRef: typeof args.focusRef === "string" ? args.focusRef as MemoryExploreInput["focusRef"] : undefined,
        focusCognitionKey: typeof args.focusCognitionKey === "string" ? args.focusCognitionKey : undefined,
        asOfValidTime: resolvedValidTime,
        asOfCommittedTime: resolvedCommittedTime,
      });
      return toExplainShell(result);
    },
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const TOOL_FACTORIES = [
  makeCoreMemoryAppend,
  makeCoreMemoryReplace,
  makeMemoryRead,
  makeNarrativeSearch,
  makeCognitionSearch,
  makeMemorySearch,
  makeMemoryExplore,
] as const;

export function buildMemoryTools(services: MemoryToolServices): MemoryToolDefinition[] {
  return TOOL_FACTORIES.map((factory) => factory(services));
}

export function registerMemoryTools(
  executor: ToolExecutorLike,
  services: MemoryToolServices,
): void {
  const tools = buildMemoryTools(services);
  for (const tool of tools) {
    executor.registerLocal(tool);
  }
}
