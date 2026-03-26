export const MEMORY_TOOL_NAMES = {
  coreMemoryAppend: "core_memory_append",
  coreMemoryReplace: "core_memory_replace",
  memoryRead: "memory_read",
  narrativeSearch: "narrative_search",
  cognitionSearch: "cognition_search",
  memoryExplore: "memory_explore",
} as const;

export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[keyof typeof MEMORY_TOOL_NAMES];

export const ALL_MEMORY_TOOL_NAMES = [
  MEMORY_TOOL_NAMES.coreMemoryAppend,
  MEMORY_TOOL_NAMES.coreMemoryReplace,
  MEMORY_TOOL_NAMES.memoryRead,
  MEMORY_TOOL_NAMES.narrativeSearch,
  MEMORY_TOOL_NAMES.cognitionSearch,
  MEMORY_TOOL_NAMES.memoryExplore,
] as const satisfies readonly MemoryToolName[];

export const READ_ONLY_MEMORY_TOOL_NAMES = [
  MEMORY_TOOL_NAMES.memoryRead,
  MEMORY_TOOL_NAMES.narrativeSearch,
  MEMORY_TOOL_NAMES.cognitionSearch,
  MEMORY_TOOL_NAMES.memoryExplore,
] as const satisfies readonly MemoryToolName[];

export const ALL_MEMORY_TOOL_NAME_SET: ReadonlySet<string> = new Set(ALL_MEMORY_TOOL_NAMES);
export const READ_ONLY_MEMORY_TOOL_NAME_SET: ReadonlySet<string> = new Set(READ_ONLY_MEMORY_TOOL_NAMES);
