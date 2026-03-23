import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemorySchema } from "./schema";
import { CoreMemoryService } from "./core-memory";
import { RetrievalService } from "./retrieval";
import {
  buildMemoryTools,
  registerMemoryTools,
  type MemoryToolDefinition,
  type MemoryToolServices,
  type ToolExecutorLike,
} from "./tools";
import type { ViewerContext } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb() {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

function makeViewerContext(overrides?: Partial<ViewerContext>): ViewerContext {
  return {
    viewer_agent_id: "agent-1",
    viewer_role: "rp_agent",
    current_area_id: 1,
    session_id: "sess-1",
    ...overrides,
  };
}

function toolByName(tools: MemoryToolDefinition[], name: string): MemoryToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Memory Tools", () => {
  let db: Database;
  let coreMemory: CoreMemoryService;
  let retrieval: RetrievalService;
  let services: MemoryToolServices;
  let tools: MemoryToolDefinition[];
  let ctx: ViewerContext;

  beforeEach(() => {
    db = freshDb();
    coreMemory = new CoreMemoryService(db as any);
    retrieval = new RetrievalService(db as any);
    services = { coreMemory, retrieval };
    tools = buildMemoryTools(services);
    ctx = makeViewerContext();
    coreMemory.initializeBlocks(ctx.viewer_agent_id);
  });

  // -------------------------------------------------------------------------
  // Schema definitions
  // -------------------------------------------------------------------------

  describe("tool definitions", () => {
    it("defines exactly 7 tools", () => {
      expect(tools).toHaveLength(7);
    });

    it("all tools have valid JSON Schema parameter definitions", () => {
      const expectedNames = [
        "core_memory_append",
        "core_memory_replace",
        "memory_read",
        "narrative_search",
        "cognition_search",
        "memory_search",
        "memory_explore",
      ];

      for (const name of expectedNames) {
        const tool = toolByName(tools, name);
        expect(tool.name).toBe(name);
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(10);
        expect(typeof tool.handler).toBe("function");

        // JSON Schema structure
        const params = tool.parameters as Record<string, unknown>;
        expect(params.type).toBe("object");
        expect(params.properties).toBeDefined();
        expect(typeof params.properties).toBe("object");
      }
    });

    it("tool descriptions include pointer syntax guide", () => {
      for (const tool of tools) {
        expect(tool.description).toContain("@pointer_key");
        expect(tool.description).toContain("#topic_name");
        expect(tool.description).toContain("e:id");
        expect(tool.description).toContain("f:id");
      }
    });

    it("core_memory_append has label enum restricted to character and user", () => {
      const tool = toolByName(tools, "core_memory_append");
      const props = (tool.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
      expect(props.label.enum).toEqual(["character", "user"]);
    });

    it("core_memory_replace has label enum restricted to character and user", () => {
      const tool = toolByName(tools, "core_memory_replace");
      const props = (tool.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
      expect(props.label.enum).toEqual(["character", "user"]);
    });
  });

  // -------------------------------------------------------------------------
  // core_memory_append
  // -------------------------------------------------------------------------

  describe("core_memory_append", () => {
    it("dispatches to CoreMemoryService and returns result", () => {
      const tool = toolByName(tools, "core_memory_append");
      const result = tool.handler({ label: "character", content: "I love cats." }, ctx) as {
        success: boolean;
        chars_current?: number;
      };

      expect(result.success).toBe(true);
      expect(result.chars_current).toBe(12);

      // Verify it actually persisted
      const block = coreMemory.getBlock(ctx.viewer_agent_id, "character");
      expect(block.value).toBe("I love cats.");
    });

    it("returns error when label is 'index'", () => {
      const tool = toolByName(tools, "core_memory_append");
      const result = tool.handler({ label: "index", content: "sneaky write" }, ctx) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain("index");
      expect(result.error).toContain("forbidden");
    });

    it("returns failure when append exceeds char limit", () => {
      const tool = toolByName(tools, "core_memory_append");
      const hugeContent = "x".repeat(5000);
      const result = tool.handler({ label: "character", content: hugeContent }, ctx) as {
        success: boolean;
      };

      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // core_memory_replace
  // -------------------------------------------------------------------------

  describe("core_memory_replace", () => {
    it("dispatches to CoreMemoryService and returns result", () => {
      // Seed some content first
      coreMemory.appendBlock(ctx.viewer_agent_id, "user", "Bob is 30 years old.");

      const tool = toolByName(tools, "core_memory_replace");
      const result = tool.handler(
        { label: "user", old_content: "30 years old", new_content: "31 years old" },
        ctx,
      ) as { success: boolean; chars_current?: number };

      expect(result.success).toBe(true);

      const block = coreMemory.getBlock(ctx.viewer_agent_id, "user");
      expect(block.value).toBe("Bob is 31 years old.");
    });

    it("returns error when label is 'index'", () => {
      const tool = toolByName(tools, "core_memory_replace");
      const result = tool.handler(
        { label: "index", old_content: "old", new_content: "new" },
        ctx,
      ) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain("index");
      expect(result.error).toContain("forbidden");
    });

    it("returns failure when old_content not found", () => {
      const tool = toolByName(tools, "core_memory_replace");
      const result = tool.handler(
        { label: "character", old_content: "nonexistent", new_content: "new" },
        ctx,
      ) as { success: boolean; reason?: string };

      expect(result.success).toBe(false);
      expect(result.reason).toBe("old_content not found in block");
    });
  });

  // -------------------------------------------------------------------------
  // memory_read
  // -------------------------------------------------------------------------

  describe("memory_read", () => {
    it("dispatches entity read to RetrievalService.readByEntity", () => {
      const tool = toolByName(tools, "memory_read");
      const result = tool.handler({ entity: "Alice" }, ctx) as {
        entity: unknown;
        facts: unknown[];
      };

      // No entity exists, so entity should be null
      expect(result.entity).toBeNull();
      expect(result.facts).toEqual([]);
    });

    it("dispatches topic read to RetrievalService.readByTopic", () => {
      const tool = toolByName(tools, "memory_read");
      const result = tool.handler({ topic: "weather" }, ctx) as {
        topic: unknown;
        events: unknown[];
      };

      expect(result.topic).toBeNull();
      expect(result.events).toEqual([]);
    });

    it("dispatches event_ids read to RetrievalService.readByEventIds", () => {
      const tool = toolByName(tools, "memory_read");
      const result = tool.handler({ event_ids: [1, 2, 3] }, ctx) as unknown[];

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    it("dispatches fact_ids read to RetrievalService.readByFactIds", () => {
      const tool = toolByName(tools, "memory_read");
      const result = tool.handler({ fact_ids: [10, 20] }, ctx) as unknown[];

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    it("returns error when no argument provided", () => {
      const tool = toolByName(tools, "memory_read");
      const result = tool.handler({}, ctx) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain("Provide one of");
    });
  });

  // -------------------------------------------------------------------------
  // memory_search
  // -------------------------------------------------------------------------

  describe("memory_search", () => {
    it("dispatches to RetrievalService.searchVisibleNarrative", async () => {
      const tool = toolByName(tools, "memory_search");
      const result = (await tool.handler({ query: "coffee" }, ctx)) as {
        results: unknown[];
      };

      expect(result.results).toBeDefined();
      expect(Array.isArray(result.results)).toBe(true);
    });

    it("returns empty results for short queries", async () => {
      const tool = toolByName(tools, "memory_search");
      const result = (await tool.handler({ query: "ab" }, ctx)) as {
        results: unknown[];
      };

      expect(result.results).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // narrative_search
  // -------------------------------------------------------------------------

  describe("narrative_search", () => {
    it("dispatches to RetrievalService.searchVisibleNarrative (fallback path)", async () => {
      const tool = toolByName(tools, "narrative_search");
      const result = (await tool.handler({ query: "coffee" }, ctx)) as {
        results: unknown[];
      };

      expect(result.results).toBeDefined();
      expect(Array.isArray(result.results)).toBe(true);
    });

    it("dispatches to narrativeSearch service when available", async () => {
      let capturedQuery = "";
      const mockNarrativeSearch = {
        async searchNarrative(query: string, _ctx: ViewerContext) {
          capturedQuery = query;
          return [{ source_ref: "e:1", content: "mock result" }];
        },
      };

      const toolsWithNarrative = buildMemoryTools({ ...services, narrativeSearch: mockNarrativeSearch });
      const tool = toolByName(toolsWithNarrative, "narrative_search");
      const result = (await tool.handler({ query: "test query" }, ctx)) as {
        results: unknown[];
      };

      expect(capturedQuery).toBe("test query");
      expect(result.results).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // cognition_search
  // -------------------------------------------------------------------------

  describe("cognition_search", () => {
    it("returns error when cognitionSearch service is not available", () => {
      const tool = toolByName(tools, "cognition_search");
      const result = tool.handler({ query: "trust" }, ctx) as {
        success: boolean;
        error: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain("CognitionSearch not available");
    });

    it("dispatches to cognitionSearch service when available", () => {
      let capturedParams: Record<string, unknown> = {};
      const mockCognitionSearch = {
        searchCognition(params: Record<string, unknown>) {
          capturedParams = params;
          return [{ kind: "assertion", content: "mock cognition" }];
        },
      };

      const toolsWithCognition = buildMemoryTools({ ...services, cognitionSearch: mockCognitionSearch });
      const tool = toolByName(toolsWithCognition, "cognition_search");
      const result = tool.handler(
        { query: "trust", kind: "assertion", active_only: true },
        ctx,
      ) as unknown[];

      expect(capturedParams.agentId).toBe("agent-1");
      expect(capturedParams.query).toBe("trust");
      expect(capturedParams.kind).toBe("assertion");
      expect(capturedParams.activeOnly).toBe(true);
      expect(result).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // memory_search alias behavior
  // -------------------------------------------------------------------------

  describe("memory_search alias", () => {
    it("produces identical output to narrative_search for same query", async () => {
      const narrativeTool = toolByName(tools, "narrative_search");
      const aliasTool = toolByName(tools, "memory_search");

      const narrativeResult = await narrativeTool.handler({ query: "coffee" }, ctx);
      const aliasResult = await aliasTool.handler({ query: "coffee" }, ctx);

      expect(aliasResult).toEqual(narrativeResult);
    });

    it("delegates to narrativeSearch service when available (same as narrative_search)", async () => {
      let callCount = 0;
      const mockNarrativeSearch = {
        async searchNarrative(_query: string, _ctx: ViewerContext) {
          callCount++;
          return [{ source_ref: "e:1", content: "mock" }];
        },
      };

      const toolsWithNarrative = buildMemoryTools({ ...services, narrativeSearch: mockNarrativeSearch });
      const aliasTool = toolByName(toolsWithNarrative, "memory_search");
      await aliasTool.handler({ query: "test" }, ctx);

      expect(callCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // memory_explore
  // -------------------------------------------------------------------------

  describe("memory_explore", () => {
    it("dispatches to navigator.explore when navigator is available", async () => {
      const mockNavigator = {
        explore(query: string, _ctx: ViewerContext) {
          return { query, query_type: "why" as const, summary: "Explain why: 0 path(s)", evidence_paths: [] };
        },
      };

      const toolsWithNav = buildMemoryTools({ ...services, navigator: mockNavigator });
      const tool = toolByName(toolsWithNav, "memory_explore");
      const result = await tool.handler({ query: "why did Alice leave" }, ctx) as {
        query: string;
        query_type: string;
        summary: string;
        evidence_paths: unknown[];
      };

      expect(result.query).toBe("why did Alice leave");
      expect(result.query_type).toBe("why");
      expect(result.summary).toBe("Explain why: 0 path(s)");
      expect(result.evidence_paths).toEqual([]);
    });

    it("returns error when navigator is not available", async () => {
      const tool = toolByName(tools, "memory_explore");
      const result = await tool.handler({ query: "why did Alice leave" }, ctx) as {
        success: boolean;
        error: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain("GraphNavigator not available");
    });

    it("dispatches correctly when services include narrative and cognition search", async () => {
      const mockNavigator = {
        explore(query: string, _ctx: ViewerContext) {
          return {
            query,
            query_type: "event" as const,
            summary: "Explain event: 1 path(s)",
            evidence_paths: [{
              path: { seed: "event:1", nodes: ["event:1"], edges: [], depth: 0 },
              score: {
                seed_score: 0.8,
                edge_type_score: 0.8,
                temporal_consistency: 1,
                query_intent_match: 1,
                support_score: 0,
                recency_score: 0.5,
                hop_penalty: 0,
                redundancy_penalty: 0,
                path_score: 0.8,
              },
              supporting_nodes: [],
              supporting_facts: [],
            }],
          } as any;
        },
      };
      const mockNarrative = { async searchNarrative() { return []; } };
      const mockCognition = { searchCognition() { return []; } };

      const fullServices: MemoryToolServices = {
        ...services,
        navigator: mockNavigator,
        narrativeSearch: mockNarrative,
        cognitionSearch: mockCognition,
      };
      const fullTools = buildMemoryTools(fullServices);
      const tool = toolByName(fullTools, "memory_explore");
      const result = await tool.handler({ query: "what happened" }, ctx) as {
        query: string;
        query_type: string;
        summary: string;
        evidence_paths: unknown[];
      };

      expect(result.query).toBe("what happened");
      expect(result.query_type).toBe("event");
      expect(result.summary).toBe("Explain event: 1 path(s)");
      expect(result.evidence_paths).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // registerMemoryTools
  // -------------------------------------------------------------------------

  describe("registerMemoryTools", () => {
    it("successfully registers all 7 tools", () => {
      const registered: MemoryToolDefinition[] = [];
      const executor: ToolExecutorLike = {
        registerLocal(tool: MemoryToolDefinition) {
          registered.push(tool);
        },
      };

      registerMemoryTools(executor, services);

      expect(registered).toHaveLength(7);
      const names = registered.map((t) => t.name);
      expect(names).toContain("core_memory_append");
      expect(names).toContain("core_memory_replace");
      expect(names).toContain("memory_read");
      expect(names).toContain("narrative_search");
      expect(names).toContain("cognition_search");
      expect(names).toContain("memory_search");
      expect(names).toContain("memory_explore");
    });
  });

  // -------------------------------------------------------------------------
  // Viewer Context injection
  // -------------------------------------------------------------------------

  describe("viewer context injection", () => {
    it("core_memory_append uses viewer_agent_id from context", () => {
      const otherCtx = makeViewerContext({ viewer_agent_id: "agent-2" });
      coreMemory.initializeBlocks("agent-2");

      const tool = toolByName(tools, "core_memory_append");
      tool.handler({ label: "character", content: "I am agent-2" }, otherCtx);

      // agent-2 block should have content
      const block2 = coreMemory.getBlock("agent-2", "character");
      expect(block2.value).toBe("I am agent-2");

      // agent-1 block should still be empty
      const block1 = coreMemory.getBlock("agent-1", "character");
      expect(block1.value).toBe("");
    });
  });
});
