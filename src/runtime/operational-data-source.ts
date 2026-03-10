import type { Blackboard } from "../state/blackboard.js";
import type { OperationalDataSource } from "../core/prompt-data-sources.js";

export class BlackboardOperationalDataSource implements OperationalDataSource {
  constructor(private readonly blackboard: Blackboard) {}

  getExcerpt(keys: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const pattern of keys) {
      if (pattern.endsWith(".*")) {
        const prefix = pattern.slice(0, -1);
        const entries = this.blackboard.getNamespace(prefix);
        for (const [k, v] of Object.entries(entries)) {
          result[k] = v;
        }
      } else {
        const value = this.blackboard.get(pattern);
        if (value !== undefined) {
          result[pattern] = value;
        }
      }
    }

    return result;
  }
}
