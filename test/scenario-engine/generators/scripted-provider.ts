import type {
  ChatMessage,
  ChatToolDefinition,
  MemoryTaskModelProvider,
  ToolCallResult,
} from "../../../src/memory/task-agent.js";

export type FlushCallEntry = {
  callPhase: "call_one" | "call_two";
  toolCalls: ToolCallResult[];
};

export type BeatCallLog = {
  beatId: string;
  flushCalls: FlushCallEntry[];
};

export type CachedToolCallLog = {
  storyId: string;
  capturedAt: number;
  beats: BeatCallLog[];
};

export type ScriptedBeatProvider = {
  getProviderForBeat(beatId: string): MemoryTaskModelProvider;
  getBeatLog(beatId: string): BeatCallLog | undefined;
};

export function createScriptedProviderFromCache(
  cache: CachedToolCallLog,
): ScriptedBeatProvider {
  const beatMap = new Map<string, BeatCallLog>();
  for (const beat of cache.beats) {
    beatMap.set(beat.beatId, beat);
  }

  return {
    getBeatLog(beatId: string): BeatCallLog | undefined {
      return beatMap.get(beatId);
    },

    getProviderForBeat(beatId: string): MemoryTaskModelProvider {
      const beatLog = beatMap.get(beatId);
      if (!beatLog) {
        throw new Error(
          `ScriptedProvider: no cached beat log for beat '${beatId}'`,
        );
      }

      let invocationCount = 0;

      return {
        defaultEmbeddingModelId: "scripted-no-embed",

        async chat(
          _messages: ChatMessage[],
          _tools: ChatToolDefinition[],
        ): Promise<ToolCallResult[]> {
          const total = beatLog.flushCalls.length;
          if (invocationCount >= total) {
            throw new Error(
              `ScriptedProvider exhausted for beat '${beatId}': invocation ${invocationCount} but only ${total} entries cached`,
            );
          }
          const entry = beatLog.flushCalls[invocationCount]!;
          invocationCount++;
          return entry.toolCalls;
        },

        async embed(
          _texts: string[],
          _purpose: "memory_index" | "narrative_search" | "query_expansion",
          _modelId: string,
        ): Promise<Float32Array[]> {
          throw new Error(
            "ScriptedProvider.embed() must not be called — use real embedding service",
          );
        },
      };
    },
  };
}

export type LiveCapturingResult = {
  provider: MemoryTaskModelProvider;
  startBeat(beatId: string): void;
  endBeat(): BeatCallLog;
  getFullLog(): CachedToolCallLog;
};

export function createLiveCapturingProvider(
  realProvider: MemoryTaskModelProvider,
): LiveCapturingResult {
  const completedBeats: BeatCallLog[] = [];
  let currentBeatId: string | null = null;
  let currentFlushCalls: FlushCallEntry[] = [];

  const provider: MemoryTaskModelProvider = {
    defaultEmbeddingModelId: realProvider.defaultEmbeddingModelId,

    async chat(
      messages: ChatMessage[],
      tools: ChatToolDefinition[],
    ): Promise<ToolCallResult[]> {
      const result = await realProvider.chat(messages, tools);
      if (currentBeatId !== null) {
        // Infer call phase from tools: CALL_TWO has "update_index_block"
        const isCallTwo = tools.some((t) => t.name === "update_index_block");
        currentFlushCalls.push({
          callPhase: isCallTwo ? "call_two" : "call_one",
          toolCalls: result,
        });
      }
      return result;
    },

    async embed(
      texts: string[],
      purpose: "memory_index" | "narrative_search" | "query_expansion",
      modelId: string,
    ): Promise<Float32Array[]> {
      return realProvider.embed(texts, purpose, modelId);
    },
  };

  function startBeat(beatId: string): void {
    if (currentBeatId !== null) {
      throw new Error(
        `LiveCapturingProvider: beat '${currentBeatId}' still active, call endBeat() first`,
      );
    }
    currentBeatId = beatId;
    currentFlushCalls = [];
  }

  function endBeat(): BeatCallLog {
    if (currentBeatId === null) {
      throw new Error(
        "LiveCapturingProvider: no active beat to end",
      );
    }
    const log: BeatCallLog = {
      beatId: currentBeatId,
      flushCalls: [...currentFlushCalls],
    };
    completedBeats.push(log);
    currentBeatId = null;
    currentFlushCalls = [];
    return log;
  }

  function getFullLog(): CachedToolCallLog {
    return {
      storyId: "live-capture",
      capturedAt: Date.now(),
      beats: [...completedBeats],
    };
  }

  return { provider, startBeat, endBeat, getFullLog };
}
