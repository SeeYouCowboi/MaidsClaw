import {
  isValidFactEdgePredicate,
  type WorldStateOp,
} from "../runtime/rp-turn-contract.js";

/**
 * Handwritten validator for {@link WorldStateOp} payloads emitted by the
 * talker. Combines schema-shape checks (predicate enum, factText non-empty,
 * subject/object kind discriminator) with synchronous entity resolution so
 * "the predicate is malformed" and "the pointer_key didn't resolve" surface
 * as the same kind of `ValidationError`. The triage pipeline downstream
 * uses the error codes to decide between in-place repair and full
 * regeneration without re-walking the op.
 *
 * The validator does NOT call any LLM. All async work goes through the
 * caller-supplied `resolvePointerKey` / `ensureSyntheticAgent` callbacks
 * so callers can layer alias-aware resolution (alias_repo → entity_nodes
 * fallback → hardcoded `self:` rewrites) without polluting the validator
 * with infrastructure dependencies.
 */
export type WorldStateOpValidationErrorCode =
  | "missing_field"
  | "empty_string"
  | "wrong_type"
  | "invalid_predicate"
  | "invalid_visibility"
  | "invalid_subject_kind"
  | "invalid_object_kind"
  | "invalid_special_value"
  | "unresolved_pointer";

export type WorldStateOpValidationError = {
  path: string;
  code: WorldStateOpValidationErrorCode;
  message: string;
};

export type WorldStateOpValidationOk = {
  ok: true;
  op: WorldStateOp;
  subjectEntityId: number;
  objectEntityId: number;
};

export type WorldStateOpValidationFail = {
  ok: false;
  errors: WorldStateOpValidationError[];
  /** The raw input echoed back so callers can pass it to triage without
   * re-marshaling. May be partial / malformed. */
  raw: unknown;
};

export type WorldStateOpValidationResult =
  | WorldStateOpValidationOk
  | WorldStateOpValidationFail;

export type WorldStateOpResolveContext = {
  agentId: string;
  viewerSnapshot?: {
    selfPointerKey?: string;
    userPointerKey?: string;
    currentLocationEntityId?: number;
  };
  /** Returns entity_nodes.id, or null if no row matches even after alias /
   * lower-case fallback. Implementations should layer
   * `aliasRepo.resolveAlias` on top of the direct pointer_key lookup. */
  resolvePointerKey: (
    pointerKey: string,
    agentId: string,
  ) => Promise<number | null>;
  /** Returns the synthetic `__agent__:<id>` entity, creating it on first
   * call. Used when the talker's `subject/object.value === "self"` (the
   * `special:self` path) cannot be resolved via viewerSnapshot.selfPointerKey. */
  ensureSyntheticAgent: (agentId: string) => Promise<number>;
};

const VALID_VISIBILITY = new Set(["shared_public", "private_overlay"]);
const VALID_SPECIAL = new Set(["self", "user", "current_location"]);

export async function validateWorldStateOp(
  rawOp: unknown,
  ctx: WorldStateOpResolveContext,
): Promise<WorldStateOpValidationResult> {
  const errors: WorldStateOpValidationError[] = [];

  if (!rawOp || typeof rawOp !== "object") {
    return {
      ok: false,
      errors: [
        {
          path: "$",
          code: "wrong_type",
          message: "worldStateOp must be a non-null object",
        },
      ],
      raw: rawOp,
    };
  }

  const op = rawOp as Partial<WorldStateOp> & Record<string, unknown>;

  // Predicate
  if (typeof op.predicate !== "string" || op.predicate.length === 0) {
    errors.push({
      path: "predicate",
      code: "missing_field",
      message: "predicate must be a non-empty string",
    });
  } else if (!isValidFactEdgePredicate(op.predicate)) {
    errors.push({
      path: "predicate",
      code: "invalid_predicate",
      message: `predicate "${op.predicate}" is not in the fact_edge enum`,
    });
  }

  // factText
  if (typeof op.factText !== "string") {
    errors.push({
      path: "factText",
      code: "missing_field",
      message: "factText must be a string",
    });
  } else if (op.factText.trim().length === 0) {
    errors.push({
      path: "factText",
      code: "empty_string",
      message: "factText must not be empty after trimming",
    });
  }

  // visibility (optional)
  if (op.visibility !== undefined && typeof op.visibility !== "string") {
    errors.push({
      path: "visibility",
      code: "wrong_type",
      message: "visibility must be a string when present",
    });
  } else if (
    typeof op.visibility === "string" &&
    !VALID_VISIBILITY.has(op.visibility)
  ) {
    errors.push({
      path: "visibility",
      code: "invalid_visibility",
      message: `visibility "${op.visibility}" must be 'shared_public' or 'private_overlay'`,
    });
  }

  const subjectResult = await validateAndResolveRef(op.subject, "subject", ctx);
  const objectResult = await validateAndResolveRef(op.object, "object", ctx);

  if (!subjectResult.ok) errors.push(...subjectResult.errors);
  if (!objectResult.ok) errors.push(...objectResult.errors);

  if (errors.length > 0 || !subjectResult.ok || !objectResult.ok) {
    return { ok: false, errors, raw: rawOp };
  }

  return {
    ok: true,
    op: rawOp as WorldStateOp,
    subjectEntityId: subjectResult.entityId,
    objectEntityId: objectResult.entityId,
  };
}

async function validateAndResolveRef(
  ref: unknown,
  endpoint: "subject" | "object",
  ctx: WorldStateOpResolveContext,
): Promise<
  | { ok: true; entityId: number }
  | { ok: false; errors: WorldStateOpValidationError[] }
> {
  const errors: WorldStateOpValidationError[] = [];

  if (!ref || typeof ref !== "object") {
    errors.push({
      path: endpoint,
      code: "missing_field",
      message: `${endpoint} must be an object with kind+value fields`,
    });
    return { ok: false, errors };
  }

  const r = ref as { kind?: unknown; value?: unknown };

  if (r.kind !== "pointer_key" && r.kind !== "special") {
    errors.push({
      path: `${endpoint}.kind`,
      code: endpoint === "subject" ? "invalid_subject_kind" : "invalid_object_kind",
      message: `${endpoint}.kind must be 'pointer_key' or 'special', got ${JSON.stringify(r.kind)}`,
    });
    return { ok: false, errors };
  }

  if (typeof r.value !== "string" || r.value.length === 0) {
    errors.push({
      path: `${endpoint}.value`,
      code: "missing_field",
      message: `${endpoint}.value must be a non-empty string`,
    });
    return { ok: false, errors };
  }

  if (r.kind === "pointer_key") {
    const pk = r.value.normalize("NFC");
    const id = await ctx.resolvePointerKey(pk, ctx.agentId);
    if (id !== null) return { ok: true, entityId: id };
    errors.push({
      path: `${endpoint}.value`,
      code: "unresolved_pointer",
      message: `pointer_key "${pk}" not found in entity_nodes catalog (after alias fallback)`,
    });
    return { ok: false, errors };
  }

  // r.kind === "special"
  if (!VALID_SPECIAL.has(r.value)) {
    errors.push({
      path: `${endpoint}.value`,
      code: "invalid_special_value",
      message: `special.value must be one of ${[...VALID_SPECIAL].join(", ")}, got '${r.value}'`,
    });
    return { ok: false, errors };
  }

  if (r.value === "self") {
    const selfPk = ctx.viewerSnapshot?.selfPointerKey;
    if (selfPk) {
      const id = await ctx.resolvePointerKey(selfPk, ctx.agentId);
      if (id !== null) return { ok: true, entityId: id };
    }
    const synthetic = await ctx.ensureSyntheticAgent(ctx.agentId);
    return { ok: true, entityId: synthetic };
  }

  if (r.value === "user") {
    const userPk = ctx.viewerSnapshot?.userPointerKey;
    if (!userPk) {
      errors.push({
        path: `${endpoint}.value`,
        code: "unresolved_pointer",
        message:
          "special:user requested but viewerSnapshot.userPointerKey is missing",
      });
      return { ok: false, errors };
    }
    const id = await ctx.resolvePointerKey(userPk, ctx.agentId);
    if (id === null) {
      errors.push({
        path: `${endpoint}.value`,
        code: "unresolved_pointer",
        message: `special:user pointer_key "${userPk}" not found in catalog`,
      });
      return { ok: false, errors };
    }
    return { ok: true, entityId: id };
  }

  // r.value === "current_location"
  const locId = ctx.viewerSnapshot?.currentLocationEntityId;
  if (typeof locId !== "number") {
    errors.push({
      path: `${endpoint}.value`,
      code: "unresolved_pointer",
      message:
        "special:current_location requires viewerSnapshot.currentLocationEntityId",
    });
    return { ok: false, errors };
  }
  return { ok: true, entityId: locId };
}

/** Concise text summary of all validation errors, for LLM prompts. */
export function summarizeValidationErrors(
  errors: readonly WorldStateOpValidationError[],
): string {
  if (errors.length === 0) return "(no errors)";
  return errors
    .map((e) => `  • [${e.code}] ${e.path}: ${e.message}`)
    .join("\n");
}
