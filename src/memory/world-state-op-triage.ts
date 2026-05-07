import type postgres from "postgres";
import type {
  ChatMessage,
  ChatToolDefinition,
  MemoryTaskModelProvider,
} from "./task-agent.js";
import type { WorldStateOp } from "../runtime/rp-turn-contract.js";
import {
  summarizeValidationErrors,
  validateWorldStateOp,
  type WorldStateOpResolveContext,
  type WorldStateOpValidationError,
  type WorldStateOpValidationOk,
  type WorldStateOpValidationResult,
} from "./world-state-op-validator.js";

/**
 * Two-stage LLM triage for worldStateOps that fail schema validation.
 *
 * Stage 1 (triage, lightweight model): inspect the failed op + validation
 * errors + a small entity catalog and decide one of three actions:
 *   - `fix_in_place`: the op is structurally salvageable. The triage model
 *     also emits the corrected op directly so we re-validate without a
 *     second round-trip.
 *   - `regenerate`: the op's intent is unclear or content is wrong. Hand
 *     off to stage 2.
 *   - `drop`: the op references a missing entity / makes no sense /
 *     duplicates an existing fact. Stop and log.
 *
 * Stage 2 (regenerate, thinker-class model): synchronously re-call a
 * heavier model with recent conversation context + the failed op + the
 * triage reason. The model emits 0 or 1 corrected op which the caller
 * passes back through the validator.
 *
 * Both stages are cached per-process to absorb identical retries.
 */

const TRIAGE_TOOL: ChatToolDefinition = {
  name: "triage_worldstate_op",
  description:
    "Decide whether a malformed worldStateOp can be repaired in place, must be regenerated with full context, or dropped entirely.",
  inputSchema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["fix_in_place", "regenerate", "drop"],
        description:
          "fix_in_place when the op's intent is clear and you can produce a corrected version; regenerate when the conversation context is needed to redo this op; drop when the op cannot be salvaged (missing entity, semantic gibberish, duplicate).",
      },
      correctedOp: {
        type: "object",
        description:
          "REQUIRED when decision='fix_in_place'. The fully-formed worldStateOp using exact catalog pointer_keys. Match the structure of the original.",
      },
      reason: {
        type: "string",
        description:
          "One short sentence explaining the decision, suitable for logs.",
      },
    },
    required: ["decision", "reason"],
  },
};

const REGENERATE_TOOL: ChatToolDefinition = {
  name: "emit_worldstate_op",
  description:
    "Re-emit a single worldStateOp using the conversation context. Return op=null when no valid op can be salvaged.",
  inputSchema: {
    type: "object",
    properties: {
      op: {
        type: "object",
        description:
          "A worldStateOp matching the canonical schema (subject, predicate, object, factText, visibility). Use exact catalog pointer_keys.",
      },
      reason: {
        type: "string",
      },
    },
    required: ["reason"],
  },
};

const DEFAULT_TRIAGE_MODEL = "minimax/MiniMax-M2.7-highspeed";
const DEFAULT_REGENERATE_MODEL = "deepseek/deepseek-v4-flash";
const CANDIDATE_LIMIT = 15;
const RECENT_TURNS_FOR_REGEN = 8;

export type TriageDecision =
  | { kind: "fix_in_place"; correctedOp: WorldStateOp; reason: string }
  | { kind: "regenerate"; reason: string }
  | { kind: "drop"; reason: string };

type CatalogRow = {
  pointer_key: string;
  display_name: string;
  entity_type: string;
  summary: string | null;
};

async function readCatalog(
  sql: postgres.Sql,
  agentId: string,
  hint: string,
): Promise<CatalogRow[]> {
  // Trigram-ranked shortlist over both pointer_key and display_name. The
  // hint is the broken op as JSON so similarity covers any surface form
  // the model might have used.
  const rows = await sql<CatalogRow[]>`
    SELECT pointer_key, display_name, entity_type, summary
    FROM entity_nodes
    WHERE
      memory_scope = 'shared_public'
      OR (memory_scope = 'private_overlay' AND owner_agent_id = ${agentId})
    ORDER BY
      GREATEST(
        similarity(pointer_key, ${hint}),
        similarity(display_name, ${hint})
      ) DESC,
      updated_at DESC,
      id DESC
    LIMIT ${CANDIDATE_LIMIT}
  `;
  return rows;
}

function formatCatalog(rows: readonly CatalogRow[]): string {
  if (rows.length === 0) return "  (catalog empty)";
  return rows
    .map((r) => {
      const summary = r.summary ? ` — ${r.summary}` : "";
      return `  • ${r.pointer_key}  (${r.display_name}, ${r.entity_type})${summary}`;
    })
    .join("\n");
}

function buildTriagePrompt(params: {
  rawOp: unknown;
  errors: readonly WorldStateOpValidationError[];
  catalog: readonly CatalogRow[];
}): ChatMessage[] {
  const { rawOp, errors, catalog } = params;
  const lines: string[] = [];
  lines.push("Failed worldStateOp:");
  lines.push("```json");
  lines.push(JSON.stringify(rawOp, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("Validation errors:");
  lines.push(summarizeValidationErrors(errors));
  lines.push("");
  lines.push("Entity catalog (the only legal pointer_keys are these exact strings):");
  lines.push(formatCatalog(catalog));
  lines.push("");
  lines.push("Decision rules:");
  lines.push(
    "  • fix_in_place when ALL errors are pure formatting (wrong predicate enum, missing visibility, prefix dropped from a pointer_key whose canonical form IS in the catalog) and you can produce the corrected op verbatim.",
  );
  lines.push(
    "  • regenerate when the op references content (entities, predicates, facts) that need full conversation context to re-derive — e.g. the canonical entity is missing from the catalog and you cannot infer the fact without seeing the dialogue.",
  );
  lines.push(
    "  • drop when the op is incoherent, references a hallucinated entity that should not exist, or duplicates an existing fact.",
  );

  return [
    {
      role: "system",
      content:
        "You are a strict JSON repair gate for memory-graph worldStateOps. Format-only repairs are cheap and safe; everything else must be escalated to regenerate or dropped. Never invent pointer_keys outside the catalog.",
    },
    { role: "user", content: lines.join("\n") },
  ];
}

function buildRegeneratePrompt(params: {
  rawOp: unknown;
  failureReason: string;
  recentMessages: readonly ChatMessage[];
  catalog: readonly CatalogRow[];
}): ChatMessage[] {
  const { rawOp, failureReason, recentMessages, catalog } = params;
  const lines: string[] = [];
  lines.push("The talker emitted this worldStateOp but it failed validation:");
  lines.push("```json");
  lines.push(JSON.stringify(rawOp, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`Triage reason: ${failureReason}`);
  lines.push("");
  lines.push("Recent dialogue (most recent last):");
  for (const m of recentMessages) {
    const role = m.role === "user" ? "USER" : "AGENT";
    lines.push(`${role}: ${m.content}`);
  }
  lines.push("");
  lines.push("Entity catalog (use these exact pointer_keys, do not invent new ones):");
  lines.push(formatCatalog(catalog));
  lines.push("");
  lines.push(
    "Re-emit ONE corrected worldStateOp that captures the fact the talker was trying to record. If no fact in the catalog can be salvaged from this op, return op=null.",
  );

  return [
    {
      role: "system",
      content:
        "You are a memory-graph regeneration agent. Read the broken op and the conversation, then emit a single canonical worldStateOp using ONLY catalog pointer_keys. Prefer dropping (op=null) over inventing entities.",
    },
    { role: "user", content: lines.join("\n") },
  ];
}

export type WorldStateOpProcessorDeps = {
  pgFactory: { getPool: () => postgres.Sql } | null | undefined;
  modelProvider: Pick<MemoryTaskModelProvider, "chat"> | null | undefined;
  /** Returns the most recent N message exchanges for the session (oldest
   * first). Used by the regenerate stage. Receives the budget; may return
   * fewer. */
  loadRecentMessages?: (
    sessionId: string,
    limit: number,
  ) => Promise<ChatMessage[]>;
  triageModelId?: string;
  regenerateModelId?: string;
};

export type WorldStateOpProcessorContext = WorldStateOpResolveContext & {
  sessionId: string;
};

export type ProcessOpResult =
  | {
      ok: true;
      validated: WorldStateOpValidationOk;
      /** Records what we did so the applier can log it in one place. */
      path: "first_pass" | "fix_in_place" | "regenerate";
    }
  | {
      ok: false;
      reason: string;
      /** Surfaced for the caller to enqueue/dead-letter. May be the raw
       * input or a corrected-but-still-broken op. */
      lastAttempt: unknown;
      lastErrors: WorldStateOpValidationError[];
    };

/**
 * Build a per-op processor that runs validate → triage → (fix or regenerate)
 * → re-validate. Returns null when prerequisites are missing so callers
 * can fall back to the legacy direct-resolve-only path.
 */
export function createWorldStateOpProcessor(
  deps: WorldStateOpProcessorDeps,
): ((
  rawOp: unknown,
  ctx: WorldStateOpProcessorContext,
) => Promise<ProcessOpResult>) | null {
  if (!deps.pgFactory || !deps.modelProvider) return null;
  const pgFactory = deps.pgFactory;
  const modelProvider = deps.modelProvider;
  const triageModelId = deps.triageModelId ?? DEFAULT_TRIAGE_MODEL;
  const regenerateModelId =
    deps.regenerateModelId ?? DEFAULT_REGENERATE_MODEL;
  const loadRecentMessages = deps.loadRecentMessages;

  return async (rawOp, ctx): Promise<ProcessOpResult> => {
    const firstPass = await validateWorldStateOp(rawOp, ctx);
    if (firstPass.ok) {
      return { ok: true, validated: firstPass, path: "first_pass" };
    }

    const sql = pgFactory.getPool();
    const opAsString = JSON.stringify(rawOp ?? {});
    const catalog = await readCatalog(sql, ctx.agentId, opAsString).catch(
      () => [] as CatalogRow[],
    );

    const triage = await runTriage({
      modelProvider,
      modelId: triageModelId,
      rawOp,
      errors: firstPass.errors,
      catalog,
    });

    if (triage.kind === "drop") {
      return {
        ok: false,
        reason: `triage_drop: ${triage.reason}`,
        lastAttempt: rawOp,
        lastErrors: firstPass.errors,
      };
    }

    let candidate: unknown;
    let pathTag: "fix_in_place" | "regenerate";
    if (triage.kind === "fix_in_place") {
      candidate = triage.correctedOp;
      pathTag = "fix_in_place";
    } else {
      const recent = loadRecentMessages
        ? await loadRecentMessages(ctx.sessionId, RECENT_TURNS_FOR_REGEN * 2).catch(
            () => [] as ChatMessage[],
          )
        : [];
      candidate = await runRegenerate({
        modelProvider,
        modelId: regenerateModelId,
        rawOp,
        failureReason: triage.reason,
        recentMessages: recent,
        catalog,
      });
      pathTag = "regenerate";
    }

    if (!candidate) {
      return {
        ok: false,
        reason:
          pathTag === "regenerate"
            ? "regenerate_returned_null"
            : "fix_in_place_returned_null",
        lastAttempt: rawOp,
        lastErrors: firstPass.errors,
      };
    }

    const secondPass = await validateWorldStateOp(candidate, ctx);
    if (secondPass.ok) {
      return { ok: true, validated: secondPass, path: pathTag };
    }
    return {
      ok: false,
      reason: `second_validation_failed_after_${pathTag}`,
      lastAttempt: candidate,
      lastErrors: secondPass.errors,
    };
  };
}

async function runTriage(params: {
  modelProvider: Pick<MemoryTaskModelProvider, "chat">;
  modelId: string;
  rawOp: unknown;
  errors: readonly WorldStateOpValidationError[];
  catalog: readonly CatalogRow[];
}): Promise<TriageDecision> {
  const messages = buildTriagePrompt({
    rawOp: params.rawOp,
    errors: params.errors,
    catalog: params.catalog,
  });
  let calls;
  try {
    calls = await params.modelProvider.chat(messages, [TRIAGE_TOOL], {
      modelId: params.modelId,
    });
  } catch (err) {
    return {
      kind: "drop",
      reason: `triage_llm_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  for (const call of calls) {
    if (call.name !== TRIAGE_TOOL.name) continue;
    const decision = call.arguments.decision;
    const reason =
      typeof call.arguments.reason === "string"
        ? call.arguments.reason
        : "(no reason)";
    if (decision === "drop") return { kind: "drop", reason };
    if (decision === "regenerate") return { kind: "regenerate", reason };
    if (decision === "fix_in_place") {
      const corrected = call.arguments.correctedOp;
      if (!corrected || typeof corrected !== "object") {
        return {
          kind: "drop",
          reason: `triage_fix_missing_correctedOp: ${reason}`,
        };
      }
      return {
        kind: "fix_in_place",
        correctedOp: corrected as WorldStateOp,
        reason,
      };
    }
  }

  return { kind: "drop", reason: "triage_no_decision" };
}

async function runRegenerate(params: {
  modelProvider: Pick<MemoryTaskModelProvider, "chat">;
  modelId: string;
  rawOp: unknown;
  failureReason: string;
  recentMessages: readonly ChatMessage[];
  catalog: readonly CatalogRow[];
}): Promise<unknown> {
  const messages = buildRegeneratePrompt({
    rawOp: params.rawOp,
    failureReason: params.failureReason,
    recentMessages: params.recentMessages,
    catalog: params.catalog,
  });
  let calls;
  try {
    calls = await params.modelProvider.chat(messages, [REGENERATE_TOOL], {
      modelId: params.modelId,
    });
  } catch (err) {
    console.warn(
      `[world-state-triage] regenerate LLM failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  for (const call of calls) {
    if (call.name !== REGENERATE_TOOL.name) continue;
    const op = call.arguments.op;
    if (!op || typeof op !== "object") return null;
    return op;
  }
  return null;
}

export type WorldStateOpProcessor = (
  rawOp: unknown,
  ctx: WorldStateOpProcessorContext,
) => Promise<ProcessOpResult>;
