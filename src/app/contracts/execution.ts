import type { PrivateCommitSummary } from "./inspect.js";
import type { AppExecutionMode } from "./session.js";

type ToolLifecycleType =
  | "tool_use_start"
  | "tool_use_delta"
  | "tool_use_end"
  | "tool_execution_result"
  | "tool_call"
  | "tool_result";

export type ObservationEvent =
  | {
      type: "text_delta";
      timestamp?: number;
      text: string;
    }
  | {
      type: Extract<ToolLifecycleType, "tool_use_start" | "tool_call">;
      timestamp?: number;
      id?: string;
      tool?: string;
      input?: unknown;
    }
  | {
      type: "tool_use_delta";
      timestamp?: number;
      id?: string;
      input_delta?: string;
    }
  | {
      type: "tool_use_end";
      timestamp?: number;
      id?: string;
    }
  | {
      type: Extract<ToolLifecycleType, "tool_execution_result" | "tool_result">;
      timestamp?: number;
      id?: string;
      tool?: string;
      output?: unknown;
      is_error?: boolean;
    }
  | {
      type: "message_end";
      timestamp?: number;
      stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    }
  | {
      type: "error";
      timestamp?: number;
      code?: string;
      message: string;
      retriable?: boolean;
    };

export type TurnExecutionResult = {
  mode: AppExecutionMode;
  session_id: string;
  request_id: string;
  settlement_id?: string;
  assistant_text: string;
  has_public_reply: boolean;
  private_commit: PrivateCommitSummary;
  recovery_required: boolean;
  public_chunks: ObservationEvent[];
  tool_events: ObservationEvent[];
};
