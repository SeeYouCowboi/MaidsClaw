import type { LoreService } from "../../lore/service.js";
import type { LoreDataSource } from "../prompt-data-sources.js";

export class LoreAdapter implements LoreDataSource {
  constructor(private readonly loreService: LoreService) {}

  getMatchingEntries(
    text: string,
    options?: { limit?: number },
  ): Array<{ content: string; title?: string; priority?: number }> {
    const entries = this.loreService.getMatchingEntries(text, {
      limit: options?.limit,
    });

    return entries.map((entry) => ({
      content: entry.content,
      title: entry.title,
      priority: entry.priority,
    }));
  }

  getWorldRules(): Array<{ content: string; title?: string }> {
    const allEntries = this.loreService.getAllEntries();

    return allEntries
      .filter((entry) => entry.scope === "world" && entry.enabled)
      .map((entry) => ({
        content: entry.content,
        title: entry.title,
      }));
  }
}
