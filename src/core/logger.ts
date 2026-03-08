// Log severity levels
export type LogLevel = "debug" | "info" | "warn" | "error";

// Structured log context fields — exactly what T5, T8, T10, T26, T28a will use
export type LogContext = {
  request_id?: string;
  session_id?: string;
  agent_id?: string;
  job_key?: string;
  provider?: string;
  tool_name?: string;
  [key: string]: unknown; // Allow extension but keep core fields typed
};

// A single structured log entry
export type LogEntry = {
  level: LogLevel;
  message: string;
  context: LogContext;
  timestamp: number; // Unix ms
  error?: {
    code: string;
    message: string;
    retriable: boolean;
    details?: unknown;
  };
};

// Logger interface — all calling code depends on this, not the concrete implementation
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: { code: string; message: string; retriable: boolean; details?: unknown }, context?: LogContext): void;
  child(baseContext: LogContext): Logger; // Create a child logger with pre-bound context
}

// Log level priority (higher = more severe)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Concrete implementation (but callers use Logger interface, NOT this class)
class StructuredLogger implements Logger {
  constructor(
    private readonly baseContext: LogContext,
    private readonly level: LogLevel,
    private readonly name: string
  ) {}

  child(ctx: LogContext): Logger {
    // Child loggers inherit parent context and MERGE it with per-call context
    // Child logger context DOES NOT leak to sibling or parent loggers
    return new StructuredLogger({ ...this.baseContext, ...ctx }, this.level, this.name);
  }

  private shouldEmit(level: LogLevel): boolean {
    // Log level filtering: only emit entries at or above the configured level
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private emit(level: LogLevel, message: string, extra?: Partial<LogEntry>): void {
    if (!this.shouldEmit(level)) return;
    
    // Merge contexts: parent context doesn't override per-call context
    const mergedContext: LogContext = { ...this.baseContext, ...extra?.context };
    
    // Destructure to exclude context from extra spread, since we've already merged it
    const { context: _, ...restExtra } = extra ?? {};
    
    const entry: LogEntry = {
      level,
      message,
      context: mergedContext,
      timestamp: Date.now(),
      ...restExtra,
    };
    
    // Emits JSON-serializable log entries to stdout (via console.log is OK in the logger itself)
    console.log(JSON.stringify(entry));
  }

  debug(message: string, context?: LogContext): void {
    this.emit("debug", message, { context });
  }

  info(message: string, context?: LogContext): void {
    this.emit("info", message, { context });
  }

  warn(message: string, context?: LogContext): void {
    this.emit("warn", message, { context });
  }

  error(
    message: string, 
    error?: { code: string; message: string; retriable: boolean; details?: unknown }, 
    context?: LogContext
  ): void {
    // Error logging preserves code, message, and retriable status from the error object
    this.emit("error", message, { 
      context,
      error: error ? {
        code: error.code,
        message: error.message,
        retriable: error.retriable,
        details: error.details,
      } : undefined,
    });
  }
}

// Create the root logger
export function createLogger(options?: { level?: LogLevel; name?: string }): Logger {
  // Default level: "info"
  const level = options?.level ?? "info";
  const name = options?.name ?? "root";
  
  return new StructuredLogger({}, level, name);
}
