import type { CoreMemoryService } from "./core-memory";
import type { RetrievalService } from "./retrieval";
import type { ViewerContext } from "./types";

// ---------------------------------------------------------------------------
// Tool definition shape
// ---------------------------------------------------------------------------

export type MemoryToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, viewerContext: ViewerContext) => unknown | Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Navigator stub interface (T10 not yet created)
// ---------------------------------------------------------------------------

type GraphNavigatorLike = {
  explore(query: string, ctx: ViewerContext): unknown | Promise<unknown>;
};

type GraphStorageLike = {
  createPrivateBelief(params: {
    agentId: string;
    sourceEntityId: number;
    targetEntityId: number;
    predicate: string;
    beliefType?: string;
    confidence?: number;
    epistemicStatus?: string;
    provenance?: string;
  }): number;
};

// ---------------------------------------------------------------------------
// Service bag passed to registerMemoryTools
// ---------------------------------------------------------------------------

export type MemoryToolServices = {
  coreMemory: CoreMemoryService;
  retrieval: RetrievalService;
  navigator?: GraphNavigatorLike;
  storage?: GraphStorageLike;
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
// Tool: memory_search
// ---------------------------------------------------------------------------

function makeMemorySearch(services: MemoryToolServices): MemoryToolDefinition {
  return {
    name: "memory_search",
    description:
      `Search visible narrative memory using full-text search. Returns matching events and facts scoped to your visibility. ` +
      POINTER_GUIDE,
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
    async handler(args: Record<string, unknown>, viewerContext: ViewerContext) {
      const query = args.query as string;
      const results = await services.retrieval.searchVisibleNarrative(query, viewerContext);
      return { results };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_explore
// ---------------------------------------------------------------------------

function makeMemoryExplore(services: MemoryToolServices): MemoryToolDefinition {
  return {
    name: "memory_explore",
    description:
      `Deep graph-aware exploration of memory. Use for complex questions about causes, relationships, and timelines. ` +
      POINTER_GUIDE,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Exploration query (e.g. 'why did Alice leave the garden').",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler(args: Record<string, unknown>, viewerContext: ViewerContext) {
      const query = args.query as string;

      if (!services.navigator) {
        return { success: false, error: "GraphNavigator not available" };
      }

      return services.navigator.explore(query, viewerContext);
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: record_private_belief
// ---------------------------------------------------------------------------

function makeRecordPrivateBelief(services: MemoryToolServices): MemoryToolDefinition {
  return {
    name: "record_private_belief",
    description:
      `Record a private belief about the relationship between two entities. ` +
      `Use when you form a judgment, suspicion, or conclusion about someone or something. ` +
      `This is stored privately and invisible to other agents. ` +
      POINTER_GUIDE,
    parameters: {
      type: "object",
      properties: {
        source_entity: {
          type: "string",
          description: "Source entity pointer key (e.g. @Alice).",
        },
        target_entity: {
          type: "string",
          description: "Target entity pointer key (e.g. @Bob).",
        },
        predicate: {
          type: "string",
          description: "Relationship predicate (e.g. 'suspects_lying', 'likes', 'distrusts').",
        },
        belief_type: {
          type: "string",
          enum: ["observation", "inference", "suspicion", "intention"],
          description: "How this belief was formed.",
        },
        confidence: {
          type: "number",
          description: "Confidence level from 0.0 (uncertain) to 1.0 (certain).",
        },
      },
      required: ["source_entity", "target_entity", "predicate", "belief_type", "confidence"],
      additionalProperties: false,
    },
    handler(args: Record<string, unknown>, viewerContext: ViewerContext) {
      if (!services.storage) {
        return { success: false, error: "GraphStorage not available" };
      }

      const sourcePointer = args.source_entity as string;
      const targetPointer = args.target_entity as string;

      const sourceEntity = services.retrieval.resolveEntityByPointer(
        sourcePointer.replace(/^@/, ""),
        viewerContext.viewer_agent_id,
      );
      const targetEntity = services.retrieval.resolveEntityByPointer(
        targetPointer.replace(/^@/, ""),
        viewerContext.viewer_agent_id,
      );

      if (!sourceEntity) {
        return { success: false, error: `Entity not found: ${sourcePointer}. Create it first.` };
      }
      if (!targetEntity) {
        return { success: false, error: `Entity not found: ${targetPointer}. Create it first.` };
      }

      const beliefId = services.storage.createPrivateBelief({
        agentId: viewerContext.viewer_agent_id,
        sourceEntityId: sourceEntity.id,
        targetEntityId: targetEntity.id,
        predicate: args.predicate as string,
        beliefType: args.belief_type as string,
        confidence: args.confidence as number,
        provenance: "rp_agent_tool",
      });

      return { success: true, belief_id: beliefId };
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
  makeMemorySearch,
  makeMemoryExplore,
  makeRecordPrivateBelief,
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
