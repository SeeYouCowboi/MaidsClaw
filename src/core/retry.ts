import type { ErrorCode } from "./errors.js";
import { MaidsClawError, wrapError, RETRIABLE_CODES } from "./errors.js";

export type RetryPolicy = {
  maxAttempts: number;         // Total attempts (1 = no retry, 2 = one retry, etc.)
  backoffMs: number;           // Initial backoff in ms
  backoffMultiplier: number;   // Multiplier per retry (1.0 = constant, 2.0 = exponential)
  maxBackoffMs: number;        // Cap on backoff
  shouldRetry?: (error: MaidsClawError, attempt: number) => boolean;
};

// Pre-built policies for common use cases
export const MODEL_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,            // 1 retry for model errors
  backoffMs: 1000,
  backoffMultiplier: 2.0,
  maxBackoffMs: 5000,
  shouldRetry: (err) => err.retriable && RETRIABLE_CODES.has(err.code),
};

export const MCP_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  backoffMs: 500,
  backoffMultiplier: 2.0,
  maxBackoffMs: 3000,
  shouldRetry: (err) => err.retriable && err.code === "MCP_DISCONNECTED",
};

export const MEMORY_ORGANIZE_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,            // Up to 3 retries
  backoffMs: 2000,
  backoffMultiplier: 2.0,
  maxBackoffMs: 30000,
};

export const NO_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  backoffMs: 0,
  backoffMultiplier: 1.0,
  maxBackoffMs: 0,
};

// Execute a function with retry policy
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  onRetry?: (error: MaidsClawError, attempt: number, delayMs: number) => void
): Promise<T> {
  let lastError: MaidsClawError;
  
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (thrown) {
      // Wrap the error into a MaidsClawError
      lastError = wrapError(thrown);
      
      // Determine if we should retry
      const shouldRetry = policy.shouldRetry
        ? policy.shouldRetry(lastError, attempt)
        : lastError.retriable && RETRIABLE_CODES.has(lastError.code);
      
      // If we shouldn't retry, throw immediately
      if (!shouldRetry) {
        throw lastError;
      }
      
      // If this was the last attempt, throw the error
      if (attempt >= policy.maxAttempts) {
        throw lastError;
      }
      
      // Calculate backoff delay
      const delayMs = Math.min(
        policy.backoffMs * Math.pow(policy.backoffMultiplier, attempt - 1),
        policy.maxBackoffMs
      );
      
      // Call onRetry callback if provided
      if (onRetry) {
        onRetry(lastError, attempt, delayMs);
      }
      
      // Wait before retrying
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  
  // This should never be reached, but TypeScript needs it
  throw lastError!;
}
