import { describe, it, expect } from "bun:test";
import type { MemoryTaskModelProvider } from "../../../src/memory/task-agent.js";
import type { CachedToolCallLog, FlushCallEntry } from "./scripted-provider.js";
import {
  createScriptedProviderFromCache,
  createLiveCapturingProvider,
} from "./scripted-provider.js";

function makeFlushCall(
  phase: "call_one" | "call_two",
  toolName: string,
  args: Record<string, unknown> = {},
): FlushCallEntry {
  return { callPhase: phase, toolCalls: [{ name: toolName, arguments: args }] };
}

function makeCache(
  beats: { beatId: string; flushCalls: FlushCallEntry[] }[],
): CachedToolCallLog {
  return {
    storyId: "test-story",
    capturedAt: Date.now(),
    beats,
  };
}

describe("ScriptedProvider", () => {
  it("replays cached tool calls in correct order", async () => {
    const cache = makeCache([
      {
        beatId: "b1",
        flushCalls: [
          makeFlushCall("call_one", "create_entity", { display_name: "Alice" }),
          makeFlushCall("call_one", "create_episode_event", { role: "narrator" }),
          makeFlushCall("call_two", "update_index_block", { new_text: "idx" }),
        ],
      },
    ]);

    const scripted = createScriptedProviderFromCache(cache);
    const provider = scripted.getProviderForBeat("b1");

    const r1 = await provider.chat([], []);
    expect(r1).toEqual([{ name: "create_entity", arguments: { display_name: "Alice" } }]);

    const r2 = await provider.chat([], []);
    expect(r2).toEqual([{ name: "create_episode_event", arguments: { role: "narrator" } }]);

    const r3 = await provider.chat([], []);
    expect(r3).toEqual([{ name: "update_index_block", arguments: { new_text: "idx" } }]);
  });

  it("throws on exhausted invocations", async () => {
    const cache = makeCache([
      {
        beatId: "b1",
        flushCalls: [
          makeFlushCall("call_one", "create_entity", { display_name: "Bob" }),
          makeFlushCall("call_two", "update_index_block", { new_text: "x" }),
        ],
      },
    ]);

    const provider = createScriptedProviderFromCache(cache).getProviderForBeat("b1");
    await provider.chat([], []);
    await provider.chat([], []);

    expect(provider.chat([], [])).rejects.toThrow("exhausted");
  });

  it("capturing provider intercepts and records responses", async () => {
    const fakeProvider: MemoryTaskModelProvider = {
      defaultEmbeddingModelId: "fake-embed",
      async chat() {
        return [{ name: "create_entity", arguments: { display_name: "Test" } }];
      },
      async embed(texts) {
        return texts.map(() => new Float32Array([0.1, 0.2]));
      },
    };

    const { provider, startBeat, endBeat } = createLiveCapturingProvider(fakeProvider);

    startBeat("b1");
    const r1 = await provider.chat([], []);
    const r2 = await provider.chat([], []);
    const beatLog = endBeat();

    expect(r1).toEqual([{ name: "create_entity", arguments: { display_name: "Test" } }]);
    expect(r2).toEqual(r1);
    expect(beatLog.beatId).toBe("b1");
    expect(beatLog.flushCalls).toHaveLength(2);
    expect(beatLog.flushCalls[0]!.callPhase).toBe("call_one");
    expect(beatLog.flushCalls[0]!.toolCalls).toEqual([
      { name: "create_entity", arguments: { display_name: "Test" } },
    ]);
  });

  it("roundtrip: capture → serialize → deserialize → replay", async () => {
    let callCount = 0;
    const fakeProvider: MemoryTaskModelProvider = {
      defaultEmbeddingModelId: "fake-embed",
      async chat() {
        callCount++;
        return [{ name: `tool_${callCount}`, arguments: { seq: callCount } }];
      },
      async embed(texts) {
        return texts.map(() => new Float32Array([0.5]));
      },
    };

    const { provider, startBeat, endBeat, getFullLog } =
      createLiveCapturingProvider(fakeProvider);

    startBeat("beat-a");
    await provider.chat([], []);
    await provider.chat([], []);
    endBeat();

    startBeat("beat-b");
    await provider.chat([], []);
    endBeat();

    const serialized = JSON.stringify(getFullLog());
    const deserialized: CachedToolCallLog = JSON.parse(serialized);

    const scripted = createScriptedProviderFromCache(deserialized);

    const pA = scripted.getProviderForBeat("beat-a");
    const ra1 = await pA.chat([], []);
    expect(ra1).toEqual([{ name: "tool_1", arguments: { seq: 1 } }]);
    const ra2 = await pA.chat([], []);
    expect(ra2).toEqual([{ name: "tool_2", arguments: { seq: 2 } }]);

    const pB = scripted.getProviderForBeat("beat-b");
    const rb1 = await pB.chat([], []);
    expect(rb1).toEqual([{ name: "tool_3", arguments: { seq: 3 } }]);
  });

  it("embed throws on scripted provider", async () => {
    const cache = makeCache([
      { beatId: "b1", flushCalls: [makeFlushCall("call_one", "create_entity")] },
    ]);

    const provider = createScriptedProviderFromCache(cache).getProviderForBeat("b1");
    expect(provider.embed(["test"], "memory_index", "model")).rejects.toThrow(
      "must not be called",
    );
  });

  it("getBeatLog returns undefined for missing beat", () => {
    const cache = makeCache([
      { beatId: "b1", flushCalls: [] },
    ]);

    const scripted = createScriptedProviderFromCache(cache);
    expect(scripted.getBeatLog("b1")).toBeDefined();
    expect(scripted.getBeatLog("nonexistent")).toBeUndefined();
  });
});
