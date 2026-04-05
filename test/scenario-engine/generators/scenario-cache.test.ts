import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import {
  loadCachedDialogue,
  saveCachedDialogue,
  loadCachedToolCalls,
  saveCachedToolCalls,
  loadCheckpoint,
  saveCheckpoint,
  invalidateAllCaches,
  type CachedToolCallLog,
} from "./scenario-cache.js";

const STORY_ID = "test-cache-story";
const CACHE_DIR = "test/scenario-engine/cache";

function cleanup(): void {
  for (const suffix of ["-dialogue.json", "-toolcalls.json", "-checkpoint.json"]) {
    const path = `${CACHE_DIR}/${STORY_ID}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

describe("scenario-cache", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("dialogue save → load roundtrip", () => {
    const dialogue = [
      {
        beatId: "beat-1",
        turns: [
          { role: "user" as const, content: "Hello?", timestamp: 1_000 },
          { role: "assistant" as const, content: "Good evening.", timestamp: 2_000 },
        ],
      },
      {
        beatId: "beat-2",
        turns: [
          { role: "user" as const, content: "Where is the key?", timestamp: 3_000 },
          { role: "assistant" as const, content: "I do not know, sir.", timestamp: 4_000 },
        ],
      },
    ];

    saveCachedDialogue(STORY_ID, dialogue);
    const loaded = loadCachedDialogue(STORY_ID);
    expect(loaded).toEqual(dialogue);
  });

  it("tool call save → load roundtrip", () => {
    const log: CachedToolCallLog = {
      beats: [
        {
          beatId: "beat-1",
          flushCalls: [
            {
              callPhase: "call_one",
              toolCalls: [
                { name: "create_entity", arguments: { pointer_key: "maid" } },
              ],
              messages: [{ role: "system", content: "sys" }],
            },
          ],
        },
        {
          beatId: "beat-2",
          flushCalls: [
            {
              callPhase: "call_two",
              toolCalls: [
                { name: "update_index_block", arguments: { settlementId: "s1" } },
              ],
              messages: [
                { role: "user", content: "u" },
                { role: "assistant", content: "a" },
              ],
            },
          ],
        },
      ],
    };

    saveCachedToolCalls(STORY_ID, log);
    const loaded = loadCachedToolCalls(STORY_ID);
    expect(loaded).toEqual(log);
  });

  it("missing cache returns null", () => {
    expect(loadCachedDialogue("nonexistent-story-12345")).toBeNull();
    expect(loadCachedToolCalls("nonexistent-story-12345")).toBeNull();
    expect(loadCheckpoint("nonexistent-story-12345")).toBeNull();
  });

  it("invalidateAllCaches removes all files", () => {
    const dialogue = [{ beatId: "b1", turns: [] }];
    const log: CachedToolCallLog = { beats: [] };

    saveCachedDialogue(STORY_ID, dialogue);
    saveCachedToolCalls(STORY_ID, log);

    expect(loadCachedDialogue(STORY_ID)).not.toBeNull();
    expect(loadCachedToolCalls(STORY_ID)).not.toBeNull();

    invalidateAllCaches(STORY_ID);

    expect(loadCachedDialogue(STORY_ID)).toBeNull();
    expect(loadCachedToolCalls(STORY_ID)).toBeNull();
  });

  it("checkpoint save → load roundtrip", () => {
    const checkpoint = {
      storyId: STORY_ID,
      completedBeatIds: ["beat-1", "beat-2"],
      partialToolCallLog: { beats: [] } as CachedToolCallLog,
      savedAt: 42,
    };

    saveCheckpoint(STORY_ID, checkpoint);
    const loaded = loadCheckpoint(STORY_ID);
    expect(loaded).toEqual(checkpoint);
  });
});
