export const GATEWAY_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "UNSUPPORTED_RUNTIME_MODE",
  "AUDIT_WRITE_FAILED",
  "PERSONA_IN_USE",
  "JOB_NOT_FOUND",
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

// All V1 error codes — exhaustive list
export type ErrorCode =
  // Gateway errors
  | GatewayErrorCode
  // Model/LLM errors
  | "MODEL_TIMEOUT"
  | "MODEL_RATE_LIMIT"
  | "MODEL_NOT_CONFIGURED"
  | "MODEL_API_ERROR"
  | "INPUT_TOO_LARGE"
  | "CONTEXT_BUDGET_INVALID"
  // MCP errors
  | "MCP_DISCONNECTED"
  | "MCP_TOOL_ERROR"
  | "MCP_SCHEMA_LOAD_FAILED"
  // Storage errors
  | "STORAGE_ERROR"
  | "MIGRATION_FAILED"
  // Agent/runtime errors
  | "AGENT_NOT_FOUND"
  | "AGENT_ALREADY_REGISTERED"
  | "DELEGATION_DEPTH_EXCEEDED"
  | "CIRCULAR_DELEGATION"
  | "TOOL_PERMISSION_DENIED"
  | "AGENT_OWNERSHIP_MISMATCH"
  | "TOOL_ARGUMENT_INVALID"
  | "TASK_OUTPUT_INVALID"
  // Config errors (note: CONFIG_ERROR defined in config-schema.ts is separate)
  | "CONFIG_MISSING_CREDENTIAL"
  | "PERSONA_CARD_INVALID"
  | "PERSONA_LOAD_FAILED"
  // Job errors
  | "JOB_FAILED"
  | "JOB_TIMEOUT"
  // Generic
  // Blackboard errors
  | "BLACKBOARD_INVALID_NAMESPACE"
  | "BLACKBOARD_NAMESPACE_RESERVED"
  | "BLACKBOARD_OWNERSHIP_VIOLATION"
  | "INTERNAL_ERROR"
  | "SETTLEMENT_UOW_REQUIRED"
  | "PROMPT_TEMPLATE_ERROR"
  | "PROMPT_BUILDER_DATA_SOURCE_ERROR"
  // Interaction log errors
  | "INTERACTION_DUPLICATE_RECORD"
  | "INTERACTION_INVALID_FIELD"
  | "REQUEST_ID_AMBIGUOUS"
  // RP runtime errors
  | "RP_TURN_OUTCOME_INVALID"
  | "COGNITION_OP_UNSUPPORTED"
  | "COGNITION_UNRESOLVED_REFS"
  | "COGNITION_ILLEGAL_STANCE_TRANSITION"
  | "COGNITION_ILLEGAL_BASIS_DOWNGRADE"
  | "COGNITION_TERMINAL_KEY_REUSE"
  | "COGNITION_MISSING_PRE_CONTESTED_STANCE"
  | "COGNITION_DOUBLE_RETRACT"
  | "WRITE_TEMPLATE_DENIED"
  | "ARTIFACT_CONTRACT_DENIED"
  // Session errors
  | "SESSION_NOT_FOUND"
  | "SESSION_CLOSED"
  | "SESSION_NOT_IN_RECOVERY"
  | "INVALID_ACTION"
  | "UNKNOWN_ERROR";

// The canonical runtime error type used throughout MaidsClaw
export class MaidsClawError extends Error {
  readonly code: ErrorCode;
  readonly retriable: boolean;
  readonly details?: unknown;

  constructor(options: {
    code: ErrorCode;
    message: string;
    retriable: boolean;
    details?: unknown;
  }) {
    super(options.message);
    this.name = "MaidsClawError";
    this.code = options.code;
    this.retriable = options.retriable;
    this.details = options.details;
  }

  // Serialize to the Gateway error envelope shape
  toGatewayShape(): {
    error: { code: string; message: string; retriable: boolean; details?: unknown };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        retriable: this.retriable,
        details: this.details,
      },
    };
  }
}

// Wrap any unknown thrown value into a stable MaidsClawError
export function wrapError(
  thrown: unknown,
  context?: { code?: ErrorCode; retriable?: boolean }
): MaidsClawError {
  // If already a MaidsClawError, return as-is
  if (thrown instanceof MaidsClawError) {
    return thrown;
  }

  // If it's a plain Error, wrap as INTERNAL_ERROR
  if (thrown instanceof Error) {
    return new MaidsClawError({
      code: context?.code ?? "INTERNAL_ERROR",
      message: thrown.message,
      retriable: context?.retriable ?? false,
      details: { originalError: thrown },
    });
  }

  // For anything else (string, object, null, etc.), wrap as UNKNOWN_ERROR
  return new MaidsClawError({
    code: "UNKNOWN_ERROR",
    message: typeof thrown === "string" ? thrown : String(thrown),
    retriable: false,
    details: { originalValue: thrown },
  });
}

// Type guard
export function isMaidsClawError(err: unknown): err is MaidsClawError {
  return err instanceof MaidsClawError;
}

// Retriable error codes (for retry policy decisions)
export const RETRIABLE_CODES = new Set<ErrorCode>([
  "MODEL_TIMEOUT",
  "MODEL_RATE_LIMIT",
  "MODEL_API_ERROR",
  "MCP_DISCONNECTED",
  "STORAGE_ERROR",
  "JOB_TIMEOUT",
]);
