// Task output schema validation — structured output for task agents

import type { AgentProfile } from "../profile.js";

/** JSON Schema-like shape for V1 structured output validation (simplified). */
export type TaskOutputSchema = {
  type: "object" | "string" | "number" | "boolean" | "array";
  required?: string[];
  properties?: Record<string, { type: string }>;
};

/** Discriminated result of output validation. */
export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/**
 * Validates task agent structured output against an optional schema.
 *
 * V1 rules:
 * - No schema → always ok
 * - schema.type "object" → must be non-null object, check required keys + property types
 * - schema.type "array" → Array.isArray check
 * - schema.type "string"/"number"/"boolean" → typeof check
 */
export class TaskOutputValidator {
  validate(output: unknown, schema?: TaskOutputSchema): ValidationResult {
    // No schema → pass-through
    if (!schema) {
      return { ok: true, value: output };
    }

    if (schema.type === "object") {
      return this.validateObject(output, schema);
    }

    if (schema.type === "array") {
      if (!Array.isArray(output)) {
        return { ok: false, reason: "expected array" };
      }
      return { ok: true, value: output };
    }

    // Primitive types: string, number, boolean
    if (typeof output !== schema.type) {
      return { ok: false, reason: `expected ${schema.type}` };
    }
    return { ok: true, value: output };
  }

  private validateObject(
    output: unknown,
    schema: TaskOutputSchema,
  ): ValidationResult {
    if (output === null || typeof output !== "object" || Array.isArray(output)) {
      return { ok: false, reason: "expected object" };
    }

    const obj = output as Record<string, unknown>;

    // Check required keys
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          return { ok: false, reason: `missing required key: ${key}` };
        }
      }
    }

    // Check property types
    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (!(key in obj)) {
          // Skip absent keys that are not required (already checked above)
          continue;
        }
        if (typeof obj[key] !== prop.type) {
          return { ok: false, reason: `wrong type for key: ${key}` };
        }
      }
    }

    return { ok: true, value: output };
  }
}

// ─── Detach Policy ───────────────────────────────────────────

/** Whether a task agent should wait for completion or detach from the parent stream. */
export type DetachPolicy = "wait" | "detach";

/**
 * Resolve the detach policy from an agent profile.
 * Only profiles with `detachable === true` get the "detach" policy.
 */
export function resolveDetachPolicy(profile: AgentProfile): DetachPolicy {
  return profile.detachable === true ? "detach" : "wait";
}
