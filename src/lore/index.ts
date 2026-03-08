export type { LoreEntry, LoreScope } from "./entry-schema.js";
export { validateLoreEntry } from "./entry-schema.js";

export type { LoreLoadResult } from "./loader.js";
export { loadLoreEntries } from "./loader.js";

export type { MatchOptions } from "./matcher.js";
export { findMatchingEntries } from "./matcher.js";

export type { LoreService, LoreServiceOptions } from "./service.js";
export { createLoreService } from "./service.js";
