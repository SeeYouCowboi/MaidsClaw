import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemorySchema } from "./schema.js";
import { CoreMemoryService } from "./core-memory.js";

function freshDb() {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

describe("CoreMemoryService", () => {
  let db: Database;
  let svc: CoreMemoryService;

  beforeEach(() => {
    db = freshDb();
    svc = new CoreMemoryService(db);
  });

  describe("initializeBlocks", () => {
    it("creates 3 blocks with correct limits", () => {
      svc.initializeBlocks("agent-1");
      const blocks = svc.getAllBlocks("agent-1");
      expect(blocks).toHaveLength(3);

      const character = blocks.find((b) => b.label === "character")!;
      const user = blocks.find((b) => b.label === "user")!;
      const index = blocks.find((b) => b.label === "index")!;

      expect(character.char_limit).toBe(4000);
      expect(character.read_only).toBe(0);
      expect(character.description).toBe("Agent persona and identity");
      expect(character.value).toBe("");

      expect(user.char_limit).toBe(3000);
      expect(user.read_only).toBe(0);
      expect(user.description).toBe("Information about the user");

      expect(index.char_limit).toBe(1500);
      expect(index.read_only).toBe(1);
      expect(index.description).toBe("Memory index with pointer addresses");
    });

    it("is idempotent — calling twice does not error or duplicate", () => {
      svc.initializeBlocks("agent-1");
      svc.initializeBlocks("agent-1");
      const blocks = svc.getAllBlocks("agent-1");
      expect(blocks).toHaveLength(3);
    });
  });

  describe("getBlock", () => {
    it("returns block with chars_current=0 initially and correct chars_limit", () => {
      svc.initializeBlocks("agent-1");
      const block = svc.getBlock("agent-1", "character");
      expect(block.chars_current).toBe(0);
      expect(block.chars_limit).toBe(4000);
      expect(block.value).toBe("");
      expect(block.agent_id).toBe("agent-1");
      expect(block.label).toBe("character");
    });

    it("throws if block not initialized", () => {
      expect(() => svc.getBlock("agent-1", "character")).toThrow(
        "Block not found: agent-1/character",
      );
    });
  });

  describe("appendBlock", () => {
    beforeEach(() => {
      svc.initializeBlocks("agent-1");
    });

    it("appends content and returns success with updated chars", () => {
      const result = svc.appendBlock("agent-1", "character", "I am Alice");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.chars_current).toBe(10);
        expect(result.chars_limit).toBe(4000);
      }

      const block = svc.getBlock("agent-1", "character");
      expect(block.value).toBe("I am Alice");
    });

    it("appends multiple times correctly", () => {
      svc.appendBlock("agent-1", "character", "Hello ");
      const result = svc.appendBlock("agent-1", "character", "World");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.chars_current).toBe(11);
      }

      const block = svc.getBlock("agent-1", "character");
      expect(block.value).toBe("Hello World");
    });

    it("returns failure with remaining when over char limit", () => {
      // user block has 3000 char limit
      const bigContent = "x".repeat(2900);
      svc.appendBlock("agent-1", "user", bigContent);

      const result = svc.appendBlock("agent-1", "user", "y".repeat(200));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.remaining).toBe(100);
        expect(result.limit).toBe(3000);
        expect(result.current).toBe(2900);
      }
    });

    it("allows append exactly at char limit", () => {
      const content = "x".repeat(3000);
      const result = svc.appendBlock("agent-1", "user", content);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.chars_current).toBe(3000);
      }
    });

    it("rejects index block writes when callerRole is undefined", () => {
      const result = svc.appendBlock("agent-1", "index", "some data");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.remaining).toBe(0);
        expect(result.limit).toBe(1500);
        expect(result.current).toBe(0);
      }
    });

    it("rejects index block writes when callerRole is rp-agent", () => {
      const result = svc.appendBlock("agent-1", "index", "some data", "rp-agent");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.remaining).toBe(0);
      }
    });

    it("allows index block writes when callerRole is task-agent", () => {
      const result = svc.appendBlock("agent-1", "index", "pointer:123", "task-agent");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.chars_current).toBe(11);
        expect(result.chars_limit).toBe(1500);
      }

      const block = svc.getBlock("agent-1", "index");
      expect(block.value).toBe("pointer:123");
    });
  });

  describe("replaceBlock", () => {
    beforeEach(() => {
      svc.initializeBlocks("agent-1");
      svc.appendBlock("agent-1", "user", "The user likes cats and cats are great");
    });

    it("replaces old text with new text correctly", () => {
      const result = svc.replaceBlock("agent-1", "user", "cats", "dogs");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.chars_current).toBe(38);
      }

      const block = svc.getBlock("agent-1", "user");
      // Only first occurrence replaced
      expect(block.value).toBe("The user likes dogs and cats are great");
    });

    it("returns failure when old text not found in block", () => {
      const result = svc.replaceBlock("agent-1", "user", "nonexistent text", "replacement");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("old_content not found in block");
      }
    });

    it("returns failure when replacement would exceed char_limit", () => {
      // Fill user block near limit
      const big = "x".repeat(2990);
      svc.replaceBlock("agent-1", "user", "The user likes cats and cats are great", big);

      // Try to replace with something that exceeds the limit
      const result = svc.replaceBlock("agent-1", "user", "x", "y".repeat(100));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("replacement would exceed char_limit");
      }
    });

    it("rejects index block writes from rp-agent", () => {
      svc.appendBlock("agent-1", "index", "old data", "task-agent");
      const result = svc.replaceBlock("agent-1", "index", "old", "new", "rp-agent");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("index block is read-only for RP Agent");
      }
    });

    it("rejects index block writes when callerRole undefined", () => {
      svc.appendBlock("agent-1", "index", "old data", "task-agent");
      const result = svc.replaceBlock("agent-1", "index", "old", "new");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("index block is read-only for RP Agent");
      }
    });

    it("allows index block writes from task-agent", () => {
      svc.appendBlock("agent-1", "index", "old data", "task-agent");
      const result = svc.replaceBlock("agent-1", "index", "old", "new", "task-agent");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.chars_current).toBe(8);
      }

      const block = svc.getBlock("agent-1", "index");
      expect(block.value).toBe("new data");
    });

    it("replaces only the first occurrence", () => {
      const result = svc.replaceBlock("agent-1", "user", "cats", "birds");
      expect(result.success).toBe(true);

      const block = svc.getBlock("agent-1", "user");
      expect(block.value).toBe("The user likes birds and cats are great");
    });
  });

  describe("getAllBlocks", () => {
    it("returns all 3 blocks with chars_current", () => {
      svc.initializeBlocks("agent-1");
      svc.appendBlock("agent-1", "character", "Alice the maid");

      const blocks = svc.getAllBlocks("agent-1");
      expect(blocks).toHaveLength(3);

      const character = blocks.find((b) => b.label === "character")!;
      expect(character.chars_current).toBe(14);
      expect(character.value).toBe("Alice the maid");

      const user = blocks.find((b) => b.label === "user")!;
      expect(user.chars_current).toBe(0);

      const index = blocks.find((b) => b.label === "index")!;
      expect(index.chars_current).toBe(0);
    });

    it("returns empty array for uninitialized agent", () => {
      const blocks = svc.getAllBlocks("unknown-agent");
      expect(blocks).toHaveLength(0);
    });
  });
});
