import { describe, it, expect } from "bun:test";
import { MemoryAdapter } from "../../src/core/prompt-data-adapters/memory-adapter.js";
import type { PromptDataRepos } from "../../src/memory/prompt-data.js";
import type { RetrievalService } from "../../src/memory/retrieval.js";
import type { ViewerContext } from "../../src/core/contracts/viewer-context.js";

describe("MemoryAdapter", () => {
  const stubRepos: PromptDataRepos = {
    coreMemoryBlockRepo: {
      getAllBlocks: async () => [],
    } as unknown as PromptDataRepos["coreMemoryBlockRepo"],
    recentCognitionSlotRepo: {
      getSlotPayload: async () => undefined,
    } as unknown as PromptDataRepos["recentCognitionSlotRepo"],
    interactionRepo: {
      getMessageRecords: async () => [],
    } as unknown as PromptDataRepos["interactionRepo"],
    sharedBlockRepo: {
      getAttachedBlockIds: async () => [],
    } as unknown as PromptDataRepos["sharedBlockRepo"],
  };

  const stubRetrievalService: RetrievalService = {
    generateTypedRetrieval: async () => ({
      narrative: [],
      cognition: [],
      conflict_notes: [],
      episode: [],
    }),
  } as unknown as RetrievalService;

  const stubViewerContext: ViewerContext = {
    viewer_agent_id: "test-agent",
    viewer_role: "rp_agent",
    session_id: "test-session",
  };

  it("should instantiate with repos only (retrievalService optional)", () => {
    const adapter = new MemoryAdapter(stubRepos);
    expect(adapter).toBeDefined();
  });

  it("should instantiate with both repos and retrievalService", () => {
    const adapter = new MemoryAdapter(stubRepos, stubRetrievalService);
    expect(adapter).toBeDefined();
  });

  it("should have getPinnedBlocks method", async () => {
    const adapter = new MemoryAdapter(stubRepos);
    expect(typeof adapter.getPinnedBlocks).toBe("function");

    const result = await adapter.getPinnedBlocks("test-agent");
    expect(typeof result).toBe("string");
  });

  it("should have getSharedBlocks method", async () => {
    const adapter = new MemoryAdapter(stubRepos);
    expect(typeof adapter.getSharedBlocks).toBe("function");

    const result = await adapter.getSharedBlocks("test-agent");
    expect(typeof result).toBe("string");
  });

  it("should have getRecentCognition method", async () => {
    const adapter = new MemoryAdapter(stubRepos);
    expect(typeof adapter.getRecentCognition).toBe("function");

    const result = await adapter.getRecentCognition(stubViewerContext);
    expect(typeof result).toBe("string");
  });

  it("should have getAttachedSharedBlocks method", async () => {
    const adapter = new MemoryAdapter(stubRepos);
    expect(typeof adapter.getAttachedSharedBlocks).toBe("function");

    const result = await adapter.getAttachedSharedBlocks("test-agent");
    expect(typeof result).toBe("string");
  });

  it("should have getTypedRetrievalSurface method", async () => {
    const adapter = new MemoryAdapter(stubRepos, stubRetrievalService);
    expect(typeof adapter.getTypedRetrievalSurface).toBe("function");

    const result = await adapter.getTypedRetrievalSurface("test message", stubViewerContext);
    expect(typeof result).toBe("string");
  });
});
