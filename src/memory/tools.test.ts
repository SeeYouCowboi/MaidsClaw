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
import { ALL_MEMORY_TOOL_NAMES, MEMORY_TOOL_NAMES } from "./tool-names.js";
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
    retrieval = RetrievalService.create(db as unknown as Parameters<typeof RetrievalService.create>[0]);
    services = { coreMemory, retrieval };
    tools = buildMemoryTools(services);
    ctx = makeViewerContext();
    coreMemory.initializeBlocks(ctx.viewer_agent_id);
  });

  // -------------------------------------------------------------------------
  // Schema definitions
  // -------------------------------------------------------------------------

  describe("tool definitions", () => {
    it("defines all canonical memory tools", () => {
      expect(tools).toHaveLength(ALL_MEMORY_TOOL_NAMES.length);
    });

    it("all tools have valid JSON Schema parameter definitions", () => {
      const expectedNames = ALL_MEMORY_TOOL_NAMES;

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

    it("core_memory_append has label enum restricted to persona", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.coreMemoryAppend);
      const props = (tool.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
      expect(props.label.enum).toEqual(["persona"]);
    });

    it("core_memory_replace has label enum restricted to persona", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.coreMemoryReplace);
      const props = (tool.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
      expect(props.label.enum).toEqual(["persona"]);
    });
  });

  // -------------------------------------------------------------------------
  // core_memory_append
  // -------------------------------------------------------------------------

  describe(MEMORY_TOOL_NAMES.coreMemoryAppend, () => {
    it("dispatches to CoreMemoryService and returns result", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.coreMemoryAppend);
      const result = tool.handler({ label: "persona", content: "I love cats." }, ctx) as {
        success: boolean;
        chars_current?: number;
      };

      expect(result.success).toBe(true);
      expect(result.chars_current).toBe(12);

      const block = coreMemory.getBlock(ctx.viewer_agent_id, "persona");
      expect(block.value).toBe("I love cats.");
    });

    it("returns error when label is 'index'", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.coreMemoryAppend);
      const result = tool.handler({ label: "index", content: "sneaky write" }, ctx) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain("index");
      expect(result.error).toContain("forbidden");
    });

    it("returns failure when append exceeds char limit", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.coreMemoryAppend);
      const hugeContent = "x".repeat(5000);
      const result = tool.handler({ label: "persona", content: hugeContent }, ctx) as {
        success: boolean;
      };

      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // core_memory_replace
  // -------------------------------------------------------------------------

  describe(MEMORY_TOOL_NAMES.coreMemoryReplace, () => {
    it("dispatches to CoreMemoryService and returns result", () => {
      coreMemory.appendBlock(ctx.viewer_agent_id, "persona", "Bob is 30 years old.");

      const tool = toolByName(tools, MEMORY_TOOL_NAMES.coreMemoryReplace);
      const result = tool.handler(
        { label: "persona", old_content: "30 years old", new_content: "31 years old" },
        ctx,
      ) as { success: boolean; chars_current?: number };

      expect(result.success).toBe(true);

      const block = coreMemory.getBlock(ctx.viewer_agent_id, "persona");
      expect(block.value).toBe("Bob is 31 years old.");
    });

    it("returns error when label is 'index'", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.coreMemoryReplace);
      const result = tool.handler(
        { label: "index", old_content: "old", new_content: "new" },
        ctx,
      ) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain("index");
      expect(result.error).toContain("forbidden");
    });

    it("returns failure when old_content not found", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.coreMemoryReplace);
      const result = tool.handler(
        { label: "persona", old_content: "nonexistent", new_content: "new" },
        ctx,
      ) as { success: boolean; reason?: string };

      expect(result.success).toBe(false);
      expect(result.reason).toBe("old_content not found in block");
    });
  });

  // -------------------------------------------------------------------------
  // memory_read
  // -------------------------------------------------------------------------

  describe(MEMORY_TOOL_NAMES.memoryRead, () => {
    it("dispatches entity read to RetrievalService.readByEntity", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.memoryRead);
      const result = tool.handler({ entity: "Alice" }, ctx) as {
        entity: unknown;
        facts: unknown[];
      };

      // No entity exists, so entity should be null
      expect(result.entity).toBeNull();
      expect(result.facts).toEqual([]);
    });

    it("dispatches topic read to RetrievalService.readByTopic", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.memoryRead);
      const result = tool.handler({ topic: "weather" }, ctx) as {
        topic: unknown;
        events: unknown[];
      };

      expect(result.topic).toBeNull();
      expect(result.events).toEqual([]);
    });

    it("dispatches event_ids read to RetrievalService.readByEventIds", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.memoryRead);
      const result = tool.handler({ event_ids: [1, 2, 3] }, ctx) as unknown[];

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    it("dispatches fact_ids read to RetrievalService.readByFactIds", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.memoryRead);
      const result = tool.handler({ fact_ids: [10, 20] }, ctx) as unknown[];

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    it("returns error when no argument provided", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.memoryRead);
      const result = tool.handler({}, ctx) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain("Provide one of");
    });
  });

  // -------------------------------------------------------------------------
  // narrative_search
  // -------------------------------------------------------------------------

  describe(MEMORY_TOOL_NAMES.narrativeSearch, () => {
    it("dispatches to RetrievalService.searchVisibleNarrative (fallback path)", async () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.narrativeSearch);
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
      const tool = toolByName(toolsWithNarrative, MEMORY_TOOL_NAMES.narrativeSearch);
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

  describe(MEMORY_TOOL_NAMES.cognitionSearch, () => {
    it("returns error when cognitionSearch service is not available", () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.cognitionSearch);
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
      const tool = toolByName(toolsWithCognition, MEMORY_TOOL_NAMES.cognitionSearch);
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
  // memory_explore
  // -------------------------------------------------------------------------

  describe(MEMORY_TOOL_NAMES.memoryExplore, () => {
    it("dispatches to navigator.explore when navigator is available", async () => {
      const mockNavigator = {
        explore(query: string, _ctx: ViewerContext) {
          return { query, query_type: "why" as const, summary: "Explain why: 0 path(s)", evidence_paths: [] };
        },
      };

      const toolsWithNav = buildMemoryTools({ ...services, navigator: mockNavigator });
      const tool = toolByName(toolsWithNav, MEMORY_TOOL_NAMES.memoryExplore);
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

    it("passes asOfTime + timeDimension=valid_time as asOfValidTime to navigator", async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const mockNavigator = {
        explore(query: string, _ctx: ViewerContext, input?: Record<string, unknown>) {
          capturedInput = input;
          return { query, query_type: "why" as const, evidence_paths: [] };
        },
      };

      const toolsWithNav = buildMemoryTools({ ...services, navigator: mockNavigator });
      const tool = toolByName(toolsWithNav, MEMORY_TOOL_NAMES.memoryExplore);
      await tool.handler({ query: "test", asOfTime: 500, timeDimension: "valid_time" }, ctx);

      expect(capturedInput?.asOfValidTime).toBe(500);
      expect(capturedInput?.asOfCommittedTime).toBeUndefined();
    });

    it("passes asOfTime + timeDimension=committed_time as asOfCommittedTime to navigator", async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const mockNavigator = {
        explore(query: string, _ctx: ViewerContext, input?: Record<string, unknown>) {
          capturedInput = input;
          return { query, query_type: "why" as const, evidence_paths: [] };
        },
      };

      const toolsWithNav = buildMemoryTools({ ...services, navigator: mockNavigator });
      const tool = toolByName(toolsWithNav, MEMORY_TOOL_NAMES.memoryExplore);
      await tool.handler({ query: "test", asOfTime: 700, timeDimension: "committed_time" }, ctx);

      expect(capturedInput?.asOfCommittedTime).toBe(700);
      expect(capturedInput?.asOfValidTime).toBeUndefined();
    });

    it("explicit asOfValidTime/asOfCommittedTime still works (backward compat)", async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const mockNavigator = {
        explore(query: string, _ctx: ViewerContext, input?: Record<string, unknown>) {
          capturedInput = input;
          return { query, query_type: "why" as const, evidence_paths: [] };
        },
      };

      const toolsWithNav = buildMemoryTools({ ...services, navigator: mockNavigator });
      const tool = toolByName(toolsWithNav, MEMORY_TOOL_NAMES.memoryExplore);
      await tool.handler({ query: "test", asOfValidTime: 300, asOfCommittedTime: 400 }, ctx);

      expect(capturedInput?.asOfValidTime).toBe(300);
      expect(capturedInput?.asOfCommittedTime).toBe(400);
    });

    it("explicit asOfValidTime takes precedence over asOfTime+timeDimension=valid_time", async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const mockNavigator = {
        explore(query: string, _ctx: ViewerContext, input?: Record<string, unknown>) {
          capturedInput = input;
          return { query, query_type: "why" as const, evidence_paths: [] };
        },
      };

      const toolsWithNav = buildMemoryTools({ ...services, navigator: mockNavigator });
      const tool = toolByName(toolsWithNav, MEMORY_TOOL_NAMES.memoryExplore);
      await tool.handler({ query: "test", asOfValidTime: 300, asOfTime: 500, timeDimension: "valid_time" }, ctx);

      expect(capturedInput?.asOfValidTime).toBe(300);
    });

    it("returns error when navigator is not available", async () => {
      const tool = toolByName(tools, MEMORY_TOOL_NAMES.memoryExplore);
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
      const tool = toolByName(fullTools, MEMORY_TOOL_NAMES.memoryExplore);
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
    it("successfully registers all 6 tools", () => {
      const registered: MemoryToolDefinition[] = [];
      const executor: ToolExecutorLike = {
        registerLocal(tool: MemoryToolDefinition) {
          registered.push(tool);
        },
      };

      registerMemoryTools(executor, services);

      expect(registered).toHaveLength(ALL_MEMORY_TOOL_NAMES.length);
      const names = registered.map((t) => t.name);
      expect(names).toContain(MEMORY_TOOL_NAMES.coreMemoryAppend);
      expect(names).toContain(MEMORY_TOOL_NAMES.coreMemoryReplace);
      expect(names).toContain(MEMORY_TOOL_NAMES.memoryRead);
      expect(names).toContain(MEMORY_TOOL_NAMES.narrativeSearch);
      expect(names).toContain(MEMORY_TOOL_NAMES.cognitionSearch);
      expect(names).toContain(MEMORY_TOOL_NAMES.memoryExplore);
    });
  });

  // -------------------------------------------------------------------------
  // Viewer Context injection
  // -------------------------------------------------------------------------

  describe("viewer context injection", () => {
    it("core_memory_append uses viewer_agent_id from context", () => {
      const otherCtx = makeViewerContext({ viewer_agent_id: "agent-2" });
      coreMemory.initializeBlocks("agent-2");

      const tool = toolByName(tools, MEMORY_TOOL_NAMES.coreMemoryAppend);
      tool.handler({ label: "persona", content: "I am agent-2" }, otherCtx);

      const block2 = coreMemory.getBlock("agent-2", "persona");
      expect(block2.value).toBe("I am agent-2");

      const block1 = coreMemory.getBlock("agent-1", "persona");
      expect(block1.value).toBe("");
    });
  });
});
