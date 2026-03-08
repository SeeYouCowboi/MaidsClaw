/**
 * MaidsClaw Agent Engine
 * TypeScript + Bun runtime with Rust native modules
 * 
 * This is the main entry point for the agent engine.
 * Currently a scaffold - subsystems will be added in subsequent tasks.
 */

export const VERSION = "0.1.0";

export function version(): string {
  return VERSION;
}

// Module exports will be added as subsystems are implemented
export {};
