import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { GeneratedDialogue, DialogueGenOptions } from "./dialogue-generator.js";
import { generateDialogue } from "./dialogue-generator.js";
import type { Story } from "../dsl/story-types.js";
import type { ToolCallResult, ChatMessage } from "@memory/task-agent";

const DEFAULT_CACHE_DIR = "test/scenario-engine/cache";
let activeCacheDir = DEFAULT_CACHE_DIR;

export function setCacheDir(dir: string): void {
  activeCacheDir = dir;
}

export function resetCacheDir(): void {
  activeCacheDir = DEFAULT_CACHE_DIR;
}

export type CachedToolCallLog = {
  beats: {
    beatId: string;
    flushCalls: {
      callPhase: "call_one" | "call_two";
      toolCalls: ToolCallResult[];
      messages: ChatMessage[];
    }[];
  }[];
};

export type CheckpointData = {
  storyId: string;
  completedBeatIds: string[];
  partialToolCallLog: CachedToolCallLog;
  savedAt: number;
};

function dialoguePath(storyId: string): string {
  return `${activeCacheDir}/${storyId}-dialogue.json`;
}

function toolCallsPath(storyId: string): string {
  return `${activeCacheDir}/${storyId}-toolcalls.json`;
}

function checkpointPath(storyId: string): string {
  return `${activeCacheDir}/${storyId}-checkpoint.json`;
}

export function loadCachedDialogue(storyId: string): GeneratedDialogue[] | null {
  const path = dialoguePath(storyId);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return raw.dialogue ?? null;
}

export function saveCachedDialogue(storyId: string, dialogue: GeneratedDialogue[]): void {
  const payload = {
    storyId,
    savedAt: Date.now(),
    dialogue,
  };
  writeFileSync(dialoguePath(storyId), JSON.stringify(payload, null, 2));
}

export function loadCachedToolCalls(storyId: string): CachedToolCallLog | null {
  const path = toolCallsPath(storyId);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const { storyId: _, savedAt: __, ...log } = raw;
  return (log as CachedToolCallLog) ?? null;
}

export function saveCachedToolCalls(storyId: string, log: CachedToolCallLog): void {
  const payload = {
    storyId,
    savedAt: Date.now(),
    ...log,
  };
  writeFileSync(toolCallsPath(storyId), JSON.stringify(payload, null, 2));
}

export function loadCheckpoint(storyId: string): CheckpointData | null {
  const path = checkpointPath(storyId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as CheckpointData;
}

export function saveCheckpoint(storyId: string, data: CheckpointData): void {
  writeFileSync(checkpointPath(storyId), JSON.stringify(data, null, 2));
}

export function deleteCheckpoint(storyId: string): void {
  const path = checkpointPath(storyId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function invalidateAllCaches(storyId: string): void {
  for (const path of [dialoguePath(storyId), toolCallsPath(storyId), checkpointPath(storyId)]) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

export async function generateOrLoadDialogue(
  story: Story,
  options?: DialogueGenOptions,
): Promise<GeneratedDialogue[]> {
  const cached = loadCachedDialogue(story.id);
  if (cached) return cached;

  const generated = await generateDialogue(story, options);
  saveCachedDialogue(story.id, generated);
  return generated;
}
